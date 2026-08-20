'use strict';

// Snapshot consistente das leituras compostas do ledger (ADR-003 / PG-2C1R).
//
// O QUE ESTES TESTES PROTEGEM. Uma resposta do ledger sai de mais de uma
// consulta. Em autocommit, cada uma enxerga o banco no instante em que roda, e
// um commit alheio no meio costura uma fotografia impossivel:
//
//   alocacoes.length           = 1    (lidas antes do commit)
//   resumo.quantidadeAlocacoes = 2    (agregado depois do commit)
//
// Quem le a resposta nao tem como perceber que os dois campos falam de momentos
// diferentes. `withReadSnapshot` (REPEATABLE READ + READ ONLY) elimina essa
// classe inteira — sem lock de linha, entao quem escreve nao espera por quem le.
//
// COMO A CORRIDA E DETERMINISTICA. Nada de `sleep`. Os testes interceptam UMA
// funcao do repositorio para abrir uma barreira exatamente entre duas consultas
// do caso de uso: a consulta real continua sendo executada contra o PostgreSQL;
// o teste apenas escolhe QUANDO ela roda. Com a leitura parada nesse ponto, um
// writer independente commita de verdade, e so entao a leitura prossegue.
//
// Isolamento: schema dedicado por teste. Somente `TEST_DATABASE_URL` habilita a
// suite; `DATABASE_URL` nunca e usada como fallback.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  obterMovimento,
  listarMovimentosNaoIdentificados,
  listarMovimentosDoAssociado,
  calcularResumoDoMovimento,
} = require('../src/services/ledger-postgresql');
const repositorio = require('../src/db/postgresql/ledger');
const { withReadSnapshot } = require('../src/db/postgresql/connection');
const { runMigrations } = require('../src/db/postgresql/migrator');
const { motivoSkip, schemaIsolado } = require('./helpers/postgres');

const skip = motivoSkip();

async function schemaMigrado(t) {
  const ctx = await schemaIsolado(t);
  await runMigrations(ctx.pool);
  return ctx;
}

async function criarAssociado(pool) {
  const { rows } = await pool.query('INSERT INTO associado (nome) VALUES ($1) RETURNING id', [
    'Associado Snapshot',
  ]);
  return rows[0].id;
}

async function criarCompetencia(pool, ano, mes) {
  const { rows } = await pool.query(
    'INSERT INTO competencia (ano, mes) VALUES ($1, $2) RETURNING id',
    [ano, mes]
  );
  return rows[0].id;
}

async function criarMovimento(pool, { data = '2026-01-10', valor = 10000, associadoId = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO movimento_financeiro
       (data, valor_centavos, tipo, origem, associado_id, estado_identificacao, ativo)
     VALUES ($1, $2, 'credito', 'pagamento', $3, $4, TRUE)
     RETURNING id`,
    [data, valor, associadoId, associadoId === null ? 'nao_identificado' : 'identificado']
  );
  return rows[0].id;
}

async function criarAlocacao(pool, { movimentoId, competenciaId, valor }) {
  const { rows } = await pool.query(
    'INSERT INTO alocacao (movimento_id, competencia_id, valor_centavos) VALUES ($1, $2, $3) RETURNING id',
    [movimentoId, competenciaId, valor]
  );
  return rows[0].id;
}

/**
 * Barreira de duas maos: o teste espera a leitura CHEGAR a um ponto, e a
 * leitura espera o teste LIBERAR. Determinismo sem relogio.
 */
function barreira() {
  let sinalizarChegada;
  const chegou = new Promise((resolve) => {
    sinalizarChegada = resolve;
  });
  let liberarPassagem;
  const liberado = new Promise((resolve) => {
    liberarPassagem = resolve;
  });
  return {
    chegou,
    liberado,
    sinalizarChegada: () => sinalizarChegada(),
    liberar: () => liberarPassagem(),
  };
}

/**
 * Faz a proxima chamada de `metodo` parar na barreira ANTES de executar — a
 * query real acontece depois, ja com o writer tendo commitado. Devolve a funcao
 * que restaura o repositorio.
 */
function pausarAntesDe(metodo, porta) {
  const original = repositorio[metodo];
  let jaPausou = false;
  repositorio[metodo] = async (...args) => {
    if (!jaPausou) {
      jaPausou = true;
      porta.sinalizarChegada();
      await porta.liberado;
    }
    return original(...args);
  };
  return () => {
    repositorio[metodo] = original;
  };
}

// =============================================================================
// O helper
// =============================================================================

test('PG S1: withReadSnapshot e READ ONLY — o proprio PostgreSQL recusa a escrita', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  let erro;
  try {
    await withReadSnapshot(pool, async (client) => {
      await client.query('SELECT 1');
      await client.query("INSERT INTO associado (nome) VALUES ('nao deveria entrar')");
    });
  } catch (e) {
    erro = e;
  }

  assert.ok(erro, 'a escrita tinha de ser recusada');
  // 25006 = read_only_sql_transaction. A garantia e do banco, nao de uma regra
  // em JavaScript que alguem possa contornar.
  assert.equal(erro.code, '25006');

  const { rows } = await pool.query('SELECT COUNT(*) AS total FROM associado');
  assert.equal(Number(rows[0].total), 0, 'nenhuma linha ficou para tras');
});

test('PG S2: withReadSnapshot devolve o client ao pool, inclusive em erro', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  await assert.rejects(
    () =>
      withReadSnapshot(pool, async () => {
        throw new Error('falha de dominio');
      }),
    /falha de dominio/,
    'o erro ORIGINAL prevalece'
  );

  // Se o client tivesse vazado, o pool esgotaria e estas leituras travariam.
  for (let i = 0; i < 6; i += 1) {
    await withReadSnapshot(pool, (client) => client.query('SELECT 1'));
  }
  assert.ok(pool.idleCount > 0, 'clients voltaram ao pool');
});

// =============================================================================
// Concorrencia — cada caso de uso composto
// =============================================================================

test('PG S3: obterMovimento nao mistura alocacoes de um estado com resumo de outro', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const janeiro = await criarCompetencia(pool, 2026, 1);
  const fevereiro = await criarCompetencia(pool, 2026, 2);
  const movimentoId = await criarMovimento(pool, { valor: 10000, associadoId });
  const alocacaoA = await criarAlocacao(pool, { movimentoId, competenciaId: janeiro, valor: 3000 });

  const porta = barreira();
  // Pausa entre a leitura das alocacoes e a agregacao do resumo.
  const restaurar = pausarAntesDe('resumirAlocacoesAtivas', porta);
  let commitDoWriter = false;
  let resultado;
  try {
    const leitura = obterMovimento(pool, movimentoId);
    await porta.chegou;

    // Writer independente: cria B e COMMITA de verdade, com a leitura em curso.
    await criarAlocacao(pool, { movimentoId, competenciaId: fevereiro, valor: 2000 });
    commitDoWriter = true;

    porta.liberar();
    resultado = await leitura;
  } finally {
    restaurar();
  }

  assert.equal(commitDoWriter, true, 'o writer nao foi bloqueado pela leitura');
  assert.deepEqual(
    resultado.alocacoes.map((a) => a.id),
    [alocacaoA],
    'a leitura continua vendo o snapshot em que so existia A'
  );
  assert.equal(resultado.resumo.quantidadeAlocacoes, 1, 'o resumo descreve as alocacoes devolvidas');
  assert.equal(resultado.resumo.alocadoCentavos, 3000);
  assert.equal(resultado.resumo.naoAlocadoCentavos, 7000);
  // A coerencia interna e o contrato: o resumo fala DESTA lista, sempre.
  assert.equal(
    resultado.resumo.quantidadeAlocacoes,
    resultado.alocacoes.length,
    'resumo e lista tem de descrever o mesmo estado'
  );

  // E uma chamada NOVA enxerga o commit que aconteceu no meio da anterior.
  const depois = await obterMovimento(pool, movimentoId);
  assert.equal(depois.alocacoes.length, 2);
  assert.equal(depois.resumo.quantidadeAlocacoes, 2);
  assert.equal(depois.resumo.alocadoCentavos, 5000);
});

test('PG S4: a fila nao combina total de um estado com itens de outro', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const primeiro = await criarMovimento(pool, { data: '2026-01-01' });
  const segundo = await criarMovimento(pool, { data: '2026-01-02' });

  const porta = barreira();
  // Pausa entre o COUNT e o SELECT da pagina.
  const restaurar = pausarAntesDe('buscarNaoIdentificados', porta);
  let resultado;
  try {
    const leitura = listarMovimentosNaoIdentificados(pool);
    await porta.chegou;

    // Writer: identifica um dos movimentos, tirando-o da fila.
    await pool.query(
      `UPDATE movimento_financeiro
          SET associado_id = $1, estado_identificacao = 'identificado'
        WHERE id = $2`,
      [associadoId, segundo]
    );

    porta.liberar();
    resultado = await leitura;
  } finally {
    restaurar();
  }

  assert.equal(resultado.paginacao.total, 2, 'total do snapshot');
  assert.deepEqual(
    resultado.itens.map((m) => m.id),
    [primeiro, segundo],
    'itens do MESMO snapshot que produziu o total'
  );
  assert.equal(
    resultado.itens.length,
    resultado.paginacao.total,
    'uma pagina que cabe inteira nao pode contradizer o proprio total'
  );

  const depois = await listarMovimentosNaoIdentificados(pool);
  assert.equal(depois.paginacao.total, 1, 'chamada nova ve a identificacao');
  assert.deepEqual(
    depois.itens.map((m) => m.id),
    [primeiro]
  );
});

test('PG S5: o extrato nao anexa alocacao commitada depois da leitura dos movimentos', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const janeiro = await criarCompetencia(pool, 2026, 1);
  const fevereiro = await criarCompetencia(pool, 2026, 2);
  const movimentoId = await criarMovimento(pool, { associadoId });
  const alocacaoA = await criarAlocacao(pool, { movimentoId, competenciaId: janeiro, valor: 4000 });

  const porta = barreira();
  // Pausa entre a leitura dos movimentos e o lote de alocacoes + competencias.
  const restaurar = pausarAntesDe('buscarAlocacoesComCompetencia', porta);
  let extrato;
  try {
    const leitura = listarMovimentosDoAssociado(pool, associadoId);
    await porta.chegou;

    await criarAlocacao(pool, { movimentoId, competenciaId: fevereiro, valor: 1000 });

    porta.liberar();
    extrato = await leitura;
  } finally {
    restaurar();
  }

  assert.equal(extrato.length, 1);
  assert.deepEqual(
    extrato[0].alocacoes.map((a) => a.id),
    [alocacaoA],
    'o lote enxerga o mesmo estado dos movimentos'
  );

  const depois = await listarMovimentosDoAssociado(pool, associadoId);
  assert.equal(depois[0].alocacoes.length, 2, 'chamada nova ve a alocacao nova');
});

test('PG S6: o resumo nao soma alocacoes de um estado sobre o movimento de outro', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const janeiro = await criarCompetencia(pool, 2026, 1);
  const fevereiro = await criarCompetencia(pool, 2026, 2);
  const movimentoId = await criarMovimento(pool, { valor: 10000, associadoId });
  await criarAlocacao(pool, { movimentoId, competenciaId: janeiro, valor: 3000 });

  const porta = barreira();
  // Pausa entre a leitura da linha do movimento e a agregacao.
  const restaurar = pausarAntesDe('resumirAlocacoesAtivas', porta);
  let resumo;
  try {
    const leitura = calcularResumoDoMovimento(pool, movimentoId);
    await porta.chegou;

    await criarAlocacao(pool, { movimentoId, competenciaId: fevereiro, valor: 2000 });

    porta.liberar();
    resumo = await leitura;
  } finally {
    restaurar();
  }

  assert.deepEqual(resumo, {
    movimentoId,
    totalCentavos: 10000,
    alocadoCentavos: 3000,
    naoAlocadoCentavos: 7000,
    quantidadeAlocacoes: 1,
    integralmenteAlocado: false,
  });

  const depois = await calcularResumoDoMovimento(pool, movimentoId);
  assert.equal(depois.alocadoCentavos, 5000);
  assert.equal(depois.quantidadeAlocacoes, 2);
});

test('PG S7: leitura em curso nao atrasa quem escreve', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const janeiro = await criarCompetencia(pool, 2026, 1);
  const movimentoId = await criarMovimento(pool, { valor: 10000, associadoId });
  await criarAlocacao(pool, { movimentoId, competenciaId: janeiro, valor: 3000 });

  const porta = barreira();
  const restaurar = pausarAntesDe('resumirAlocacoesAtivas', porta);
  let resultado;
  try {
    const leitura = obterMovimento(pool, movimentoId);
    await porta.chegou;

    // Com a transacao de leitura ABERTA, o writer altera a MESMA linha de
    // movimento e a MESMA alocacao ja lidas. Se a leitura tivesse tomado
    // `FOR UPDATE`, isto ficaria pendurado ate o COMMIT dela.
    await pool.query(
      "UPDATE movimento_financeiro SET observacao = 'tocado durante a leitura' WHERE id = $1",
      [movimentoId]
    );
    await pool.query(
      `UPDATE alocacao
          SET ativo = FALSE, inativado_em = now(), motivo_inativacao = 'corrigida'
        WHERE movimento_id = $1`,
      [movimentoId]
    );

    porta.liberar();
    resultado = await leitura;
  } finally {
    restaurar();
  }

  // O writer terminou sem esperar, e a leitura seguiu no snapshot antigo.
  assert.equal(resultado.observacao, null);
  assert.equal(resultado.alocacoes.length, 1);
  assert.equal(resultado.resumo.alocadoCentavos, 3000);

  const depois = await obterMovimento(pool, movimentoId);
  assert.equal(depois.observacao, 'tocado durante a leitura');
  assert.deepEqual(depois.alocacoes, [], 'a alocacao inativada saiu da lista ativa');
  assert.equal(depois.resumo.alocadoCentavos, 0);
});
