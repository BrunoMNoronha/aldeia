'use strict';

// Fase 2A - nucleo financeiro transacional: movimento + alocacao.
//
// Todos os valores destes testes sao arbitrarios e servem apenas para exercitar
// as invariantes. Nenhum deles vem da planilha, do diagnostico legado ou de
// qualquer total herdado.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  registrarMovimento,
  obterMovimento,
  alocarMovimento,
  listarAlocacoesDoMovimento,
  calcularResumoDoMovimento,
  LedgerError,
} = require('../src/services/ledger');
const { createMigratedDb } = require('./helpers/temp-db');

function criarAssociado(db, nome = 'Associado de Teste') {
  return Number(db.prepare('INSERT INTO associado (nome) VALUES (?)').run(nome).lastInsertRowid);
}

function criarCompetencia(db, ano, mes) {
  return Number(
    db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)').run(ano, mes).lastInsertRowid
  );
}

function contarAuditoria(db, filtro = {}) {
  if (filtro.acao !== undefined) {
    return db.prepare('SELECT COUNT(*) AS t FROM audit_log WHERE acao = ?').get(filtro.acao).t;
  }
  return db.prepare('SELECT COUNT(*) AS t FROM audit_log').get().t;
}

/** Movimento identificado (com associado), pronto para receber alocacao. */
function movimentoIdentificado(db, valorCentavos, extras = {}) {
  return registrarMovimento(db, {
    data: '2026-03-10',
    valorCentavos,
    origem: 'pagamento',
    associadoId: criarAssociado(db),
    ...extras,
  });
}

// --- T1 / T2: dinheiro em centavos inteiros (T-06) --------------------------

test('T1: movimento de 15035 centavos preserva exatamente 15035', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db, 15035);

  assert.equal(movimento.valorCentavos, 15035);

  const persistido = ctx.db
    .prepare('SELECT valor_centavos, typeof(valor_centavos) AS tipo FROM movimento_financeiro WHERE id = ?')
    .get(movimento.id);

  assert.equal(persistido.tipo, 'integer');
  assert.equal(persistido.valor_centavos, 15035);
  assert.equal(obterMovimento(ctx.db, movimento.id).valorCentavos, 15035);
});

test('T2: valor decimal nao entra como fonte de verdade', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);

  for (const valor of [150.35, 0.01, '15035', null, undefined, NaN, Infinity]) {
    assert.throws(
      () =>
        registrarMovimento(ctx.db, {
          data: '2026-03-10',
          valorCentavos: valor,
          origem: 'pagamento',
          associadoId,
        }),
      (error) => error instanceof LedgerError && error.codigo === 'valor_nao_inteiro',
      `valor deveria ter sido recusado: ${String(valor)}`
    );
  }

  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM movimento_financeiro').get().t, 0);
  assert.equal(contarAuditoria(ctx.db), 0);
});

test('T2b: alocacao com valor decimal tambem e recusada', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db, 12000);
  const competenciaId = criarCompetencia(ctx.db, 2026, 3);

  assert.throws(
    () => alocarMovimento(ctx.db, { movimentoId: movimento.id, competenciaId, valorCentavos: 40.5 }),
    (error) => error instanceof LedgerError && error.codigo === 'valor_nao_inteiro'
  );
  assert.equal(calcularResumoDoMovimento(ctx.db, movimento.id).alocadoCentavos, 0);
});

// --- T3: movimento sem alocacao --------------------------------------------

test('T3: movimento pode existir sem nenhuma alocacao', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db, 4000);

  assert.deepEqual(movimento.alocacoes, []);
  assert.deepEqual(listarAlocacoesDoMovimento(ctx.db, movimento.id), []);
  assert.deepEqual(calcularResumoDoMovimento(ctx.db, movimento.id), {
    movimentoId: movimento.id,
    totalCentavos: 4000,
    alocadoCentavos: 0,
    naoAlocadoCentavos: 4000,
    quantidadeAlocacoes: 0,
    integralmenteAlocado: false,
  });
});

// --- T4 / T8: um movimento atende varias competencias (M-02) ----------------

test('T4: movimento de 12000 e dividido em 4000 + 4000 + 4000', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db, 12000);
  const competencias = [1, 2, 3].map((mes) => criarCompetencia(ctx.db, 2026, mes));

  for (const competenciaId of competencias) {
    alocarMovimento(ctx.db, { movimentoId: movimento.id, competenciaId, valorCentavos: 4000 });
  }

  const resumo = calcularResumoDoMovimento(ctx.db, movimento.id);
  assert.equal(resumo.totalCentavos, 12000);
  assert.equal(resumo.alocadoCentavos, 12000);
  assert.equal(resumo.naoAlocadoCentavos, 0);
  assert.equal(resumo.integralmenteAlocado, true);
  assert.equal(listarAlocacoesDoMovimento(ctx.db, movimento.id).length, 3);
});

test('T8: um movimento atende duas ou mais competencias em uma unica operacao', (t) => {
  const ctx = createMigratedDb(t);

  const competenciaA = criarCompetencia(ctx.db, 2026, 5);
  const competenciaB = criarCompetencia(ctx.db, 2026, 6);

  const movimento = movimentoIdentificado(ctx.db, 8000, {
    alocacoes: [
      { competenciaId: competenciaA, valorCentavos: 4000 },
      { competenciaId: competenciaB, valorCentavos: 4000 },
    ],
  });

  assert.equal(movimento.alocacoes.length, 2);
  assert.deepEqual(
    movimento.alocacoes.map((a) => a.competenciaId).sort((x, y) => x - y),
    [competenciaA, competenciaB].sort((x, y) => x - y)
  );
  assert.equal(movimento.resumo.naoAlocadoCentavos, 0);
});

// --- T5 / T6: teto do movimento e ausencia de efeito parcial ----------------

test('T5: alocacao que ultrapassa o valor do movimento e rejeitada', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db, 12000);
  const competenciaA = criarCompetencia(ctx.db, 2026, 7);
  const competenciaB = criarCompetencia(ctx.db, 2026, 8);

  alocarMovimento(ctx.db, { movimentoId: movimento.id, competenciaId: competenciaA, valorCentavos: 8000 });

  assert.throws(
    () =>
      alocarMovimento(ctx.db, {
        movimentoId: movimento.id,
        competenciaId: competenciaB,
        valorCentavos: 4001,
      }),
    (error) => error instanceof LedgerError && error.codigo === 'alocacao_excede_movimento'
  );

  assert.equal(calcularResumoDoMovimento(ctx.db, movimento.id).alocadoCentavos, 8000);
});

test('T6: apos a rejeicao por excesso nada parcial sobrevive', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db, 12000);
  const competenciaA = criarCompetencia(ctx.db, 2026, 9);
  const competenciaB = criarCompetencia(ctx.db, 2026, 10);

  alocarMovimento(ctx.db, { movimentoId: movimento.id, competenciaId: competenciaA, valorCentavos: 8000 });

  const alocacoesAntes = listarAlocacoesDoMovimento(ctx.db, movimento.id);
  const auditoriaAntes = contarAuditoria(ctx.db);

  assert.throws(() =>
    alocarMovimento(ctx.db, {
      movimentoId: movimento.id,
      competenciaId: competenciaB,
      valorCentavos: 4001,
    })
  );

  // alocacao anterior permanece; a nova nao existe; nao ha audit_log da tentativa.
  assert.deepEqual(listarAlocacoesDoMovimento(ctx.db, movimento.id), alocacoesAntes);
  assert.equal(
    ctx.db.prepare('SELECT COUNT(*) AS t FROM alocacao WHERE competencia_id = ?').get(competenciaB).t,
    0
  );
  assert.equal(contarAuditoria(ctx.db), auditoriaAntes);
  assert.equal(ctx.db.inTransaction, false);
});

// --- T7: uma competencia recebe varios movimentos (M-02) --------------------

test('T7: uma competencia recebe pagamentos de dois movimentos diferentes', (t) => {
  const ctx = createMigratedDb(t);

  const competenciaId = criarCompetencia(ctx.db, 2026, 11);
  const primeiro = movimentoIdentificado(ctx.db, 2500);
  const segundo = movimentoIdentificado(ctx.db, 1500);

  alocarMovimento(ctx.db, { movimentoId: primeiro.id, competenciaId, valorCentavos: 2500 });
  alocarMovimento(ctx.db, { movimentoId: segundo.id, competenciaId, valorCentavos: 1500 });

  const total = ctx.db
    .prepare('SELECT COUNT(*) AS t, SUM(valor_centavos) AS soma FROM alocacao WHERE competencia_id = ? AND ativo = 1')
    .get(competenciaId);

  assert.equal(total.t, 2);
  assert.equal(total.soma, 4000);
});

// --- T9: saldo nao alocado (F-08) ------------------------------------------

test('T9: movimento parcialmente alocado informa o saldo nao alocado', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db, 15035);
  const competencias = [1, 2, 3].map((mes) => criarCompetencia(ctx.db, 2027, mes));

  for (const competenciaId of competencias) {
    alocarMovimento(ctx.db, { movimentoId: movimento.id, competenciaId, valorCentavos: 4000 });
  }

  const resumo = calcularResumoDoMovimento(ctx.db, movimento.id);
  assert.equal(resumo.totalCentavos, 15035);
  assert.equal(resumo.alocadoCentavos, 12000);
  assert.equal(resumo.naoAlocadoCentavos, 3035);
  // parcial nao e erro: o movimento continua valido e alocavel.
  assert.equal(resumo.integralmenteAlocado, false);
  assert.equal(obterMovimento(ctx.db, movimento.id).resumo.naoAlocadoCentavos, 3035);
});

// --- T10 / T11: deposito nao identificado (M-05) ---------------------------

test('T10: movimento sem associado pode ser criado como nao identificado', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = registrarMovimento(ctx.db, {
    data: '2026-04-02',
    valorCentavos: 20000,
    origem: 'deposito',
    observacao: 'deposito sem identificacao do pagador',
  });

  assert.equal(movimento.associadoId, null);
  assert.equal(movimento.estadoIdentificacao, 'nao_identificado');
  assert.equal(movimento.valorCentavos, 20000);
  assert.equal(movimento.resumo.naoAlocadoCentavos, 20000);
});

test('T11: movimento sem associado nao pode ser alocado', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = registrarMovimento(ctx.db, {
    data: '2026-04-02',
    valorCentavos: 20000,
    origem: 'deposito',
  });
  const competenciaId = criarCompetencia(ctx.db, 2026, 4);

  assert.throws(
    () => alocarMovimento(ctx.db, { movimentoId: movimento.id, competenciaId, valorCentavos: 4000 }),
    (error) => error instanceof LedgerError && error.codigo === 'movimento_nao_identificado'
  );

  assert.equal(listarAlocacoesDoMovimento(ctx.db, movimento.id).length, 0);
});

test('T11b: criar movimento nao identificado com alocacao falha por inteiro', (t) => {
  const ctx = createMigratedDb(t);
  const competenciaId = criarCompetencia(ctx.db, 2026, 4);

  assert.throws(
    () =>
      registrarMovimento(ctx.db, {
        data: '2026-04-02',
        valorCentavos: 20000,
        origem: 'deposito',
        alocacoes: [{ competenciaId, valorCentavos: 4000 }],
      }),
    (error) => error instanceof LedgerError && error.codigo === 'movimento_nao_identificado'
  );

  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM movimento_financeiro').get().t, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM alocacao').get().t, 0);
  assert.equal(contarAuditoria(ctx.db), 0);
});

// --- T12 / T13: referencias inexistentes -----------------------------------

test('T12: referencia a associado inexistente e rejeitada', (t) => {
  const ctx = createMigratedDb(t);

  assert.throws(
    () =>
      registrarMovimento(ctx.db, {
        data: '2026-05-01',
        valorCentavos: 4000,
        origem: 'pagamento',
        associadoId: 987654,
      }),
    (error) => error instanceof LedgerError && error.codigo === 'associado_inexistente'
  );

  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM movimento_financeiro').get().t, 0);
  assert.equal(contarAuditoria(ctx.db), 0);
});

test('T13: referencia a competencia inexistente e rejeitada', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db, 4000);

  assert.throws(
    () => alocarMovimento(ctx.db, { movimentoId: movimento.id, competenciaId: 987654, valorCentavos: 4000 }),
    (error) => error instanceof LedgerError && error.codigo === 'competencia_inexistente'
  );

  assert.equal(listarAlocacoesDoMovimento(ctx.db, movimento.id).length, 0);
});

test('T13b: referencia a movimento inexistente e rejeitada', (t) => {
  const ctx = createMigratedDb(t);
  const competenciaId = criarCompetencia(ctx.db, 2026, 12);

  assert.throws(
    () => alocarMovimento(ctx.db, { movimentoId: 987654, competenciaId, valorCentavos: 4000 }),
    (error) => error instanceof LedgerError && error.codigo === 'movimento_inexistente'
  );
  assert.equal(obterMovimento(ctx.db, 987654), null);
});

// --- T14 / T15: valor de alocacao invalido ---------------------------------

test('T14: alocacao de valor zero e rejeitada', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db, 4000);
  const competenciaId = criarCompetencia(ctx.db, 2028, 1);

  assert.throws(
    () => alocarMovimento(ctx.db, { movimentoId: movimento.id, competenciaId, valorCentavos: 0 }),
    (error) => error instanceof LedgerError && error.codigo === 'valor_nao_positivo'
  );
  assert.equal(listarAlocacoesDoMovimento(ctx.db, movimento.id).length, 0);
});

test('T15: alocacao de valor negativo e rejeitada', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db, 4000);
  const competenciaId = criarCompetencia(ctx.db, 2028, 2);

  assert.throws(
    () => alocarMovimento(ctx.db, { movimentoId: movimento.id, competenciaId, valorCentavos: -4000 }),
    (error) => error instanceof LedgerError && error.codigo === 'valor_nao_positivo'
  );
  assert.throws(
    () =>
      registrarMovimento(ctx.db, {
        data: '2026-05-01',
        valorCentavos: -4000,
        origem: 'pagamento',
        associadoId: criarAssociado(ctx.db, 'Outro'),
      }),
    (error) => error instanceof LedgerError && error.codigo === 'valor_nao_positivo'
  );
  assert.equal(listarAlocacoesDoMovimento(ctx.db, movimento.id).length, 0);
});

// --- T16 / T17: auditoria (F-11) -------------------------------------------

test('T16: criacao valida de movimento gera audit_log', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db, 15035, { observacao: 'pagamento em especie' });

  const registro = ctx.db
    .prepare("SELECT * FROM audit_log WHERE entidade_tipo = 'movimento_financeiro'")
    .get();

  assert.ok(registro, 'audit_log do movimento deve existir');
  assert.equal(registro.acao, 'movimento_financeiro.criado');
  assert.equal(registro.entidade_id, String(movimento.id));
  assert.equal(registro.ator, 'sistema');
  assert.equal(registro.estado_anterior, null);
  assert.match(registro.criado_em, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  const estado = JSON.parse(registro.estado_posterior);
  assert.equal(estado.valorCentavos, 15035);
  assert.equal(estado.origem, 'pagamento');
  assert.equal(estado.estadoIdentificacao, 'identificado');

  const metadados = JSON.parse(registro.metadados);
  assert.equal(metadados.origemRegistro, 'manual');
});

test('T17: criacao valida de alocacao gera audit_log', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db, 12000);
  const competenciaId = criarCompetencia(ctx.db, 2026, 2);

  const alocacao = alocarMovimento(ctx.db, {
    movimentoId: movimento.id,
    competenciaId,
    valorCentavos: 4000,
    ator: 'operacao-manual',
  });

  const registro = ctx.db.prepare("SELECT * FROM audit_log WHERE entidade_tipo = 'alocacao'").get();

  assert.ok(registro, 'audit_log da alocacao deve existir');
  assert.equal(registro.acao, 'alocacao.criada');
  assert.equal(registro.entidade_id, String(alocacao.id));
  assert.equal(registro.ator, 'operacao-manual');

  const estado = JSON.parse(registro.estado_posterior);
  assert.equal(estado.valorCentavos, 4000);
  assert.equal(estado.competenciaId, competenciaId);

  const metadados = JSON.parse(registro.metadados);
  assert.equal(metadados.movimentoId, movimento.id);
  assert.equal(metadados.competencia, '2026-02');
  assert.equal(metadados.alocadoCentavos, 4000);
  assert.equal(metadados.naoAlocadoCentavos, 8000);
});

// --- T18: rollback integral (T-07) -----------------------------------------

test('T18: falha no meio de operacao multi-registro nao deixa efeito parcial', (t) => {
  const ctx = createMigratedDb(t);

  const associadoId = criarAssociado(ctx.db);
  const competenciaValida = criarCompetencia(ctx.db, 2029, 1);

  assert.throws(
    () =>
      registrarMovimento(ctx.db, {
        data: '2029-01-10',
        valorCentavos: 12000,
        origem: 'pagamento',
        associadoId,
        alocacoes: [
          { competenciaId: competenciaValida, valorCentavos: 4000 },
          { competenciaId: 987654, valorCentavos: 4000 }, // competencia inexistente
        ],
      }),
    (error) => error instanceof LedgerError && error.codigo === 'competencia_inexistente'
  );

  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM movimento_financeiro').get().t, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM alocacao').get().t, 0);
  assert.equal(contarAuditoria(ctx.db), 0);
  assert.equal(ctx.db.inTransaction, false);
});

test('T18b: excesso na segunda alocacao da criacao conjunta desfaz tudo', (t) => {
  const ctx = createMigratedDb(t);

  const associadoId = criarAssociado(ctx.db);
  const competenciaA = criarCompetencia(ctx.db, 2029, 2);
  const competenciaB = criarCompetencia(ctx.db, 2029, 3);

  assert.throws(
    () =>
      registrarMovimento(ctx.db, {
        data: '2029-02-10',
        valorCentavos: 12000,
        origem: 'pagamento',
        associadoId,
        alocacoes: [
          { competenciaId: competenciaA, valorCentavos: 8000 },
          { competenciaId: competenciaB, valorCentavos: 4001 },
        ],
      }),
    (error) => error instanceof LedgerError && error.codigo === 'alocacao_excede_movimento'
  );

  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM movimento_financeiro').get().t, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM alocacao').get().t, 0);
  assert.equal(contarAuditoria(ctx.db), 0);
});

// --- T19: independencia do legado ------------------------------------------

test('T19: o servico do ledger nao consulta nenhuma tabela do legado', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ledger.js'), 'utf8');

  for (const proibido of ['legacy_cell', 'legacy_cell_link', 'importacao', 'BJ']) {
    assert.equal(
      fonte.includes(proibido),
      false,
      `o ledger nao pode referenciar ${proibido}: o total vem do ledger (F-08)`
    );
  }
});

test('T19b: dado legado presente no banco nao influencia o resumo do ledger', (t) => {
  const ctx = createMigratedDb(t);

  // Proveniencia bruta coexiste no banco e permanece inerte para o ledger.
  const importacaoId = Number(
    ctx.db
      .prepare('INSERT INTO importacao (nome_arquivo, sha256, versao_importador) VALUES (?, ?, ?)')
      .run('planilha.xlsx', 'a'.repeat(64), 'teste/1.0.0').lastInsertRowid
  );
  ctx.db
    .prepare('INSERT INTO legacy_cell (importacao_id, aba, endereco, valor_bruto) VALUES (?, ?, ?, ?)')
    .run(importacaoId, 'Planilha1', 'BJ5', '999999');

  const movimento = movimentoIdentificado(ctx.db, 4000);
  const competenciaId = criarCompetencia(ctx.db, 2030, 1);
  alocarMovimento(ctx.db, { movimentoId: movimento.id, competenciaId, valorCentavos: 2500 });

  const resumo = calcularResumoDoMovimento(ctx.db, movimento.id);
  assert.equal(resumo.totalCentavos, 4000);
  assert.equal(resumo.alocadoCentavos, 2500);
  assert.equal(resumo.naoAlocadoCentavos, 1500);
});

// --- invariantes complementares --------------------------------------------

test('origem manual so aceita pagamento ou deposito', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);

  assert.throws(
    () =>
      registrarMovimento(ctx.db, {
        data: '2026-03-10',
        valorCentavos: 4000,
        origem: 'importacao',
        associadoId,
      }),
    (error) => error instanceof LedgerError && error.codigo === 'origem_invalida'
  );

  const movimento = registrarMovimento(ctx.db, {
    data: '2026-03-10',
    valorCentavos: 4000,
    origem: 'DEPOSITO',
    associadoId,
  });
  assert.equal(movimento.origem, 'deposito');
  // Pagamento e deposito sao entradas: nada de valor negativo nesta fase.
  assert.equal(movimento.tipo, 'credito');
});

test('data invalida e recusada antes de qualquer gravacao', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);

  for (const data of ['2026-13-01', '2026-02-30', '10/03/2026', '', null]) {
    assert.throws(
      () => registrarMovimento(ctx.db, { data, valorCentavos: 4000, origem: 'pagamento', associadoId }),
      (error) => error instanceof LedgerError && error.codigo === 'data_invalida',
      `data deveria ter sido recusada: ${String(data)}`
    );
  }
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM movimento_financeiro').get().t, 0);
});

test('a mesma competencia nao recebe duas alocacoes ativas do mesmo movimento', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db, 12000);
  const competenciaId = criarCompetencia(ctx.db, 2030, 6);

  alocarMovimento(ctx.db, { movimentoId: movimento.id, competenciaId, valorCentavos: 4000 });

  assert.throws(
    () => alocarMovimento(ctx.db, { movimentoId: movimento.id, competenciaId, valorCentavos: 4000 }),
    (error) => error instanceof LedgerError && error.codigo === 'alocacao_duplicada'
  );
  assert.equal(calcularResumoDoMovimento(ctx.db, movimento.id).alocadoCentavos, 4000);
});

test('movimento inativado nao recebe nova alocacao (M-09)', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db, 12000);
  const competenciaId = criarCompetencia(ctx.db, 2030, 7);

  ctx.db
    .prepare(
      'UPDATE movimento_financeiro SET ativo = 0, inativado_em = ?, motivo_inativacao = ? WHERE id = ?'
    )
    .run('2030-07-01T00:00:00Z', 'lancamento duplicado', movimento.id);

  assert.throws(
    () => alocarMovimento(ctx.db, { movimentoId: movimento.id, competenciaId, valorCentavos: 4000 }),
    (error) => error instanceof LedgerError && error.codigo === 'movimento_inativo'
  );

  // M-09: o movimento continua existindo fisicamente.
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM movimento_financeiro').get().t, 1);
});

test('alocacao inativada libera saldo e sai do resumo do ledger', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db, 12000);
  const competenciaId = criarCompetencia(ctx.db, 2030, 8);

  const alocacao = alocarMovimento(ctx.db, {
    movimentoId: movimento.id,
    competenciaId,
    valorCentavos: 12000,
  });

  ctx.db
    .prepare('UPDATE alocacao SET ativo = 0, inativado_em = ?, motivo_inativacao = ? WHERE id = ?')
    .run('2030-08-02T00:00:00Z', 'competencia errada', alocacao.id);

  const resumo = calcularResumoDoMovimento(ctx.db, movimento.id);
  assert.equal(resumo.alocadoCentavos, 0);
  assert.equal(resumo.naoAlocadoCentavos, 12000);

  assert.equal(listarAlocacoesDoMovimento(ctx.db, movimento.id).length, 0);
  assert.equal(listarAlocacoesDoMovimento(ctx.db, movimento.id, { incluirInativas: true }).length, 1);
});
