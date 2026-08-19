'use strict';

// Leitura do ledger em PostgreSQL (ADR-003 / PG-2C1) — F-02, F-06, F-08, F-10.
//
// Espelha a parte de LEITURA de `tests/ledger.test.js`. A gravacao do ledger nao
// foi convertida nesta fase, entao nao ha teste de escrita PostgreSQL aqui — e
// ha, ao contrario, teste provando que as leituras NAO escrevem.
//
// Isolamento: schema dedicado criado e derrubado pelo proprio teste. Somente
// `TEST_DATABASE_URL` habilita a suite; `DATABASE_URL` nunca e usada como
// fallback. Sem banco de teste seguro, os testes sao PULADOS visivelmente.
//
// Como a ESCRITA do ledger ainda nao foi migrada, as linhas sao preparadas
// direto no banco. Nenhuma implementacao SQLite grava aqui. Fixtures ficticias
// e minimas.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  obterMovimento,
  listarMovimentosNaoIdentificados,
  listarMovimentosDoAssociado,
  listarAlocacoesDoMovimento,
  calcularResumoDoMovimento,
  LedgerError,
} = require('../src/services/ledger-postgresql');
const { runMigrations } = require('../src/db/postgresql/migrator');
const { ID_MAXIMO_INT4 } = require('../src/db/postgresql/tipos');
const { motivoSkip, schemaIsolado } = require('./helpers/postgres');

const skip = motivoSkip();

/** Mesmo formato do timestamp gravado pelo SQLite (`strftime`), sem fracao. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DATA_CIVIL_RE = /^\d{4}-\d{2}-\d{2}$/;

const INATIVADO_EM = new Date('2026-05-01T00:00:00Z');
const MOTIVO = 'lancamento duplicado';

async function schemaMigrado(t) {
  const ctx = await schemaIsolado(t);
  await runMigrations(ctx.pool);
  return ctx;
}

async function criarAssociado(pool, nome = 'Associado de Teste') {
  const { rows } = await pool.query('INSERT INTO associado (nome) VALUES ($1) RETURNING id', [nome]);
  return rows[0].id;
}

async function criarCompetencia(pool, { ano, mes }) {
  const { rows } = await pool.query(
    'INSERT INTO competencia (ano, mes) VALUES ($1, $2) RETURNING id',
    [ano, mes]
  );
  return rows[0].id;
}

async function criarMovimento(
  pool,
  {
    data = '2026-01-10',
    valorCentavos = 15000,
    associadoId = null,
    estadoIdentificacao = null,
    ativo = true,
    origem = 'pagamento',
    observacao = null,
  } = {}
) {
  const estado = estadoIdentificacao ?? (associadoId === null ? 'nao_identificado' : 'identificado');
  const { rows } = await pool.query(
    `INSERT INTO movimento_financeiro
       (data, valor_centavos, tipo, origem, associado_id, observacao, estado_identificacao,
        ativo, inativado_em, motivo_inativacao)
     VALUES ($1, $2, 'credito', $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      data,
      valorCentavos,
      origem,
      associadoId,
      observacao,
      estado,
      ativo,
      // M-09: inativar exige QUANDO e POR QUE — o banco recusa sem os dois.
      ativo ? null : INATIVADO_EM,
      ativo ? null : MOTIVO,
    ]
  );
  return rows[0].id;
}

async function criarAlocacao(
  pool,
  { movimentoId, competenciaId, valorCentavos, ativo = true, observacao = null }
) {
  const { rows } = await pool.query(
    `INSERT INTO alocacao
       (movimento_id, competencia_id, valor_centavos, observacao, ativo, inativado_em, motivo_inativacao)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      movimentoId,
      competenciaId,
      valorCentavos,
      observacao,
      ativo,
      ativo ? null : INATIVADO_EM,
      ativo ? null : 'alocacao corrigida',
    ]
  );
  return rows[0].id;
}

async function contar(pool, tabela) {
  const { rows } = await pool.query(`SELECT COUNT(*) AS total FROM ${tabela}`);
  return Number(rows[0].total);
}

// =============================================================================
// obterMovimento / resumo
// =============================================================================

test('PG L1: movimento inexistente devolve null, nao erro de driver', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  assert.equal(await obterMovimento(pool, 9999), null);
});

test('PG L2: id acima do teto do int4 responde como inexistente, sem 22003', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const acimaDoTeto = ID_MAXIMO_INT4 + 1;

  assert.equal(await obterMovimento(pool, acimaDoTeto), null);
  assert.deepEqual(await listarAlocacoesDoMovimento(pool, acimaDoTeto), []);

  await assert.rejects(
    () => calcularResumoDoMovimento(pool, acimaDoTeto),
    (erro) => {
      assert.ok(erro instanceof LedgerError, 'nao pode ser erro cru do driver');
      assert.equal(erro.codigo, 'movimento_inexistente');
      assert.equal(erro.code, undefined, 'nao carrega 22003 do PostgreSQL');
      return true;
    }
  );

  // E o extrato de um associado fora da faixa tambem nao explode.
  assert.deepEqual(await listarMovimentosDoAssociado(pool, acimaDoTeto), []);
});

test('PG L3: movimento sem alocacoes tem resumo zerado e nada alocado', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const movimentoId = await criarMovimento(pool, { valorCentavos: 15000 });

  const movimento = await obterMovimento(pool, movimentoId);

  assert.deepEqual(movimento.alocacoes, []);
  assert.deepEqual(movimento.resumo, {
    movimentoId,
    totalCentavos: 15000,
    alocadoCentavos: 0,
    naoAlocadoCentavos: 15000,
    quantidadeAlocacoes: 0,
    integralmenteAlocado: false,
  });
  assert.equal(movimento.ativo, true, 'BOOLEAN do PostgreSQL vira boolean publico');
  assert.match(movimento.data, DATA_CIVIL_RE);
  assert.match(movimento.criadoEm, TIMESTAMP_RE);
});

test('PG L4: movimento parcialmente alocado', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const competenciaId = await criarCompetencia(pool, { ano: 2026, mes: 1 });
  const movimentoId = await criarMovimento(pool, { valorCentavos: 15000, associadoId });
  await criarAlocacao(pool, { movimentoId, competenciaId, valorCentavos: 10000 });

  const resumo = await calcularResumoDoMovimento(pool, movimentoId);

  assert.deepEqual(resumo, {
    movimentoId,
    totalCentavos: 15000,
    alocadoCentavos: 10000,
    naoAlocadoCentavos: 5000,
    quantidadeAlocacoes: 1,
    integralmenteAlocado: false,
  });
});

test('PG L5: movimento integralmente alocado em duas competencias', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const janeiro = await criarCompetencia(pool, { ano: 2026, mes: 1 });
  const fevereiro = await criarCompetencia(pool, { ano: 2026, mes: 2 });
  const movimentoId = await criarMovimento(pool, { valorCentavos: 15000, associadoId });
  await criarAlocacao(pool, { movimentoId, competenciaId: janeiro, valorCentavos: 10000 });
  await criarAlocacao(pool, { movimentoId, competenciaId: fevereiro, valorCentavos: 5000 });

  const resumo = await calcularResumoDoMovimento(pool, movimentoId);

  assert.equal(resumo.alocadoCentavos, 15000);
  assert.equal(resumo.naoAlocadoCentavos, 0);
  assert.equal(resumo.quantidadeAlocacoes, 2);
  assert.equal(resumo.integralmenteAlocado, true);
  // M-02: um movimento com duas alocacoes continua sendo UM movimento.
  const movimento = await obterMovimento(pool, movimentoId);
  assert.equal(movimento.alocacoes.length, 2);
});

test('PG L6: alocacao inativa nao entra no resumo', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const competenciaId = await criarCompetencia(pool, { ano: 2026, mes: 1 });
  const movimentoId = await criarMovimento(pool, { valorCentavos: 15000, associadoId });
  await criarAlocacao(pool, { movimentoId, competenciaId, valorCentavos: 10000 });
  await criarAlocacao(pool, { movimentoId, competenciaId, valorCentavos: 5000, ativo: false });

  const resumo = await calcularResumoDoMovimento(pool, movimentoId);

  assert.equal(resumo.alocadoCentavos, 10000, 'a inativa nao soma');
  assert.equal(resumo.quantidadeAlocacoes, 1, 'a inativa nao conta');
  assert.equal(resumo.naoAlocadoCentavos, 5000);
  assert.equal(resumo.integralmenteAlocado, false);
  // M-09: e continua existindo no banco.
  assert.equal(await contar(pool, 'alocacao'), 2);
});

test('PG L7: listarAlocacoes omite as inativas por padrao', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const competenciaId = await criarCompetencia(pool, { ano: 2026, mes: 1 });
  const movimentoId = await criarMovimento(pool, { associadoId });
  const ativaId = await criarAlocacao(pool, { movimentoId, competenciaId, valorCentavos: 10000 });
  await criarAlocacao(pool, { movimentoId, competenciaId, valorCentavos: 5000, ativo: false });

  const alocacoes = await listarAlocacoesDoMovimento(pool, movimentoId);

  assert.equal(alocacoes.length, 1);
  assert.equal(alocacoes[0].id, ativaId);
  assert.equal(alocacoes[0].ativo, true);
});

test('PG L8: incluirInativas preserva o historico, em ordem de id', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const competenciaId = await criarCompetencia(pool, { ano: 2026, mes: 1 });
  const movimentoId = await criarMovimento(pool, { associadoId });
  const primeira = await criarAlocacao(pool, {
    movimentoId,
    competenciaId,
    valorCentavos: 5000,
    ativo: false,
  });
  const segunda = await criarAlocacao(pool, { movimentoId, competenciaId, valorCentavos: 10000 });

  const todas = await listarAlocacoesDoMovimento(pool, movimentoId, { incluirInativas: true });

  assert.deepEqual(
    todas.map((a) => a.id),
    [primeira, segunda],
    'ordem por id crescente'
  );
  assert.deepEqual(
    todas.map((a) => a.ativo),
    [false, true]
  );
});

// =============================================================================
// Fila de nao identificados
// =============================================================================

test('PG L9: a fila aplica os tres filtros simultaneamente', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);

  const elegivel = await criarMovimento(pool, { data: '2026-01-05' });
  // Identificado: tem associado e estado 'identificado'.
  await criarMovimento(pool, { data: '2026-01-06', associadoId });
  // Inconsistencia manual: associado preenchido mas estado 'nao_identificado'.
  await criarMovimento(pool, {
    data: '2026-01-07',
    associadoId,
    estadoIdentificacao: 'nao_identificado',
  });

  const { itens } = await listarMovimentosNaoIdentificados(pool);

  assert.deepEqual(
    itens.map((m) => m.id),
    [elegivel],
    'so o que satisfaz as tres condicoes entra'
  );
});

test('PG L10: em_revisao nunca entra na fila (M-08)', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  await criarMovimento(pool, { estadoIdentificacao: 'em_revisao' });

  const { itens, paginacao } = await listarMovimentosNaoIdentificados(pool);

  assert.deepEqual(itens, [], 'ambiguidade declarada nao e promovida a fila');
  assert.equal(paginacao.total, 0);
});

test('PG L11: movimento inativo nunca entra na fila (M-09)', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  await criarMovimento(pool, { ativo: false });

  const { itens, paginacao } = await listarMovimentosNaoIdentificados(pool);

  assert.deepEqual(itens, []);
  assert.equal(paginacao.total, 0);
});

test('PG L12: paginacao e ordenacao sao deterministicas', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  // Duas datas iguais para exercitar o desempate por id.
  const a = await criarMovimento(pool, { data: '2026-01-02' });
  const b = await criarMovimento(pool, { data: '2026-01-01' });
  const c = await criarMovimento(pool, { data: '2026-01-02' });

  const primeira = await listarMovimentosNaoIdentificados(pool, { limite: 2, offset: 0 });
  const segunda = await listarMovimentosNaoIdentificados(pool, { limite: 2, offset: 2 });

  assert.deepEqual(
    primeira.itens.map((m) => m.id),
    [b, a],
    'data ASC, desempate por id ASC'
  );
  assert.deepEqual(
    segunda.itens.map((m) => m.id),
    [c]
  );
  // `total` e o universo, nao a pagina.
  assert.equal(primeira.paginacao.total, 3);
  assert.equal(segunda.paginacao.total, 3);
  assert.equal(typeof primeira.paginacao.total, 'number', 'COUNT(*) int8 vira Number seguro');

  // Pagina alem do fim: vazia, sem alterar o total.
  const alem = await listarMovimentosNaoIdentificados(pool, { limite: 10, offset: 99 });
  assert.deepEqual(alem.itens, []);
  assert.equal(alem.paginacao.total, 3);

  // Paginacao invalida e recusada com o codigo do contrato.
  await assert.rejects(
    () => listarMovimentosNaoIdentificados(pool, { limite: 0 }),
    (erro) => erro instanceof LedgerError && erro.codigo === 'paginacao_invalida'
  );
  await assert.rejects(
    () => listarMovimentosNaoIdentificados(pool, { limite: 201 }),
    (erro) => erro instanceof LedgerError && erro.codigo === 'paginacao_invalida'
  );
});

// =============================================================================
// Extrato do associado
// =============================================================================

test('PG L13: o extrato inclui movimento inativo (historico nao some)', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const ativo = await criarMovimento(pool, { data: '2026-01-10', associadoId });
  const inativo = await criarMovimento(pool, { data: '2026-02-10', associadoId, ativo: false });

  const extrato = await listarMovimentosDoAssociado(pool, associadoId);

  assert.deepEqual(
    extrato.map((m) => m.id),
    [inativo, ativo],
    'data DESC, id DESC'
  );
  const linhaInativa = extrato[0];
  assert.equal(linhaInativa.ativo, false);
  assert.equal(linhaInativa.motivoInativacao, MOTIVO, 'M-09: prova o porque');
  assert.match(linhaInativa.inativadoEm, TIMESTAMP_RE, 'e o quando, como texto');
  assert.equal(extrato[1].inativadoEm, null);
});

test('PG L14: o extrato preserva alocacoes inativas', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const competenciaId = await criarCompetencia(pool, { ano: 2026, mes: 3 });
  const movimentoId = await criarMovimento(pool, { associadoId });
  await criarAlocacao(pool, { movimentoId, competenciaId, valorCentavos: 10000 });
  await criarAlocacao(pool, { movimentoId, competenciaId, valorCentavos: 2500, ativo: false });

  const [movimento] = await listarMovimentosDoAssociado(pool, associadoId);

  assert.equal(movimento.alocacoes.length, 2, 'o read model nao omite a inativa');
  const inativa = movimento.alocacoes.find((a) => a.ativo === false);
  assert.equal(inativa.motivoInativacao, 'alocacao corrigida');
  assert.match(inativa.inativadoEm, TIMESTAMP_RE);
});

test('PG L15: cada alocacao carrega a competencia correta', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const janeiro = await criarCompetencia(pool, { ano: 2026, mes: 1 });
  const dezembro = await criarCompetencia(pool, { ano: 2025, mes: 12 });
  const movimentoId = await criarMovimento(pool, { associadoId });
  await criarAlocacao(pool, { movimentoId, competenciaId: janeiro, valorCentavos: 10000 });
  await criarAlocacao(pool, { movimentoId, competenciaId: dezembro, valorCentavos: 5000 });

  const [movimento] = await listarMovimentosDoAssociado(pool, associadoId);

  // Ordenacao das alocacoes: por competencia (ano, mes) e depois id.
  assert.deepEqual(
    movimento.alocacoes.map((a) => a.competencia.rotulo),
    ['2025-12', '2026-01'],
    'o mes sempre com dois digitos'
  );
  const [primeira, segunda] = movimento.alocacoes;
  assert.deepEqual(primeira.competencia, { id: dezembro, ano: 2025, mes: 12, rotulo: '2025-12' });
  assert.deepEqual(segunda.competencia, { id: janeiro, ano: 2026, mes: 1, rotulo: '2026-01' });
  assert.equal(primeira.competenciaId, dezembro, 'a alocacao aponta para a propria competencia');
});

test('PG L24: associado sem movimentos devolve lista vazia, sem consultar em lote', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);

  assert.deepEqual(await listarMovimentosDoAssociado(pool, associadoId), []);
});

test('PG L25: ids permanecem ligados aos registros certos com varios movimentos', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const outroAssociado = await criarAssociado(pool, 'Outro');
  const janeiro = await criarCompetencia(pool, { ano: 2026, mes: 1 });
  const fevereiro = await criarCompetencia(pool, { ano: 2026, mes: 2 });

  const m1 = await criarMovimento(pool, { data: '2026-01-10', associadoId, valorCentavos: 10000 });
  const m2 = await criarMovimento(pool, { data: '2026-02-10', associadoId, valorCentavos: 20000 });
  // Movimento de OUTRO associado, na mesma competencia: nao pode vazar.
  const alheio = await criarMovimento(pool, { data: '2026-02-11', associadoId: outroAssociado });

  const a1 = await criarAlocacao(pool, { movimentoId: m1, competenciaId: janeiro, valorCentavos: 10000 });
  const a2 = await criarAlocacao(pool, { movimentoId: m2, competenciaId: janeiro, valorCentavos: 8000 });
  const a3 = await criarAlocacao(pool, { movimentoId: m2, competenciaId: fevereiro, valorCentavos: 12000 });
  await criarAlocacao(pool, { movimentoId: alheio, competenciaId: janeiro, valorCentavos: 1000 });

  const extrato = await listarMovimentosDoAssociado(pool, associadoId);

  assert.deepEqual(
    extrato.map((m) => m.id),
    [m2, m1]
  );
  assert.deepEqual(
    extrato.find((m) => m.id === m1).alocacoes.map((a) => a.id),
    [a1]
  );
  // M-02: duas competencias no MESMO movimento continuam sendo um movimento.
  assert.deepEqual(
    extrato.find((m) => m.id === m2).alocacoes.map((a) => a.id),
    [a2, a3]
  );
  assert.deepEqual(
    extrato.find((m) => m.id === m2).alocacoes.map((a) => a.competencia.rotulo),
    ['2026-01', '2026-02']
  );
  for (const movimento of extrato) {
    for (const alocacao of movimento.alocacoes) {
      assert.equal(alocacao.movimentoId, movimento.id, 'alocacao no movimento errado');
    }
  }
});

// =============================================================================
// Tipos — T-06, data civil, timestamps, boolean
// =============================================================================

test('PG L16: valores monetarios sao Number inteiro seguro', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const competenciaId = await criarCompetencia(pool, { ano: 2026, mes: 1 });
  const movimentoId = await criarMovimento(pool, { valorCentavos: 15000, associadoId });
  await criarAlocacao(pool, { movimentoId, competenciaId, valorCentavos: 10000 });

  const movimento = await obterMovimento(pool, movimentoId);

  for (const valor of [
    movimento.valorCentavos,
    movimento.alocacoes[0].valorCentavos,
    movimento.resumo.totalCentavos,
    movimento.resumo.alocadoCentavos,
    movimento.resumo.naoAlocadoCentavos,
    movimento.resumo.quantidadeAlocacoes,
  ]) {
    assert.equal(typeof valor, 'number', 'nada de string vinda do driver');
    assert.ok(Number.isSafeInteger(valor), 'nada de float como fonte oficial (T-06)');
  }
});

test('PG L17: SUM(BIGINT) nao vaza NUMERIC como string nem vira float', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  // Competencias distintas: o schema so admite UMA alocacao ativa por
  // (movimento, competencia) — `ux_alocacao_ativa`.
  const janeiro = await criarCompetencia(pool, { ano: 2026, mes: 1 });
  const fevereiro = await criarCompetencia(pool, { ano: 2026, mes: 2 });
  // Valores grandes o bastante para que qualquer float perdesse precisao.
  const total = 9007199254740991; // Number.MAX_SAFE_INTEGER
  const parte = 4503599627370495;
  const movimentoId = await criarMovimento(pool, { valorCentavos: total, associadoId });
  await criarAlocacao(pool, { movimentoId, competenciaId: janeiro, valorCentavos: parte });
  await criarAlocacao(pool, { movimentoId, competenciaId: fevereiro, valorCentavos: parte });

  const resumo = await calcularResumoDoMovimento(pool, movimentoId);

  assert.equal(typeof resumo.alocadoCentavos, 'number');
  assert.equal(resumo.alocadoCentavos, parte * 2, 'soma exata, centavo a centavo');
  assert.ok(Number.isSafeInteger(resumo.alocadoCentavos));
  assert.equal(resumo.naoAlocadoCentavos, total - parte * 2);
});

test('PG L18: soma fora da faixa segura falha ruidosamente, sem arredondar', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const janeiro = await criarCompetencia(pool, { ano: 2026, mes: 1 });
  const fevereiro = await criarCompetencia(pool, { ano: 2026, mes: 2 });
  const movimentoId = await criarMovimento(pool, { valorCentavos: 1000, associadoId });
  // Cada parcela cabe com folga na faixa segura; a SOMA nao cabe.
  const parcela = 5_000_000_000_000_000;
  await criarAlocacao(pool, { movimentoId, competenciaId: janeiro, valorCentavos: parcela });
  await criarAlocacao(pool, { movimentoId, competenciaId: fevereiro, valorCentavos: parcela });

  await assert.rejects(
    () => calcularResumoDoMovimento(pool, movimentoId),
    (erro) => {
      assert.ok(erro instanceof RangeError, 'valor corrompido tem de explodir, nao arredondar');
      assert.match(erro.message, /faixa segura/i);
      return true;
    }
  );
});

test('PG L19: DATE atravessa como data civil, sem deslocamento de fuso', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  // 1o de janeiro e o caso que mais dói: a leste de Greenwich, promover a
  // instante devolveria 31/12 do ano anterior e mudaria a competencia (M-10).
  const movimentoId = await criarMovimento(pool, { data: '2026-01-01' });

  const movimento = await obterMovimento(pool, movimentoId);

  assert.equal(movimento.data, '2026-01-01');
  assert.equal(typeof movimento.data, 'string');
  assert.ok(!(movimento.data instanceof Date));
});

test('PG L20: timestamps sao string no formato publico, nunca Date', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const competenciaId = await criarCompetencia(pool, { ano: 2026, mes: 1 });
  const movimentoId = await criarMovimento(pool, { associadoId, ativo: false });
  await criarAlocacao(pool, { movimentoId, competenciaId, valorCentavos: 100, ativo: false });

  const [movimento] = await listarMovimentosDoAssociado(pool, associadoId);
  const [alocacao] = movimento.alocacoes;

  for (const instante of [
    movimento.criadoEm,
    movimento.atualizadoEm,
    movimento.inativadoEm,
    alocacao.criadoEm,
    alocacao.atualizadoEm,
    alocacao.inativadoEm,
  ]) {
    assert.equal(typeof instante, 'string', 'Date nao pode vazar para o contrato publico');
    assert.match(instante, TIMESTAMP_RE);
  }
});

test('PG L21: BOOLEAN vira boolean publico nos dois sentidos', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const competenciaId = await criarCompetencia(pool, { ano: 2026, mes: 1 });
  const ativo = await criarMovimento(pool, { data: '2026-01-02', associadoId });
  const inativo = await criarMovimento(pool, { data: '2026-01-01', associadoId, ativo: false });
  await criarAlocacao(pool, { movimentoId: ativo, competenciaId, valorCentavos: 100 });
  await criarAlocacao(pool, { movimentoId: ativo, competenciaId, valorCentavos: 200, ativo: false });

  const extrato = await listarMovimentosDoAssociado(pool, associadoId);

  const mAtivo = extrato.find((m) => m.id === ativo);
  const mInativo = extrato.find((m) => m.id === inativo);
  assert.equal(mAtivo.ativo, true);
  assert.equal(mInativo.ativo, false);
  // Estritamente booleano: nem 1/0, nem truthy.
  for (const valor of [mAtivo.ativo, mInativo.ativo]) {
    assert.equal(typeof valor, 'boolean');
  }
  assert.deepEqual(
    mAtivo.alocacoes.map((a) => a.ativo).sort(),
    [false, true]
  );
});

// =============================================================================
// Read-only e bordas
// =============================================================================

test('PG L22: chamadas repetidas nao alteram nenhuma tabela', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  const competenciaId = await criarCompetencia(pool, { ano: 2026, mes: 1 });
  const movimentoId = await criarMovimento(pool, { associadoId });
  await criarAlocacao(pool, { movimentoId, competenciaId, valorCentavos: 10000 });
  await criarAlocacao(pool, { movimentoId, competenciaId, valorCentavos: 500, ativo: false });
  const naoIdentificado = await criarMovimento(pool);

  const tabelas = ['movimento_financeiro', 'alocacao', 'competencia', 'associado', 'audit_log'];
  const antes = {};
  for (const tabela of tabelas) antes[tabela] = await contar(pool, tabela);

  // Instantes tambem nao podem se mover: leitura nao "toca" registro.
  const { rows: instantesAntes } = await pool.query(
    'SELECT id, criado_em, atualizado_em FROM movimento_financeiro ORDER BY id'
  );

  for (let i = 0; i < 3; i += 1) {
    await obterMovimento(pool, movimentoId);
    await listarAlocacoesDoMovimento(pool, movimentoId, { incluirInativas: true });
    await calcularResumoDoMovimento(pool, movimentoId);
    await listarMovimentosNaoIdentificados(pool);
    await listarMovimentosDoAssociado(pool, associadoId);
    await obterMovimento(pool, naoIdentificado);
  }

  for (const tabela of tabelas) {
    assert.equal(await contar(pool, tabela), antes[tabela], `${tabela} mudou durante leitura`);
  }
  assert.equal(antes.audit_log, 0, 'leitura nao audita');

  const { rows: instantesDepois } = await pool.query(
    'SELECT id, criado_em, atualizado_em FROM movimento_financeiro ORDER BY id'
  );
  assert.deepEqual(
    instantesDepois.map((r) => [r.id, r.criado_em.getTime(), r.atualizado_em.getTime()]),
    instantesAntes.map((r) => [r.id, r.criado_em.getTime(), r.atualizado_em.getTime()])
  );
});

test('PG L23: lote vazio nao produz SQL invalido', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const associadoId = await criarAssociado(pool);
  // Associado com movimento, mas nenhum movimento com alocacao: o lote de
  // alocacoes recebe ids, e o `IN` nao pode ficar vazio nem quebrar.
  await criarMovimento(pool, { associadoId });

  const extrato = await listarMovimentosDoAssociado(pool, associadoId);
  assert.equal(extrato.length, 1);
  assert.deepEqual(extrato[0].alocacoes, []);

  // Fila vazia tambem responde normalmente.
  const semNada = await listarMovimentosNaoIdentificados(pool, { limite: 10 });
  assert.deepEqual(semNada.itens, []);
  assert.equal(semNada.paginacao.total, 0);
});

test('PG L26: id invalido e recusado antes de qualquer consulta', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  for (const invalido of [0, -1, 1.5, '1', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    for (const operacao of [
      () => obterMovimento(pool, invalido),
      () => listarAlocacoesDoMovimento(pool, invalido),
      () => calcularResumoDoMovimento(pool, invalido),
      () => listarMovimentosDoAssociado(pool, invalido),
    ]) {
      await assert.rejects(
        operacao,
        (erro) => erro instanceof LedgerError && erro.codigo === 'id_invalido',
        `id ${String(invalido)} deveria ser recusado`
      );
    }
  }
});
