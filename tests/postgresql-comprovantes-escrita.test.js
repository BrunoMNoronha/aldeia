'use strict';

// Escrita de comprovante em PostgreSQL (ADR-003 / PG-2B2) — M-04, F-05, F-11, T-07.
//
// Espelha a parte de GRAVACAO de `tests/comprovantes.test.js` e acrescenta o que
// so existe no PostgreSQL: concorrencia real entre duas conexoes e rollback de
// transacao provado contra o banco.
//
// Isolamento: schema dedicado criado e derrubado pelo proprio teste. Somente
// `TEST_DATABASE_URL` habilita a suite; `DATABASE_URL` nunca e usada como
// fallback. Sem banco de teste seguro, os testes sao PULADOS visivelmente.
//
// Como o ledger PostgreSQL ainda nao foi migrado, as linhas de `associado` e
// `movimento_financeiro` sao preparadas direto no banco. Nenhuma implementacao
// SQLite escreve aqui. Fixtures ficticias e minimas.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  definirComprovanteDoMovimento,
  obterComprovanteDoMovimento,
  ComprovanteError,
  ALTERACAO,
  ACAO_COMPROVANTE_REGISTRADO,
  ACAO_COMPROVANTE_ALTERADO,
  SEM_REGISTRO,
} = require('../src/services/comprovantes-postgresql');
const { runMigrations } = require('../src/db/postgresql/migrator');
const { ID_MAXIMO_INT4 } = require('../src/db/postgresql/tipos');
const { motivoSkip, schemaIsolado } = require('./helpers/postgres');

const skip = motivoSkip();

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const OBSERVACAO = 'Comprovante solicitado ao associado.';

async function schemaMigrado(t) {
  const ctx = await schemaIsolado(t);
  await runMigrations(ctx.pool);
  return ctx;
}

async function criarMovimento(pool, { data = '2026-01-10', valorCentavos = 15000, ativo = true } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO movimento_financeiro
       (data, valor_centavos, tipo, origem, estado_identificacao, ativo, inativado_em, motivo_inativacao)
     VALUES ($1, $2, 'credito', 'pagamento', 'nao_identificado', $3, $4, $5)
     RETURNING id`,
    [
      data,
      valorCentavos,
      ativo,
      // M-09: inativar exige QUANDO e POR QUE — o banco recusa sem os dois.
      ativo ? null : new Date('2026-02-01T00:00:00Z'),
      ativo ? null : 'lancamento duplicado',
    ]
  );
  return rows[0].id;
}

async function contar(pool, tabela) {
  const { rows } = await pool.query(`SELECT COUNT(*) AS total FROM ${tabela}`);
  return Number(rows[0].total);
}

/** Linha crua de `comprovante`, para afirmar sobre o que o BANCO guardou. */
async function lerComprovante(pool, id) {
  const { rows } = await pool.query('SELECT * FROM comprovante WHERE id = $1', [id]);
  return rows[0];
}

async function lerAuditorias(pool) {
  const { rows } = await pool.query('SELECT * FROM audit_log ORDER BY id ASC');
  return rows;
}

/**
 * Trava a linha do movimento como um writer concorrente travaria.
 *
 * `FOR NO KEY UPDATE`, e nao `FOR UPDATE`, e o que torna estes testes capazes
 * de DETECTAR a ausencia do lock no service:
 *   - conflita com o `FOR UPDATE` que o service adquire  -> a escrita espera;
 *   - NAO conflita com o `FOR KEY SHARE` que o INSERT de `comprovante` toma
 *     sozinho por causa da chave estrangeira para `movimento_financeiro`.
 *
 * Com `FOR UPDATE` aqui, qualquer implementacao pareceria serializada — ate uma
 * sem lock nenhum, porque o lock da FK ja bastaria para bloquear. O teste
 * confirmaria uma garantia que o codigo nao da.
 */
const SQL_SEGURAR_MOVIMENTO = 'SELECT id FROM movimento_financeiro WHERE id = $1 FOR NO KEY UPDATE';

/**
 * Espera ate que `quantidade` sessoes estejam de fato BLOQUEADAS esperando lock.
 *
 * Pergunta ao proprio PostgreSQL (`pg_stat_activity`) em vez de dormir um tempo
 * arbitrario: a corrida so e disparada quando as duas chamadas realmente estao
 * na fila do lock.
 */
async function esperarBloqueadas(pool, quantidade, tentativas = 100) {
  for (let i = 0; i < tentativas; i += 1) {
    const { rows } = await pool.query(
      `SELECT COUNT(*) AS total
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND pid <> pg_backend_pid()`
    );
    if (Number(rows[0].total) >= quantidade) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`as ${quantidade} chamadas nao ficaram bloqueadas esperando o lock`);
}

/**
 * Faz TODO INSERT em `audit_log` falhar — somente neste schema de teste.
 *
 * A falha e induzida por trigger criada aqui, nunca por mudanca na migration
 * oficial: fabricar o cenario alterando o schema versionado seria mudar o
 * produto para caber no teste.
 */
async function quebrarAuditoria(pool) {
  await pool.query(`
    CREATE FUNCTION falhar_auditoria() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'auditoria indisponivel (falha induzida pelo teste)';
      END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER tg_falhar_auditoria
      BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION falhar_auditoria();
  `);
}

// =============================================================================
// Criacao
// =============================================================================

test('PG W1: movimento sem registro passa a ter comprovante (registrado)', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool);

  const evidencia = await definirComprovanteDoMovimento(pool, {
    movimentoId,
    estado: 'pendente',
    observacao: OBSERVACAO,
  });

  assert.equal(evidencia.alteracao, ALTERACAO.registrado);
  assert.equal(evidencia.registrado, true);
  assert.equal(evidencia.estado, 'pendente');
  assert.equal(evidencia.estadoTecnico, 'pendente');
  assert.equal(evidencia.pendenteDeEvidencia, true);
  assert.equal(evidencia.observacao, OBSERVACAO);
  assert.equal(evidencia.movimentoId, movimentoId);
  assert.match(evidencia.registro.criadoEm, TIMESTAMP_RE, 'timestamp publico e texto UTC por segundo');
  assert.match(evidencia.registro.atualizadoEm, TIMESTAMP_RE);
  assert.equal(evidencia.registro.referenciaExterna, null, 'C-06 segue TO CONFIRM');
  assert.equal(evidencia.registro.data, null);

  assert.equal(await contar(pool, 'comprovante'), 1, 'exatamente uma linha');

  // Releitura pura devolve o mesmo fato, agora sem `alteracao`.
  const relido = await obterComprovanteDoMovimento(pool, movimentoId);
  assert.equal(relido.estado, 'pendente');
  assert.equal(relido.registro.id, evidencia.registro.id);
});

test('PG W2: a criacao deixa exatamente uma entrada de auditoria', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool);

  const evidencia = await definirComprovanteDoMovimento(pool, {
    movimentoId,
    estado: 'pendente',
    observacao: OBSERVACAO,
    ator: 'operador-teste',
  });

  const auditorias = await lerAuditorias(pool);
  assert.equal(auditorias.length, 1);

  const [registro] = auditorias;
  assert.equal(registro.ator, 'operador-teste');
  assert.equal(registro.acao, ACAO_COMPROVANTE_REGISTRADO);
  assert.equal(registro.entidade_tipo, 'comprovante');
  assert.equal(registro.entidade_id, String(evidencia.registro.id), 'entidade_id e TEXT no schema');
  assert.equal(registro.estado_anterior, null, 'nao havia linha antes');

  const posterior = JSON.parse(registro.estado_posterior);
  assert.equal(posterior.estado, 'pendente');
  assert.equal(posterior.observacao, OBSERVACAO);
  assert.equal(posterior.movimentoId, movimentoId);

  const metadados = JSON.parse(registro.metadados);
  assert.deepEqual(metadados, {
    origemRegistro: 'manual',
    movimentoId,
    // Ausencia de registro NAO e 'ausente': a trilha diz isso com todas as letras.
    estadoAnterior: SEM_REGISTRO,
    estadoNovo: 'pendente',
    observacao: OBSERVACAO,
  });
});

// =============================================================================
// Idempotencia
// =============================================================================

test('PG W3: reenvio identico e sem_mudanca — nao escreve e nao audita', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool);

  const primeira = await definirComprovanteDoMovimento(pool, {
    movimentoId,
    estado: 'pendente',
    observacao: OBSERVACAO,
  });
  const antes = await lerComprovante(pool, primeira.registro.id);

  // Mesmo estado, mesma observacao — inclusive com espacos, que a normalizacao
  // remove ANTES da decisao de idempotencia (igual a trilha SQLite).
  const segunda = await definirComprovanteDoMovimento(pool, {
    movimentoId,
    estado: '  PENDENTE  ',
    observacao: `   ${OBSERVACAO}   `,
  });
  const depois = await lerComprovante(pool, primeira.registro.id);

  assert.equal(segunda.alteracao, ALTERACAO.semMudanca);
  assert.equal(segunda.registro.id, primeira.registro.id, 'mesma linha');
  assert.equal(await contar(pool, 'comprovante'), 1);
  assert.equal((await lerAuditorias(pool)).length, 1, 'nenhuma auditoria extra');

  // O timestamp e comparado no valor CRU do banco, nao no truncado do contrato:
  // truncar para segundo poderia esconder um UPDATE ocorrido no mesmo segundo.
  assert.equal(
    depois.atualizado_em.getTime(),
    antes.atualizado_em.getTime(),
    'atualizado_em nao se move sem mudanca real'
  );
  assert.equal(depois.criado_em.getTime(), antes.criado_em.getTime());
});

// =============================================================================
// Alteracao
// =============================================================================

test('PG W4: mudanca so de estado e alterada e auditada', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool);

  const criada = await definirComprovanteDoMovimento(pool, {
    movimentoId,
    estado: 'pendente',
    observacao: OBSERVACAO,
  });
  const alterada = await definirComprovanteDoMovimento(pool, {
    movimentoId,
    estado: 'presente',
    observacao: OBSERVACAO,
  });

  assert.equal(alterada.alteracao, ALTERACAO.alterado);
  assert.equal(alterada.estado, 'presente');
  assert.equal(alterada.pendenteDeEvidencia, false);
  assert.equal(alterada.registro.id, criada.registro.id, 'a MESMA linha e alterada');
  assert.equal(await contar(pool, 'comprovante'), 1);

  const auditorias = await lerAuditorias(pool);
  assert.equal(auditorias.length, 2, 'uma entrada por mudanca real');

  const ultima = auditorias[1];
  assert.equal(ultima.acao, ACAO_COMPROVANTE_ALTERADO);
  assert.equal(JSON.parse(ultima.estado_anterior).estado, 'pendente');
  assert.equal(JSON.parse(ultima.estado_posterior).estado, 'presente');

  const metadados = JSON.parse(ultima.metadados);
  assert.equal(metadados.estadoAnterior, 'pendente');
  assert.equal(metadados.estadoNovo, 'presente');
  assert.equal(metadados.criterio, 'estado informado explicitamente pelo operador');
});

test('PG W5: mudanca so de observacao tambem e alteracao', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool);

  await definirComprovanteDoMovimento(pool, { movimentoId, estado: 'pendente', observacao: OBSERVACAO });
  const alterada = await definirComprovanteDoMovimento(pool, {
    movimentoId,
    estado: 'pendente',
    observacao: 'Associado avisou que envia amanha.',
  });

  assert.equal(alterada.alteracao, ALTERACAO.alterado);
  assert.equal(alterada.estado, 'pendente', 'a observacao nao mexe no estado');
  assert.equal(alterada.observacao, 'Associado avisou que envia amanha.');
  assert.equal((await lerAuditorias(pool)).length, 2);
});

test('PG W6: estado e observacao mudando juntos e uma unica alteracao', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool);

  await definirComprovanteDoMovimento(pool, { movimentoId, estado: 'pendente', observacao: OBSERVACAO });
  const alterada = await definirComprovanteDoMovimento(pool, {
    movimentoId,
    estado: 'nao_aplicavel',
    observacao: 'Movimento nao exige comprovante.',
  });

  assert.equal(alterada.alteracao, ALTERACAO.alterado);
  assert.equal(alterada.estado, 'nao_aplicavel');
  assert.equal(alterada.pendenteDeEvidencia, false);
  assert.equal((await lerAuditorias(pool)).length, 2, 'uma auditoria, nao duas');
});

test('PG W7: referencia_externa e data preexistentes sobrevivem ao UPDATE', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool);

  // Preenchidas fora do service: nesta fase nada as escreve (C-06 TO CONFIRM),
  // mas o UPDATE nao pode apaga-las se um dia elas existirem.
  const { rows } = await pool.query(
    `INSERT INTO comprovante (movimento_id, estado, observacao, referencia_externa, data)
     VALUES ($1, 'pendente', $2, 'recibo-2026-001.pdf', '2026-01-05')
     RETURNING id, criado_em`,
    [movimentoId, OBSERVACAO]
  );
  const { id, criado_em: criadoEmAntes } = rows[0];

  const alterada = await definirComprovanteDoMovimento(pool, {
    movimentoId,
    estado: 'presente',
    observacao: 'Recebido por e-mail.',
  });

  assert.equal(alterada.alteracao, ALTERACAO.alterado);
  assert.equal(alterada.registro.referenciaExterna, 'recibo-2026-001.pdf');
  assert.equal(alterada.registro.data, '2026-01-05', 'data civil nao vira instante (M-10)');

  const linha = await lerComprovante(pool, id);
  assert.equal(linha.referencia_externa, 'recibo-2026-001.pdf');
  assert.equal(linha.data, '2026-01-05');
  assert.equal(linha.movimento_id, movimentoId, 'evidencia nunca muda de movimento');
  assert.equal(linha.criado_em.getTime(), criadoEmAntes.getTime(), 'criado_em nao e reescrito');
  assert.ok(linha.atualizado_em.getTime() >= criadoEmAntes.getTime());
});

// =============================================================================
// Recusas — nenhuma escrita
// =============================================================================

test('PG W8: movimento inexistente nao cria comprovante nem auditoria', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  await assert.rejects(
    () => definirComprovanteDoMovimento(pool, { movimentoId: 9999, estado: 'pendente' }),
    (erro) => {
      assert.ok(erro instanceof ComprovanteError);
      assert.equal(erro.codigo, 'movimento_inexistente');
      return true;
    }
  );

  assert.equal(await contar(pool, 'comprovante'), 0);
  assert.equal(await contar(pool, 'audit_log'), 0);
});

test('PG W9: entrada invalida recusa com o mesmo codigo do SQLite, sem escrever', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool);

  const casos = [
    [{ movimentoId: 0, estado: 'pendente' }, 'id_invalido'],
    [{ movimentoId: -1, estado: 'pendente' }, 'id_invalido'],
    [{ movimentoId: 1.5, estado: 'pendente' }, 'id_invalido'],
    [{ movimentoId: '1', estado: 'pendente' }, 'id_invalido'],
    [{ movimentoId, estado: 'OK' }, 'estado_comprovante_invalido'],
    [{ movimentoId, estado: 'nao aplicavel' }, 'estado_comprovante_invalido'],
    // Estado TECNICO nao pode ser gravado como estado de dominio.
    [{ movimentoId, estado: SEM_REGISTRO }, 'estado_comprovante_invalido'],
    [{ movimentoId, estado: null }, 'estado_comprovante_invalido'],
    [{ movimentoId, estado: 'pendente', observacao: 42 }, 'campo_invalido'],
    [{ movimentoId, estado: 'pendente', ator: 42 }, 'campo_invalido'],
  ];

  for (const [entrada, codigo] of casos) {
    await assert.rejects(
      () => definirComprovanteDoMovimento(pool, entrada),
      (erro) => {
        assert.ok(erro instanceof ComprovanteError, `${JSON.stringify(entrada)} deve ser ComprovanteError`);
        assert.equal(erro.codigo, codigo, `codigo errado para ${JSON.stringify(entrada)}`);
        return true;
      }
    );
  }

  assert.equal(await contar(pool, 'comprovante'), 0, 'recusa nao escreve');
  assert.equal(await contar(pool, 'audit_log'), 0);
});

test('PG W10: movimento inativado recebe e altera evidencia sem ser reativado', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool, { ativo: false });

  const criada = await definirComprovanteDoMovimento(pool, { movimentoId, estado: 'ausente' });
  assert.equal(criada.alteracao, ALTERACAO.registrado);

  const alterada = await definirComprovanteDoMovimento(pool, { movimentoId, estado: 'presente' });
  assert.equal(alterada.alteracao, ALTERACAO.alterado);

  // M-09: a evidencia continua valendo para o historico e o movimento continua
  // inativado — gravar comprovante nao reativa nada.
  const { rows } = await pool.query(
    'SELECT ativo, motivo_inativacao FROM movimento_financeiro WHERE id = $1',
    [movimentoId]
  );
  assert.equal(rows[0].ativo, false);
  assert.equal(rows[0].motivo_inativacao, 'lancamento duplicado');
});

test('PG W15: id acima do teto do int4 nao vaza erro do PostgreSQL', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  await assert.rejects(
    () => definirComprovanteDoMovimento(pool, { movimentoId: ID_MAXIMO_INT4 + 1, estado: 'pendente' }),
    (erro) => {
      assert.ok(erro instanceof ComprovanteError, 'nao pode ser erro cru do driver');
      assert.equal(erro.codigo, 'movimento_inexistente');
      assert.equal(erro.code, undefined, 'nao carrega 22003 do PostgreSQL');
      return true;
    }
  );

  assert.equal(await contar(pool, 'comprovante'), 0);
  assert.equal(await contar(pool, 'audit_log'), 0);
});

// =============================================================================
// Atomicidade (T-07) — rollback real do PostgreSQL
// =============================================================================

test('PG W11: falha da auditoria desfaz a CRIACAO do comprovante', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool);
  await quebrarAuditoria(pool);

  await assert.rejects(
    () => definirComprovanteDoMovimento(pool, { movimentoId, estado: 'pendente', observacao: OBSERVACAO }),
    /auditoria indisponivel/
  );

  // Consultado direto no banco, ja fora da transacao: o ROLLBACK e do
  // PostgreSQL, nao uma compensacao feita por outro UPDATE.
  assert.equal(await contar(pool, 'comprovante'), 0, 'nao existe evidencia sem trilha');
  assert.equal(await contar(pool, 'audit_log'), 0);

  const evidencia = await obterComprovanteDoMovimento(pool, movimentoId);
  assert.equal(evidencia.registrado, false);
  assert.equal(evidencia.estadoTecnico, SEM_REGISTRO);
});

test('PG W12: falha da auditoria desfaz a ALTERACAO e preserva o estado anterior', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool);

  const criada = await definirComprovanteDoMovimento(pool, {
    movimentoId,
    estado: 'pendente',
    observacao: OBSERVACAO,
  });
  const antes = await lerComprovante(pool, criada.registro.id);

  await quebrarAuditoria(pool);

  await assert.rejects(
    () => definirComprovanteDoMovimento(pool, { movimentoId, estado: 'presente', observacao: 'Recebido.' }),
    /auditoria indisponivel/
  );

  const depois = await lerComprovante(pool, criada.registro.id);
  assert.equal(depois.estado, 'pendente', 'o UPDATE foi desfeito');
  assert.equal(depois.observacao, OBSERVACAO);
  assert.equal(
    depois.atualizado_em.getTime(),
    antes.atualizado_em.getTime(),
    'nem o timestamp sobreviveu ao rollback'
  );
  assert.equal((await lerAuditorias(pool)).length, 1, 'so a auditoria da criacao');
});

// =============================================================================
// Concorrencia
// =============================================================================

test('PG W13: duas chamadas simultaneas no MESMO movimento sao serializadas', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool);
  const payload = { movimentoId, estado: 'pendente', observacao: OBSERVACAO };

  // `Promise.all` sozinho nao garante corrida: as duas chamadas podem acabar
  // executando em sequencia e o teste passaria mesmo sem lock nenhum. Entao a
  // linha e travada ANTES, as duas chamadas se acumulam esperando, e o
  // ROLLBACK as libera praticamente no mesmo instante — que e o cenario que
  // sem serializacao termina em 23505 no indice unico.
  const largada = await pool.connect();
  let disputa = null;
  try {
    await largada.query('BEGIN');
    await largada.query(SQL_SEGURAR_MOVIMENTO, [movimentoId]);

    disputa = Promise.all([
      definirComprovanteDoMovimento(pool, { ...payload }),
      definirComprovanteDoMovimento(pool, { ...payload }),
    ]);
    // Sem lock no service as duas nao ficam na fila, e o gate abaixo falha
    // rapido em vez de deixar o teste pendurado esperando para sempre.
    await esperarBloqueadas(pool, 2);
  } finally {
    await largada.query('ROLLBACK');
    largada.release();
    // Nenhuma transacao pode sobrar pendurada, ou o DROP SCHEMA do teardown
    // ficaria esperando por ela.
    await Promise.allSettled([disputa ?? Promise.resolve()]);
  }

  const resultados = await disputa;

  const alteracoes = resultados.map((r) => r.alteracao).sort();
  assert.deepEqual(
    alteracoes,
    [ALTERACAO.registrado, ALTERACAO.semMudanca].sort(),
    'uma cria, a outra reconhece que nada mudou'
  );
  assert.equal(resultados[0].registro.id, resultados[1].registro.id, 'as duas falam da mesma linha');

  assert.equal(await contar(pool, 'comprovante'), 1);
  assert.equal((await lerAuditorias(pool)).length, 1, 'so a criacao gera trilha');
});

test('PG W13b: o lock e da linha do movimento — e realmente bloqueia', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool);

  // Trava a linha do movimento por fora, simulando o outro writer. Ver
  // `SQL_SEGURAR_MOVIMENTO`: este lock so barra quem tomar `FOR UPDATE`.
  const bloqueador = await pool.connect();
  let escrita = null;
  let concluiu = false;
  try {
    await bloqueador.query('BEGIN');
    await bloqueador.query(SQL_SEGURAR_MOVIMENTO, [movimentoId]);

    escrita = definirComprovanteDoMovimento(pool, { movimentoId, estado: 'pendente' }).then((r) => {
      concluiu = true;
      return r;
    });

    await esperarBloqueadas(pool, 1);

    assert.equal(concluiu, false, 'a escrita espera o lock em vez de furar a fila');
    assert.equal(await contar(pool, 'comprovante'), 0, 'nada foi gravado enquanto esperava');
  } finally {
    await bloqueador.query('ROLLBACK');
    bloqueador.release();
  }

  const resultado = await escrita;
  assert.equal(resultado.alteracao, ALTERACAO.registrado, 'liberado o lock, a escrita conclui');
  assert.equal(await contar(pool, 'comprovante'), 1);
});

test('PG W14: movimentos diferentes nao disputam lock entre si', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoA = await criarMovimento(pool, { data: '2026-01-10' });
  const movimentoB = await criarMovimento(pool, { data: '2026-01-11' });

  const [a, b] = await Promise.all([
    definirComprovanteDoMovimento(pool, { movimentoId: movimentoA, estado: 'pendente' }),
    definirComprovanteDoMovimento(pool, { movimentoId: movimentoB, estado: 'ausente' }),
  ]);

  assert.equal(a.alteracao, ALTERACAO.registrado);
  assert.equal(b.alteracao, ALTERACAO.registrado);
  assert.equal(await contar(pool, 'comprovante'), 2);
  assert.equal((await lerAuditorias(pool)).length, 2);

  // E, com o movimento A travado por fora, o movimento B continua gravavel: o
  // lock e por LINHA, nunca um lock global de escrita de comprovante.
  const bloqueador = await pool.connect();
  await bloqueador.query('BEGIN');
  await bloqueador.query('SELECT id FROM movimento_financeiro WHERE id = $1 FOR UPDATE', [movimentoA]);

  const emB = await definirComprovanteDoMovimento(pool, { movimentoId: movimentoB, estado: 'presente' });
  // Se o lock fosse global (ou de tabela), esta chamada teria ficado presa.
  assert.equal(emB.alteracao, ALTERACAO.alterado, 'B nao ficou preso ao lock de A');

  await bloqueador.query('ROLLBACK');
  bloqueador.release();
});

// =============================================================================
// Trilha completa
// =============================================================================

test('PG W16: a auditoria carrega todos os campos com a semantica do SQLite', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool);

  const criada = await definirComprovanteDoMovimento(pool, {
    movimentoId,
    estado: 'pendente',
    observacao: OBSERVACAO,
  });
  await definirComprovanteDoMovimento(pool, {
    movimentoId,
    estado: 'presente',
    observacao: 'Recebido por e-mail.',
    ator: 'tesouraria',
  });

  const [registroAudit, alteracaoAudit] = await lerAuditorias(pool);

  for (const linha of [registroAudit, alteracaoAudit]) {
    assert.equal(linha.entidade_tipo, 'comprovante');
    assert.equal(linha.entidade_id, String(criada.registro.id));
    assert.ok(linha.criado_em instanceof Date);
  }

  assert.equal(registroAudit.ator, 'sistema', 'ator tecnico padrao quando nenhum e informado');
  assert.equal(registroAudit.acao, ACAO_COMPROVANTE_REGISTRADO);
  assert.equal(registroAudit.estado_anterior, null);

  assert.equal(alteracaoAudit.ator, 'tesouraria');
  assert.equal(alteracaoAudit.acao, ACAO_COMPROVANTE_ALTERADO);

  const anterior = JSON.parse(alteracaoAudit.estado_anterior);
  const posterior = JSON.parse(alteracaoAudit.estado_posterior);
  assert.equal(anterior.estado, 'pendente');
  assert.equal(anterior.observacao, OBSERVACAO);
  assert.equal(posterior.estado, 'presente');
  assert.equal(posterior.observacao, 'Recebido por e-mail.');
  assert.match(posterior.criadoEm, TIMESTAMP_RE, 'o JSON da trilha usa o timestamp publico');

  assert.deepEqual(JSON.parse(alteracaoAudit.metadados), {
    origemRegistro: 'manual',
    movimentoId,
    estadoAnterior: 'pendente',
    estadoNovo: 'presente',
    observacao: 'Recebido por e-mail.',
    criterio: 'estado informado explicitamente pelo operador',
  });
});
