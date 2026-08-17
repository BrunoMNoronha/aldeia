'use strict';

// Leitura de comprovante em PostgreSQL (ADR-003 / PG-2B1) — M-04, F-05, F-10.
//
// Espelha `tests/comprovantes.test.js` na parte de LEITURA. A gravacao
// (`definirComprovanteDoMovimento`) nao foi convertida nesta fase, entao nao ha
// teste de escrita PostgreSQL aqui — e ha, ao contrario, testes provando que as
// leituras NAO escrevem.
//
// Isolamento: schema dedicado criado e derrubado pelo proprio teste. Somente
// `TEST_DATABASE_URL` habilita a suite; `DATABASE_URL` nunca e usada como
// fallback. Sem banco de teste seguro, os testes sao PULADOS visivelmente.
//
// Como o ledger PostgreSQL ainda nao foi migrado, as linhas de `associado`,
// `movimento_financeiro` e `comprovante` sao preparadas direto no banco. Nenhuma
// implementacao SQLite e usada para gravar aqui. Fixtures ficticias e minimas.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  obterComprovanteDoMovimento,
  obterComprovantesDeMovimentos,
  listarPendenciasDeComprovante,
  ComprovanteError,
  SEM_REGISTRO,
} = require('../src/services/comprovantes-postgresql');
const { runMigrations } = require('../src/db/postgresql/migrator');
const { motivoSkip, schemaIsolado } = require('./helpers/postgres');

const skip = motivoSkip();

/** Mesmo formato do timestamp gravado pelo SQLite (`strftime`), sem fracao. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DATA_CIVIL_RE = /^\d{4}-\d{2}-\d{2}$/;

const OBSERVACAO = 'Comprovante solicitado ao associado.';

async function schemaMigrado(t) {
  const ctx = await schemaIsolado(t);
  await runMigrations(ctx.pool);
  return ctx;
}

async function criarAssociado(pool, nome = 'Associado de Teste') {
  const { rows } = await pool.query('INSERT INTO associado (nome) VALUES ($1) RETURNING id', [nome]);
  return rows[0].id;
}

async function criarMovimento(pool, { data = '2026-01-10', valorCentavos = 15000, associadoId = null, ativo = true } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO movimento_financeiro
       (data, valor_centavos, tipo, origem, associado_id, estado_identificacao,
        ativo, inativado_em, motivo_inativacao)
     VALUES ($1, $2, 'credito', 'pagamento', $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      data,
      valorCentavos,
      associadoId,
      associadoId === null ? 'nao_identificado' : 'identificado',
      ativo,
      // M-09: inativar exige QUANDO e POR QUE — o banco recusa sem os dois.
      ativo ? null : new Date('2026-02-01T00:00:00Z'),
      ativo ? null : 'lancamento duplicado',
    ]
  );
  return rows[0].id;
}

async function criarComprovante(pool, { movimentoId = null, estado, observacao = null } = {}) {
  const { rows } = await pool.query(
    'INSERT INTO comprovante (movimento_id, estado, observacao) VALUES ($1, $2, $3) RETURNING id',
    [movimentoId, estado, observacao]
  );
  return rows[0].id;
}

async function contar(pool, tabela) {
  const { rows } = await pool.query(`SELECT COUNT(*) AS total FROM ${tabela}`);
  return Number(rows[0].total);
}

// =============================================================================
// obterComprovanteDoMovimento
// =============================================================================

test('PG C1: movimento sem comprovante devolve sem_registro, nunca "ausente"', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool);

  const evidencia = await obterComprovanteDoMovimento(pool, movimentoId);

  // A distincao central da fase: nao ha declaracao alguma sobre este movimento.
  assert.equal(evidencia.registrado, false);
  assert.equal(evidencia.estado, null, 'estado de dominio e null, nao "ausente"');
  assert.equal(evidencia.estadoTecnico, SEM_REGISTRO);
  assert.notEqual(evidencia.estadoTecnico, 'ausente');
  assert.equal(evidencia.pendenteDeEvidencia, false, 'vazio nao vira pendencia');
  assert.equal(evidencia.observacao, null);
  assert.equal(evidencia.registro, null);
  assert.equal(evidencia.movimentoId, movimentoId);
});

test('PG C2: movimento inexistente e erro, nao sem_registro', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  await assert.rejects(
    () => obterComprovanteDoMovimento(pool, 9999),
    (erro) => {
      assert.ok(erro instanceof ComprovanteError);
      assert.equal(erro.codigo, 'movimento_inexistente');
      return true;
    },
    'nao existe evidencia sobre algo que nao existe'
  );
});

test('PG C3: id invalido devolve id_invalido', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  for (const invalido of [0, -1, 1.5, '1', null, undefined, {}, [], NaN, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      () => obterComprovanteDoMovimento(pool, invalido),
      (erro) => erro instanceof ComprovanteError && erro.codigo === 'id_invalido',
      `esperava id_invalido para ${JSON.stringify(invalido)}`
    );
  }
});

test('PG C4: os quatro estados de dominio atravessam verbatim', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  for (const estado of ['presente', 'ausente', 'pendente', 'nao_aplicavel']) {
    const movimentoId = await criarMovimento(pool);
    await criarComprovante(pool, { movimentoId, estado, observacao: OBSERVACAO });

    const evidencia = await obterComprovanteDoMovimento(pool, movimentoId);

    assert.equal(evidencia.registrado, true);
    assert.equal(evidencia.estado, estado);
    assert.equal(evidencia.estadoTecnico, estado);
    assert.equal(
      evidencia.pendenteDeEvidencia,
      estado === 'pendente' || estado === 'ausente',
      `pendencia so vale para os estados declarados (${estado})`
    );
    // A observacao e contexto humano: preservada verbatim, nunca lida.
    assert.equal(evidencia.observacao, OBSERVACAO);
    assert.equal(evidencia.registro.observacao, OBSERVACAO);
  }
});

test('PG C5: referencia_externa e data seguem reservadas e sem interpretacao (C-06)', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool);
  await criarComprovante(pool, { movimentoId, estado: 'presente' });

  const { registro } = await obterComprovanteDoMovimento(pool, movimentoId);

  // Vao no retorno, vazias. `null` aqui e "nao informado", nunca "arquivo
  // inexistente" — C-06 continua TO CONFIRM e nada e inferido.
  assert.equal(registro.referenciaExterna, null);
  assert.equal(registro.data, null);
  assert.ok('referenciaExterna' in registro);
  assert.ok('data' in registro);

  // Preenchidas, atravessam sem ganhar significado.
  const outroId = await criarMovimento(pool, { data: '2026-03-05' });
  await criarComprovante(pool, { movimentoId: outroId, estado: 'presente' });
  await pool.query(
    "UPDATE comprovante SET referencia_externa = 'ref-123', data = '2026-03-05' WHERE movimento_id = $1",
    [outroId]
  );

  const outro = await obterComprovanteDoMovimento(pool, outroId);
  assert.equal(outro.registro.referenciaExterna, 'ref-123');
  // Data CIVIL: string YYYY-MM-DD, sem fuso e sem virar instante.
  assert.equal(outro.registro.data, '2026-03-05');
  assert.match(outro.registro.data, DATA_CIVIL_RE);
});

test('PG C6: os timestamps publicos sao string no formato do contrato', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool);
  await criarComprovante(pool, { movimentoId, estado: 'pendente' });

  const { registro } = await obterComprovanteDoMovimento(pool, movimentoId);

  assert.equal(typeof registro.criadoEm, 'string', 'TIMESTAMPTZ nao pode vazar como Date');
  assert.equal(typeof registro.atualizadoEm, 'string');
  assert.match(registro.criadoEm, TIMESTAMP_RE);
  assert.match(registro.atualizadoEm, TIMESTAMP_RE);
});

test('PG C7: leitura nao cria registro nem auditoria', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const comRegistro = await criarMovimento(pool);
  const semRegistro = await criarMovimento(pool);
  await criarComprovante(pool, { movimentoId: comRegistro, estado: 'pendente' });

  const comprovantesAntes = await contar(pool, 'comprovante');
  const auditoriaAntes = await contar(pool, 'audit_log');
  const movimentosAntes = await contar(pool, 'movimento_financeiro');

  // Varias leituras, inclusive do movimento SEM registro — o caso onde um
  // servico descuidado poderia "criar sob demanda".
  for (let i = 0; i < 3; i += 1) {
    await obterComprovanteDoMovimento(pool, comRegistro);
    await obterComprovanteDoMovimento(pool, semRegistro);
    await obterComprovantesDeMovimentos(pool, [comRegistro, semRegistro]);
    await listarPendenciasDeComprovante(pool);
  }

  assert.equal(await contar(pool, 'comprovante'), comprovantesAntes, 'leitura nao cria comprovante');
  assert.equal(await contar(pool, 'audit_log'), auditoriaAntes, 'leitura nao gera audit_log');
  assert.equal(await contar(pool, 'movimento_financeiro'), movimentosAntes);

  // E o movimento sem registro continua sem registro.
  assert.equal((await obterComprovanteDoMovimento(pool, semRegistro)).estadoTecnico, SEM_REGISTRO);
});

// =============================================================================
// obterComprovantesDeMovimentos
// =============================================================================

test('PG C8: o lote devolve uma entrada por id pedido, com estados diferentes', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const presente = await criarMovimento(pool);
  const pendente = await criarMovimento(pool);
  const semRegistro = await criarMovimento(pool);
  await criarComprovante(pool, { movimentoId: presente, estado: 'presente' });
  await criarComprovante(pool, { movimentoId: pendente, estado: 'pendente', observacao: OBSERVACAO });

  const mapa = await obterComprovantesDeMovimentos(pool, [presente, pendente, semRegistro]);

  assert.equal(mapa.size, 3);
  assert.equal(mapa.get(presente).estado, 'presente');
  assert.equal(mapa.get(presente).pendenteDeEvidencia, false);
  assert.equal(mapa.get(pendente).estado, 'pendente');
  assert.equal(mapa.get(pendente).observacao, OBSERVACAO);

  // O id sem comprovante CONTINUA no mapa — chave faltando poderia ser lida
  // como 'ausente' por quem exibe.
  assert.ok(mapa.has(semRegistro));
  assert.equal(mapa.get(semRegistro).estadoTecnico, SEM_REGISTRO);
  assert.equal(mapa.get(semRegistro).estado, null);
  assert.equal(mapa.get(semRegistro).registrado, false);
});

test('PG C9: lote vazio devolve Map vazio sem consultar o banco', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const mapa = await obterComprovantesDeMovimentos(pool, []);

  assert.equal(mapa.size, 0);
  assert.ok(mapa instanceof Map);
});

test('PG C10: cada evidencia fica associada ao seu proprio movimento', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  // Estados distintos por movimento: uma troca de associacao apareceria aqui.
  const ids = [];
  const estados = ['presente', 'ausente', 'pendente', 'nao_aplicavel'];
  for (const estado of estados) {
    const id = await criarMovimento(pool);
    await criarComprovante(pool, { movimentoId: id, estado, observacao: `obs ${estado}` });
    ids.push(id);
  }

  // Pedidos fora de ordem: o mapa e por id, nao por posicao.
  const mapa = await obterComprovantesDeMovimentos(pool, [...ids].reverse());

  for (const [indice, id] of ids.entries()) {
    assert.equal(mapa.get(id).estado, estados[indice]);
    assert.equal(mapa.get(id).movimentoId, id);
    assert.equal(mapa.get(id).registro.movimentoId, id);
    assert.equal(mapa.get(id).observacao, `obs ${estados[indice]}`);
  }
});

// =============================================================================
// listarPendenciasDeComprovante
// =============================================================================

test('PG C11: so os estados declarados pendentes entram na fila', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const pendente = await criarMovimento(pool, { data: '2026-01-01' });
  const ausente = await criarMovimento(pool, { data: '2026-01-02' });
  const presente = await criarMovimento(pool, { data: '2026-01-03' });
  const naoAplicavel = await criarMovimento(pool, { data: '2026-01-04' });
  const semRegistro = await criarMovimento(pool, { data: '2026-01-05' });

  await criarComprovante(pool, { movimentoId: pendente, estado: 'pendente' });
  await criarComprovante(pool, { movimentoId: ausente, estado: 'ausente' });
  await criarComprovante(pool, { movimentoId: presente, estado: 'presente' });
  await criarComprovante(pool, { movimentoId: naoAplicavel, estado: 'nao_aplicavel' });
  // Comprovante INDEPENDENTE (M-04): existe, mas nao e um movimento.
  await criarComprovante(pool, { movimentoId: null, estado: 'pendente' });

  const fila = await listarPendenciasDeComprovante(pool);
  const idsNaFila = fila.itens.map((item) => item.movimentoId);

  assert.deepEqual(idsNaFila, [pendente, ausente]);
  assert.equal(fila.paginacao.total, 2);
  assert.deepEqual(fila.estados, ['pendente', 'ausente']);

  assert.equal(idsNaFila.includes(presente), false, "'presente' esta resolvido");
  assert.equal(idsNaFila.includes(naoAplicavel), false, "'nao_aplicavel' foi decidido");
  assert.equal(idsNaFila.includes(semRegistro), false, 'ausencia de registro nao e pendencia');
  // O comprovante independente nao tem movimento e por isso nao aparece.
  assert.equal(fila.itens.every((item) => item.movimentoId !== null), true);
});

test('PG C12: movimento inativado permanece elegivel a fila (M-09)', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const ativo = await criarMovimento(pool, { data: '2026-01-01' });
  const inativado = await criarMovimento(pool, { data: '2026-01-02', ativo: false });
  await criarComprovante(pool, { movimentoId: ativo, estado: 'pendente' });
  await criarComprovante(pool, { movimentoId: inativado, estado: 'ausente' });

  const fila = await listarPendenciasDeComprovante(pool);

  // Inativar corrige o lancamento; nao apaga a necessidade de evidencia.
  assert.deepEqual(fila.itens.map((item) => item.movimentoId), [ativo, inativado]);
  assert.equal(fila.paginacao.total, 2);

  const itemInativado = fila.itens.find((item) => item.movimentoId === inativado);
  assert.equal(itemInativado.movimento.ativo, false);
  assert.equal(typeof itemInativado.movimento.ativo, 'boolean', 'contrato publico e boolean');

  const itemAtivo = fila.itens.find((item) => item.movimentoId === ativo);
  assert.equal(itemAtivo.movimento.ativo, true);
  assert.equal(typeof itemAtivo.movimento.ativo, 'boolean');
});

test('PG C13: filtro por estado', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const pendente = await criarMovimento(pool, { data: '2026-01-01' });
  const ausente = await criarMovimento(pool, { data: '2026-01-02' });
  await criarComprovante(pool, { movimentoId: pendente, estado: 'pendente' });
  await criarComprovante(pool, { movimentoId: ausente, estado: 'ausente' });

  const soPendente = await listarPendenciasDeComprovante(pool, { estado: 'pendente' });
  assert.deepEqual(soPendente.itens.map((i) => i.movimentoId), [pendente]);
  assert.deepEqual(soPendente.estados, ['pendente']);
  assert.equal(soPendente.paginacao.total, 1);

  // Caixa alta e a mesma palavra, nao uma segunda convencao.
  const soAusente = await listarPendenciasDeComprovante(pool, { estado: 'AUSENTE' });
  assert.deepEqual(soAusente.itens.map((i) => i.movimentoId), [ausente]);
  assert.deepEqual(soAusente.estados, ['ausente']);
});

test('PG C14: estado invalido na fila mantem o mesmo erro', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  // 'presente' e 'nao_aplicavel' sao estados validos, mas a fila NAO os serve:
  // pedir por eles e recusado em vez de devolver lista vazia.
  for (const estado of ['presente', 'nao_aplicavel', 'sem_registro', 'OK', '', 'N/A', 123]) {
    await assert.rejects(
      () => listarPendenciasDeComprovante(pool, { estado }),
      (erro) => erro instanceof ComprovanteError && erro.codigo === 'estado_comprovante_invalido',
      `esperava estado_comprovante_invalido para ${JSON.stringify(estado)}`
    );
  }
});

test('PG C15: ordenacao por data e desempate por id', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  // Datas fora de ordem, e duas iguais para exercitar o desempate.
  const terceiro = await criarMovimento(pool, { data: '2026-03-01' });
  const primeiro = await criarMovimento(pool, { data: '2026-01-01' });
  const segundoA = await criarMovimento(pool, { data: '2026-02-01' });
  const segundoB = await criarMovimento(pool, { data: '2026-02-01' });

  for (const id of [terceiro, primeiro, segundoA, segundoB]) {
    await criarComprovante(pool, { movimentoId: id, estado: 'pendente' });
  }

  const esperado = [primeiro, segundoA, segundoB, terceiro];

  // Repetido: sem o desempate por id, os dois de 2026-02-01 poderiam trocar.
  for (let i = 0; i < 3; i += 1) {
    const fila = await listarPendenciasDeComprovante(pool);
    assert.deepEqual(fila.itens.map((item) => item.movimentoId), esperado);
    assert.deepEqual(fila.itens.map((item) => item.movimento.data), [
      '2026-01-01',
      '2026-02-01',
      '2026-02-01',
      '2026-03-01',
    ]);
  }
});

test('PG C16: paginacao — limite, offset e total antes do recorte', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const ids = [];
  for (let dia = 1; dia <= 5; dia += 1) {
    const id = await criarMovimento(pool, { data: `2026-01-0${dia}` });
    await criarComprovante(pool, { movimentoId: id, estado: 'pendente' });
    ids.push(id);
  }

  const pagina = await listarPendenciasDeComprovante(pool, { limite: 2, offset: 0 });
  assert.deepEqual(pagina.itens.map((i) => i.movimentoId), ids.slice(0, 2));
  assert.equal(pagina.paginacao.limite, 2);
  assert.equal(pagina.paginacao.offset, 0);
  // `total` e o universo filtrado, NAO itens.length.
  assert.equal(pagina.paginacao.total, 5);
  assert.notEqual(pagina.paginacao.total, pagina.itens.length);

  const segunda = await listarPendenciasDeComprovante(pool, { limite: 2, offset: 2 });
  assert.deepEqual(segunda.itens.map((i) => i.movimentoId), ids.slice(2, 4));
  assert.equal(segunda.paginacao.total, 5);

  const alemDoFim = await listarPendenciasDeComprovante(pool, { limite: 2, offset: 10 });
  assert.deepEqual(alemDoFim.itens, []);
  assert.equal(alemDoFim.paginacao.total, 5, 'passar do fim nao zera o universo');

  // Padroes e faixa.
  const padrao = await listarPendenciasDeComprovante(pool);
  assert.equal(padrao.paginacao.limite, 50);
  assert.equal(padrao.paginacao.offset, 0);

  for (const invalido of [{ limite: 0 }, { limite: 201 }, { limite: -1 }, { limite: 1.5 }, { offset: -1 }, { limite: '10' }]) {
    await assert.rejects(
      () => listarPendenciasDeComprovante(pool, invalido),
      (erro) => erro instanceof ComprovanteError && erro.codigo === 'paginacao_invalida',
      `esperava paginacao_invalida para ${JSON.stringify(invalido)}`
    );
  }
});

test('PG C17: tipos publicos do item da fila', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const associadoId = await criarAssociado(pool);
  const movimentoId = await criarMovimento(pool, {
    data: '2026-01-10',
    valorCentavos: 15000,
    associadoId,
  });
  await criarComprovante(pool, { movimentoId, estado: 'pendente', observacao: OBSERVACAO });

  const [item] = (await listarPendenciasDeComprovante(pool)).itens;

  assert.equal(item.movimentoId, movimentoId);
  assert.equal(item.estado, 'pendente');
  assert.equal(item.observacao, OBSERVACAO);
  assert.match(item.criadoEm, TIMESTAMP_RE);
  assert.match(item.atualizadoEm, TIMESTAMP_RE);

  // T-06: centavos INTEIROS. BIGINT nao pode chegar como string nem como float.
  assert.equal(item.movimento.valorCentavos, 15000);
  assert.equal(typeof item.movimento.valorCentavos, 'number');
  assert.ok(Number.isInteger(item.movimento.valorCentavos));

  // Data civil intacta: nenhum fuso a moveu de dia.
  assert.equal(item.movimento.data, '2026-01-10');
  assert.equal(typeof item.movimento.data, 'string');
  assert.match(item.movimento.data, DATA_CIVIL_RE);

  assert.equal(item.movimento.ativo, true);
  assert.equal(typeof item.movimento.ativo, 'boolean');
  assert.equal(item.movimento.associadoId, associadoId);
  assert.equal(item.movimento.estadoIdentificacao, 'identificado');
});

test('PG C18: fila vazia nao lanca e total e zero', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const fila = await listarPendenciasDeComprovante(pool);

  assert.deepEqual(fila.itens, []);
  assert.equal(fila.paginacao.total, 0);
});

test('PG C19: a observacao nunca decide o estado', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  // Textos que um servico "esperto" poderia tentar interpretar.
  const enganosos = [
    ['presente', 'faltando o comprovante'],
    ['ausente', 'ok, recebido'],
    ['nao_aplicavel', 'pendente de analise'],
    ['pendente', 'sem comprovante'],
  ];

  const ids = [];
  for (const [estado, observacao] of enganosos) {
    const id = await criarMovimento(pool);
    await criarComprovante(pool, { movimentoId: id, estado, observacao });
    ids.push({ id, estado, observacao });
  }

  for (const { id, estado, observacao } of ids) {
    const evidencia = await obterComprovanteDoMovimento(pool, id);
    // O estado estruturado manda; o texto so viaja junto.
    assert.equal(evidencia.estado, estado);
    assert.equal(evidencia.observacao, observacao);
    assert.equal(evidencia.pendenteDeEvidencia, estado === 'pendente' || estado === 'ausente');
  }

  // Na fila, quem entra e decidido pelo estado, nao pelo texto.
  const fila = await listarPendenciasDeComprovante(pool);
  assert.deepEqual(
    fila.itens.map((item) => item.estado).sort(),
    ['ausente', 'pendente']
  );
});
