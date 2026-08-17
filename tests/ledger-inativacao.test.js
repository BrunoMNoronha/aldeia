'use strict';

// Fase 3C - inativacao auditavel de movimento e de alocacao (M-09 / F-11).
//
// O que estes testes provam, em uma frase: corrigir um lancamento NAO apaga
// nada. A linha continua no banco, ganha quando/por que, deixa trilha em
// `audit_log` e — se qualquer parte falhar — o banco volta ao estado anterior.
//
// Provam tambem o que a operacao se RECUSA a fazer: nao ha cascata implicita,
// nao ha idempotencia silenciosa, nao ha reativacao e nao ha DELETE.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registrarMovimento,
  alocarMovimento,
  inativarMovimento,
  inativarAlocacao,
  listarAlocacoesDoMovimento,
  LedgerError,
} = require('../src/services/ledger');
const { createMigratedDb } = require('./helpers/temp-db');

const MOTIVO = 'Lancamento duplicado: o mesmo deposito foi digitado duas vezes';
const MOTIVO_ALOCACAO = 'Competencia incorreta: o pagamento se refere a 2026-05';

/** Timestamp UTC gravado pelo SQLite (strftime), nao pelo Node. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function criarAssociado(db, rotulo = 'Associado de Teste') {
  return Number(db.prepare('INSERT INTO associado (nome) VALUES (?)').run(rotulo).lastInsertRowid);
}

function criarCompetencia(db, ano, mes) {
  return Number(
    db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)').run(ano, mes).lastInsertRowid
  );
}

/** Movimento identificado (alocavel), pronto para os cenarios de correcao. */
function movimentoIdentificado(db, valorCentavos = 12000) {
  return registrarMovimento(db, {
    data: '2026-05-04',
    valorCentavos,
    origem: 'pagamento',
    associadoId: criarAssociado(db),
    observacao: 'pagamento conferido no extrato',
  });
}

function linhaMovimento(db, id) {
  return db.prepare('SELECT * FROM movimento_financeiro WHERE id = ?').get(id);
}

function linhaAlocacao(db, id) {
  return db.prepare('SELECT * FROM alocacao WHERE id = ?').get(id);
}

function contarAuditoria(db, acao = null) {
  return acao === null
    ? db.prepare('SELECT COUNT(*) AS t FROM audit_log').get().t
    : db.prepare('SELECT COUNT(*) AS t FROM audit_log WHERE acao = ?').get(acao).t;
}

/** Marca `atualizado_em` com um valor antigo para provar que o UPDATE o refaz. */
function envelhecerAtualizadoEm(db, tabela, id) {
  const sentinela = '2000-01-01T00:00:00Z';
  db.prepare(`UPDATE ${tabela} SET atualizado_em = ? WHERE id = ?`).run(sentinela, id);
  return sentinela;
}

/** Falha induzida DEPOIS do UPDATE e dentro da mesma transacao. */
function comAuditoriaQuebrada(db, executar) {
  db.exec(`
    CREATE TRIGGER falha_induzida_audit BEFORE INSERT ON audit_log
    BEGIN SELECT RAISE(ABORT, 'falha induzida na auditoria'); END
  `);
  try {
    executar();
  } finally {
    db.exec('DROP TRIGGER falha_induzida_audit');
  }
}

// --- I1..I5: inativacao valida de movimento ---------------------------------

test('I1: movimento ativo e inativado com timestamp, motivo e atualizado_em', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db);
  const sentinela = envelhecerAtualizadoEm(ctx.db, 'movimento_financeiro', movimento.id);

  const resultado = inativarMovimento(ctx.db, { movimentoId: movimento.id, motivo: MOTIVO });

  const depois = linhaMovimento(ctx.db, movimento.id);
  assert.equal(depois.ativo, 0);
  assert.match(depois.inativado_em, TIMESTAMP_RE);
  assert.equal(depois.motivo_inativacao, MOTIVO);
  assert.notEqual(depois.atualizado_em, sentinela, 'atualizado_em precisa ser refeito');
  assert.equal(depois.atualizado_em, depois.inativado_em, 'mesmo instante, mesmo statement');

  assert.equal(resultado.ativo, false);
  assert.equal(resultado.inativadoEm, depois.inativado_em);
  assert.equal(resultado.motivoInativacao, MOTIVO);
  assert.deepEqual(resultado.alocacoes, []);
});

test('I2: o movimento inativado continua fisicamente no banco', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db);
  inativarMovimento(ctx.db, { movimentoId: movimento.id, motivo: MOTIVO });

  assert.equal(
    ctx.db.prepare('SELECT COUNT(*) AS t FROM movimento_financeiro WHERE id = ?').get(movimento.id).t,
    1,
    'inativar nao pode remover a linha (M-09)'
  );
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM movimento_financeiro').get().t, 1);
});

test('I3: nenhum campo financeiro ou de vinculo e alterado pela inativacao', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db, 15037);
  const antes = linhaMovimento(ctx.db, movimento.id);

  inativarMovimento(ctx.db, { movimentoId: movimento.id, motivo: MOTIVO });

  const depois = linhaMovimento(ctx.db, movimento.id);
  for (const coluna of [
    'data',
    'valor_centavos',
    'tipo',
    'origem',
    'associado_id',
    'observacao',
    'estado_identificacao',
    'criado_em',
  ]) {
    assert.deepEqual(depois[coluna], antes[coluna], `${coluna} nao pode mudar`);
  }
  assert.equal(depois.valor_centavos, 15037, 'centavos inteiros intactos (T-06)');
});

test('I4: inativacao valida gera exatamente um audit_log', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db);
  const auditoriaAntes = contarAuditoria(ctx.db);

  inativarMovimento(ctx.db, { movimentoId: movimento.id, motivo: MOTIVO, ator: 'operador' });

  assert.equal(contarAuditoria(ctx.db, 'movimento_financeiro.inativado'), 1);
  assert.equal(contarAuditoria(ctx.db), auditoriaAntes + 1, 'nenhuma auditoria colateral');
});

test('I5: a auditoria mostra estado anterior, posterior e metadados da decisao', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db);
  inativarMovimento(ctx.db, { movimentoId: movimento.id, motivo: MOTIVO, ator: 'operador' });

  const registro = ctx.db
    .prepare("SELECT * FROM audit_log WHERE acao = 'movimento_financeiro.inativado'")
    .get();

  assert.equal(registro.entidade_tipo, 'movimento_financeiro');
  assert.equal(registro.entidade_id, String(movimento.id));
  assert.equal(registro.ator, 'operador');

  const anterior = JSON.parse(registro.estado_anterior);
  assert.equal(anterior.ativo, true);
  assert.equal(anterior.inativadoEm, null);
  assert.equal(anterior.motivoInativacao, null);

  const posterior = JSON.parse(registro.estado_posterior);
  assert.equal(posterior.ativo, false);
  assert.match(posterior.inativadoEm, TIMESTAMP_RE);
  assert.equal(posterior.motivoInativacao, MOTIVO);

  // O valor nao muda entre o antes e o depois: inativar nao e recalcular.
  assert.equal(anterior.valorCentavos, posterior.valorCentavos);
  assert.equal(anterior.associadoId, posterior.associadoId);

  const metadados = JSON.parse(registro.metadados);
  assert.equal(metadados.motivo, MOTIVO);
  assert.equal(metadados.origemRegistro, 'manual');
  assert.equal(metadados.movimentoId, movimento.id);

  // O motivo tem campo proprio e NAO contamina a observacao financeira.
  assert.equal(linhaMovimento(ctx.db, movimento.id).observacao, 'pagamento conferido no extrato');
});

// --- I6..I10: entradas e estados recusados ----------------------------------

test('I6: motivo ausente ou vazio e recusado, sem tocar no movimento', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db);

  for (const motivo of [undefined, null, '', '   ', 42]) {
    assert.throws(
      () => inativarMovimento(ctx.db, { movimentoId: movimento.id, motivo }),
      (error) =>
        error instanceof LedgerError &&
        ['motivo_obrigatorio', 'campo_invalido'].includes(error.codigo),
      `motivo deveria ter sido recusado: ${JSON.stringify(motivo)}`
    );
  }

  assert.equal(linhaMovimento(ctx.db, movimento.id).ativo, 1);
  assert.equal(contarAuditoria(ctx.db, 'movimento_financeiro.inativado'), 0);
});

test('I7: movimentoId invalido e recusado antes de qualquer gravacao', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db);

  for (const movimentoId of ['1', 1.5, 0, -1, null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(
      () => inativarMovimento(ctx.db, { movimentoId, motivo: MOTIVO }),
      (error) => error instanceof LedgerError && error.codigo === 'id_invalido',
      `movimentoId deveria ter sido recusado: ${JSON.stringify(movimentoId)}`
    );
  }

  assert.equal(linhaMovimento(ctx.db, movimento.id).ativo, 1);
  assert.equal(contarAuditoria(ctx.db, 'movimento_financeiro.inativado'), 0);
});

test('I8: movimento inexistente responde movimento_inexistente sem efeito colateral', (t) => {
  const ctx = createMigratedDb(t);

  assert.throws(
    () => inativarMovimento(ctx.db, { movimentoId: 987654, motivo: MOTIVO }),
    (error) => error instanceof LedgerError && error.codigo === 'movimento_inexistente'
  );

  assert.equal(contarAuditoria(ctx.db), 0);
  assert.equal(ctx.db.inTransaction, false);
});

test('I9: movimento ja inativo e recusado — sem idempotencia silenciosa', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db);
  inativarMovimento(ctx.db, { movimentoId: movimento.id, motivo: MOTIVO });
  const primeiraInativacao = linhaMovimento(ctx.db, movimento.id);

  assert.throws(
    () => inativarMovimento(ctx.db, { movimentoId: movimento.id, motivo: 'outro motivo qualquer' }),
    (error) => error instanceof LedgerError && error.codigo === 'movimento_inativo'
  );

  const depois = linhaMovimento(ctx.db, movimento.id);
  assert.equal(depois.inativado_em, primeiraInativacao.inativado_em, 'timestamp original preservado');
  assert.equal(depois.motivo_inativacao, MOTIVO, 'o motivo original nao e sobrescrito');
  assert.equal(depois.atualizado_em, primeiraInativacao.atualizado_em);
});

test('I10: a segunda tentativa de inativacao nao cria auditoria', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db);
  inativarMovimento(ctx.db, { movimentoId: movimento.id, motivo: MOTIVO });
  const auditoriaAposPrimeira = contarAuditoria(ctx.db);

  assert.throws(
    () => inativarMovimento(ctx.db, { movimentoId: movimento.id, motivo: 'tentativa repetida' }),
    (error) => error instanceof LedgerError && error.codigo === 'movimento_inativo'
  );

  assert.equal(contarAuditoria(ctx.db), auditoriaAposPrimeira);
  assert.equal(contarAuditoria(ctx.db, 'movimento_financeiro.inativado'), 1);
  assert.equal(
    ctx.db.prepare("SELECT COUNT(*) AS t FROM audit_log WHERE metadados LIKE '%tentativa repetida%'").get().t,
    0
  );
});

// --- I11 / I12: sem cascata --------------------------------------------------

test('I11: movimento com alocacao ativa e recusado (sem cascata implicita)', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = registrarMovimento(ctx.db, {
    data: '2026-05-04',
    valorCentavos: 8000,
    origem: 'pagamento',
    associadoId: criarAssociado(ctx.db),
    alocacoes: [{ competenciaId: criarCompetencia(ctx.db, 2026, 5), valorCentavos: 8000 }],
  });
  const auditoriaAntes = contarAuditoria(ctx.db);

  assert.throws(
    () => inativarMovimento(ctx.db, { movimentoId: movimento.id, motivo: MOTIVO }),
    (error) => error instanceof LedgerError && error.codigo === 'movimento_possui_alocacoes_ativas'
  );

  assert.equal(linhaMovimento(ctx.db, movimento.id).ativo, 1, 'o movimento continua ativo');
  assert.equal(
    ctx.db.prepare('SELECT ativo FROM alocacao WHERE movimento_id = ?').get(movimento.id).ativo,
    1,
    'a alocacao nao pode ser inativada por tabela'
  );
  assert.equal(contarAuditoria(ctx.db), auditoriaAntes, 'tentativa recusada nao audita nada');
});

test('I12: movimento com apenas alocacoes inativas pode ser inativado', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = registrarMovimento(ctx.db, {
    data: '2026-05-04',
    valorCentavos: 8000,
    origem: 'pagamento',
    associadoId: criarAssociado(ctx.db),
    alocacoes: [{ competenciaId: criarCompetencia(ctx.db, 2026, 5), valorCentavos: 8000 }],
  });
  const alocacaoId = movimento.alocacoes[0].id;

  // Ordem suportada: primeiro a alocacao (com o proprio motivo), depois o movimento.
  inativarAlocacao(ctx.db, { alocacaoId, motivo: MOTIVO_ALOCACAO });
  const resultado = inativarMovimento(ctx.db, { movimentoId: movimento.id, motivo: MOTIVO });

  assert.equal(resultado.ativo, false);
  assert.equal(linhaMovimento(ctx.db, movimento.id).ativo, 0);
  assert.equal(linhaAlocacao(ctx.db, alocacaoId).ativo, 0, 'a alocacao inativa continua la');

  const metadados = JSON.parse(
    ctx.db.prepare("SELECT metadados FROM audit_log WHERE acao = 'movimento_financeiro.inativado'").get()
      .metadados
  );
  assert.equal(metadados.alocacoesPreservadas, 1, 'a linha historica foi preservada');
  assert.equal(metadados.alocacoesAtivas, 0);
});

// --- I13: atomicidade (T-07) -------------------------------------------------

test('I13: falha da auditoria desfaz integralmente a inativacao do movimento', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = movimentoIdentificado(ctx.db);
  const antes = linhaMovimento(ctx.db, movimento.id);
  // Baseline: o registro do movimento ja auditou a CRIACAO dele.
  const auditoriaAntes = contarAuditoria(ctx.db);

  comAuditoriaQuebrada(ctx.db, () => {
    assert.throws(
      () => inativarMovimento(ctx.db, { movimentoId: movimento.id, motivo: MOTIVO }),
      /falha induzida na auditoria/
    );
  });

  const depois = linhaMovimento(ctx.db, movimento.id);
  assert.equal(depois.ativo, 1, 'o movimento nao pode ficar inativo sem trilha');
  assert.equal(depois.inativado_em, null);
  assert.equal(depois.motivo_inativacao, null);
  assert.equal(depois.atualizado_em, antes.atualizado_em);
  assert.equal(contarAuditoria(ctx.db), auditoriaAntes, 'nenhuma auditoria parcial');
  assert.equal(contarAuditoria(ctx.db, 'movimento_financeiro.inativado'), 0);
  assert.equal(ctx.db.inTransaction, false);

  // O caminho continua disponivel depois que a auditoria volta a funcionar.
  inativarMovimento(ctx.db, { movimentoId: movimento.id, motivo: MOTIVO });
  assert.equal(linhaMovimento(ctx.db, movimento.id).ativo, 0);
});

// --- I14..I17: inativacao valida de alocacao ---------------------------------

/** Movimento com UMA alocacao ativa; devolve os dois ids e a competencia. */
function movimentoComAlocacao(db, { valorCentavos = 8000, alocado = 8000, ano = 2026, mes = 4 } = {}) {
  const competenciaId = criarCompetencia(db, ano, mes);
  const movimento = registrarMovimento(db, {
    data: '2026-04-10',
    valorCentavos,
    origem: 'pagamento',
    associadoId: criarAssociado(db),
    alocacoes: [{ competenciaId, valorCentavos: alocado, observacao: 'alocacao original' }],
  });
  return { movimentoId: movimento.id, alocacaoId: movimento.alocacoes[0].id, competenciaId };
}

test('I14: alocacao ativa e inativada com timestamp, motivo e atualizado_em', (t) => {
  const ctx = createMigratedDb(t);

  const { alocacaoId } = movimentoComAlocacao(ctx.db);
  const sentinela = envelhecerAtualizadoEm(ctx.db, 'alocacao', alocacaoId);

  const resultado = inativarAlocacao(ctx.db, { alocacaoId, motivo: MOTIVO_ALOCACAO });

  const depois = linhaAlocacao(ctx.db, alocacaoId);
  assert.equal(depois.ativo, 0);
  assert.match(depois.inativado_em, TIMESTAMP_RE);
  assert.equal(depois.motivo_inativacao, MOTIVO_ALOCACAO);
  assert.notEqual(depois.atualizado_em, sentinela);
  assert.equal(depois.atualizado_em, depois.inativado_em);

  assert.equal(resultado.ativo, false);
  assert.equal(resultado.motivoInativacao, MOTIVO_ALOCACAO);
  // F-08: o resumo do movimento passa a contar so o que continua ativo.
  assert.equal(resultado.resumo.alocadoCentavos, 0);
  assert.equal(resultado.resumo.quantidadeAlocacoes, 0);
});

test('I15: a alocacao inativada continua fisicamente no banco', (t) => {
  const ctx = createMigratedDb(t);

  const { alocacaoId } = movimentoComAlocacao(ctx.db);
  inativarAlocacao(ctx.db, { alocacaoId, motivo: MOTIVO_ALOCACAO });

  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM alocacao WHERE id = ?').get(alocacaoId).t, 1);
  assert.notEqual(linhaAlocacao(ctx.db, alocacaoId), undefined);
});

test('I16: vinculos e valor da alocacao permanecem intactos, e o movimento nao e tocado', (t) => {
  const ctx = createMigratedDb(t);

  const { movimentoId, alocacaoId, competenciaId } = movimentoComAlocacao(ctx.db, {
    valorCentavos: 12000,
    alocado: 5000,
  });
  const alocacaoAntes = linhaAlocacao(ctx.db, alocacaoId);
  const movimentoAntes = linhaMovimento(ctx.db, movimentoId);

  inativarAlocacao(ctx.db, { alocacaoId, motivo: MOTIVO_ALOCACAO });

  const depois = linhaAlocacao(ctx.db, alocacaoId);
  assert.equal(depois.movimento_id, movimentoId);
  assert.equal(depois.competencia_id, competenciaId);
  assert.equal(depois.valor_centavos, 5000);
  assert.equal(depois.observacao, alocacaoAntes.observacao);
  assert.equal(depois.criado_em, alocacaoAntes.criado_em);

  // Inativar alocacao NAO inativa o movimento: sao decisoes separadas.
  assert.deepEqual(linhaMovimento(ctx.db, movimentoId), movimentoAntes);
});

test('I17: inativacao de alocacao gera exatamente uma auditoria, com antes e depois', (t) => {
  const ctx = createMigratedDb(t);

  const { movimentoId, alocacaoId } = movimentoComAlocacao(ctx.db, { valorCentavos: 8000, alocado: 8000 });
  const auditoriaAntes = contarAuditoria(ctx.db);

  inativarAlocacao(ctx.db, { alocacaoId, motivo: MOTIVO_ALOCACAO, ator: 'operador' });

  assert.equal(contarAuditoria(ctx.db, 'alocacao.inativada'), 1);
  assert.equal(contarAuditoria(ctx.db), auditoriaAntes + 1);

  const registro = ctx.db.prepare("SELECT * FROM audit_log WHERE acao = 'alocacao.inativada'").get();
  assert.equal(registro.entidade_tipo, 'alocacao');
  assert.equal(registro.entidade_id, String(alocacaoId));
  assert.equal(registro.ator, 'operador');

  const anterior = JSON.parse(registro.estado_anterior);
  assert.equal(anterior.ativo, true);
  assert.equal(anterior.inativadoEm, null);
  assert.equal(anterior.motivoInativacao, null);

  const posterior = JSON.parse(registro.estado_posterior);
  assert.equal(posterior.ativo, false);
  assert.match(posterior.inativadoEm, TIMESTAMP_RE);
  assert.equal(posterior.motivoInativacao, MOTIVO_ALOCACAO);
  assert.equal(anterior.valorCentavos, posterior.valorCentavos);
  assert.equal(anterior.competenciaId, posterior.competenciaId);

  const metadados = JSON.parse(registro.metadados);
  assert.equal(metadados.motivo, MOTIVO_ALOCACAO);
  assert.equal(metadados.origemRegistro, 'manual');
  assert.equal(metadados.movimentoId, movimentoId);
  assert.equal(metadados.competencia, '2026-04');
});

// --- I18..I21: entradas e estados recusados na alocacao ----------------------

test('I18: motivo e obrigatorio tambem na inativacao de alocacao', (t) => {
  const ctx = createMigratedDb(t);

  const { alocacaoId } = movimentoComAlocacao(ctx.db);

  for (const motivo of [undefined, null, '', '   ']) {
    assert.throws(
      () => inativarAlocacao(ctx.db, { alocacaoId, motivo }),
      (error) => error instanceof LedgerError && error.codigo === 'motivo_obrigatorio',
      `motivo deveria ter sido recusado: ${JSON.stringify(motivo)}`
    );
  }

  for (const alocacaoIdInvalido of ['1', 1.5, 0, -1, null, undefined]) {
    assert.throws(
      () => inativarAlocacao(ctx.db, { alocacaoId: alocacaoIdInvalido, motivo: MOTIVO_ALOCACAO }),
      (error) => error instanceof LedgerError && error.codigo === 'id_invalido'
    );
  }

  assert.equal(linhaAlocacao(ctx.db, alocacaoId).ativo, 1);
  assert.equal(contarAuditoria(ctx.db, 'alocacao.inativada'), 0);
});

test('I19: alocacao inexistente responde alocacao_inexistente', (t) => {
  const ctx = createMigratedDb(t);

  movimentoComAlocacao(ctx.db);
  const auditoriaAntes = contarAuditoria(ctx.db);

  assert.throws(
    () => inativarAlocacao(ctx.db, { alocacaoId: 987654, motivo: MOTIVO_ALOCACAO }),
    (error) => error instanceof LedgerError && error.codigo === 'alocacao_inexistente'
  );

  assert.equal(contarAuditoria(ctx.db), auditoriaAntes);
  assert.equal(ctx.db.inTransaction, false);
});

test('I20: alocacao ja inativa e recusada, preservando timestamp e motivo originais', (t) => {
  const ctx = createMigratedDb(t);

  const { alocacaoId } = movimentoComAlocacao(ctx.db);
  inativarAlocacao(ctx.db, { alocacaoId, motivo: MOTIVO_ALOCACAO });
  const primeira = linhaAlocacao(ctx.db, alocacaoId);

  assert.throws(
    () => inativarAlocacao(ctx.db, { alocacaoId, motivo: 'segunda tentativa' }),
    (error) => error instanceof LedgerError && error.codigo === 'alocacao_inativa'
  );

  const depois = linhaAlocacao(ctx.db, alocacaoId);
  assert.equal(depois.inativado_em, primeira.inativado_em);
  assert.equal(depois.motivo_inativacao, MOTIVO_ALOCACAO);
  assert.equal(depois.atualizado_em, primeira.atualizado_em);
});

test('I21: a segunda tentativa na alocacao nao cria auditoria', (t) => {
  const ctx = createMigratedDb(t);

  const { alocacaoId } = movimentoComAlocacao(ctx.db);
  inativarAlocacao(ctx.db, { alocacaoId, motivo: MOTIVO_ALOCACAO });
  const auditoriaAposPrimeira = contarAuditoria(ctx.db);

  assert.throws(
    () => inativarAlocacao(ctx.db, { alocacaoId, motivo: 'segunda tentativa' }),
    (error) => error instanceof LedgerError && error.codigo === 'alocacao_inativa'
  );

  assert.equal(contarAuditoria(ctx.db), auditoriaAposPrimeira);
  assert.equal(contarAuditoria(ctx.db, 'alocacao.inativada'), 1);
});

// --- I22: atomicidade da alocacao -------------------------------------------

test('I22: falha da auditoria desfaz integralmente a inativacao da alocacao', (t) => {
  const ctx = createMigratedDb(t);

  const { alocacaoId } = movimentoComAlocacao(ctx.db);
  const antes = linhaAlocacao(ctx.db, alocacaoId);
  // Baseline: criacao do movimento e da alocacao ja auditadas.
  const auditoriaAntes = contarAuditoria(ctx.db);

  comAuditoriaQuebrada(ctx.db, () => {
    assert.throws(
      () => inativarAlocacao(ctx.db, { alocacaoId, motivo: MOTIVO_ALOCACAO }),
      /falha induzida na auditoria/
    );
  });

  const depois = linhaAlocacao(ctx.db, alocacaoId);
  assert.equal(depois.ativo, 1, 'a alocacao nao pode ficar inativa sem trilha');
  assert.equal(depois.inativado_em, null);
  assert.equal(depois.motivo_inativacao, null);
  assert.equal(depois.atualizado_em, antes.atualizado_em);
  assert.equal(contarAuditoria(ctx.db), auditoriaAntes, 'nenhuma auditoria parcial');
  assert.equal(contarAuditoria(ctx.db, 'alocacao.inativada'), 0);
  assert.equal(ctx.db.inTransaction, false);
});

// --- I23 / I24: correcao sem perda de historico ------------------------------

test('I23: apos inativar, o mesmo movimento+competencia aceita nova alocacao ativa', (t) => {
  const ctx = createMigratedDb(t);

  const { movimentoId, alocacaoId, competenciaId } = movimentoComAlocacao(ctx.db, {
    valorCentavos: 8000,
    alocado: 8000,
  });

  // Com a alocacao ativa, o par movimento+competencia esta ocupado.
  assert.throws(
    () => alocarMovimento(ctx.db, { movimentoId, competenciaId, valorCentavos: 8000 }),
    (error) => error instanceof LedgerError && error.codigo === 'alocacao_duplicada'
  );

  inativarAlocacao(ctx.db, { alocacaoId, motivo: MOTIVO_ALOCACAO });

  const nova = alocarMovimento(ctx.db, { movimentoId, competenciaId, valorCentavos: 8000 });

  assert.notEqual(nova.id, alocacaoId, 'a correcao cria uma nova linha, nao reescreve a antiga');
  assert.equal(nova.ativo, true);
  assert.equal(nova.resumo.alocadoCentavos, 8000, 'o saldo voltou a ser contado uma unica vez');
  assert.equal(nova.resumo.quantidadeAlocacoes, 1);
});

test('I24: o historico continua com a alocacao inativa ao lado da nova', (t) => {
  const ctx = createMigratedDb(t);

  const { movimentoId, alocacaoId, competenciaId } = movimentoComAlocacao(ctx.db, {
    valorCentavos: 8000,
    alocado: 8000,
  });
  inativarAlocacao(ctx.db, { alocacaoId, motivo: MOTIVO_ALOCACAO });
  const nova = alocarMovimento(ctx.db, { movimentoId, competenciaId, valorCentavos: 8000 });

  const historico = ctx.db
    .prepare('SELECT id, ativo, motivo_inativacao FROM alocacao WHERE movimento_id = ? ORDER BY id')
    .all(movimentoId);

  assert.deepEqual(
    historico.map((linha) => [linha.id, linha.ativo]),
    [
      [alocacaoId, 0],
      [nova.id, 1],
    ],
    'as duas linhas coexistem: a corrigida e a corretiva'
  );
  assert.equal(historico[0].motivo_inativacao, MOTIVO_ALOCACAO);

  // A leitura padrao serve so as ativas; o historico e pedido explicitamente.
  assert.deepEqual(
    listarAlocacoesDoMovimento(ctx.db, movimentoId).map((alocacao) => alocacao.id),
    [nova.id]
  );
  assert.deepEqual(
    listarAlocacoesDoMovimento(ctx.db, movimentoId, { incluirInativas: true }).map((a) => a.id),
    [alocacaoId, nova.id]
  );
});
