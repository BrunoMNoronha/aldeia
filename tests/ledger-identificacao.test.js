'use strict';

// Fase 2B - identificacao posterior de movimento nao identificado (M-05 / F-06).
//
// A identificacao e uma ACAO EXPLICITA do operador: o associado chega pelo id
// interno e por mais nada. Estes testes existem em boa parte para provar o que
// a operacao NAO faz — nao adivinha associado por centavos, por nome, por
// legacy_id nem por qualquer dado do legado.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  registrarMovimento,
  obterMovimento,
  alocarMovimento,
  identificarMovimento,
  calcularResumoDoMovimento,
  LedgerError,
} = require('../src/services/ledger');
const { createMigratedDb } = require('./helpers/temp-db');

const MOTIVO = 'Deposito confirmado manualmente apos conferencia do extrato';

function criarAssociado(db, nome = 'Associado de Teste', legacyId = null) {
  return Number(
    db.prepare('INSERT INTO associado (nome, legacy_id) VALUES (?, ?)').run(nome, legacyId)
      .lastInsertRowid
  );
}

function criarCompetencia(db, ano, mes) {
  return Number(
    db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)').run(ano, mes).lastInsertRowid
  );
}

/** Deposito sem associado: nasce `nao_identificado` (M-05). */
function depositoNaoIdentificado(db, valorCentavos = 20000) {
  return registrarMovimento(db, {
    data: '2026-04-02',
    valorCentavos,
    origem: 'deposito',
    observacao: 'deposito sem identificacao do pagador',
  });
}

function linhaMovimento(db, id) {
  return db
    .prepare('SELECT associado_id, estado_identificacao, ativo, observacao FROM movimento_financeiro WHERE id = ?')
    .get(id);
}

function contarAuditoria(db) {
  return db.prepare('SELECT COUNT(*) AS t FROM audit_log').get().t;
}

// --- T1: identificacao valida ----------------------------------------------

test('T1: movimento nao identificado passa a identificado com associado explicito', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = depositoNaoIdentificado(ctx.db);
  const associadoId = criarAssociado(ctx.db);

  const antes = linhaMovimento(ctx.db, movimento.id);
  assert.equal(antes.associado_id, null);
  assert.equal(antes.estado_identificacao, 'nao_identificado');

  const resultado = identificarMovimento(ctx.db, {
    movimentoId: movimento.id,
    associadoId,
    motivo: MOTIVO,
  });

  const depois = linhaMovimento(ctx.db, movimento.id);
  assert.equal(depois.associado_id, associadoId);
  assert.equal(depois.estado_identificacao, 'identificado');
  assert.equal(resultado.associadoId, associadoId);
  assert.equal(resultado.estadoIdentificacao, 'identificado');

  // Nada mais foi tocado: valor, data, tipo, origem, observacao e ativo intactos.
  assert.equal(resultado.valorCentavos, 20000);
  assert.equal(resultado.data, '2026-04-02');
  assert.equal(resultado.tipo, 'credito');
  assert.equal(resultado.origem, 'deposito');
  assert.equal(depois.observacao, 'deposito sem identificacao do pagador');
  assert.equal(depois.ativo, 1);
});

// --- T2 / T13: auditoria da alteracao (F-11) -------------------------------

test('T2: identificacao valida gera exatamente um audit_log com antes e depois', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = depositoNaoIdentificado(ctx.db);
  const associadoId = criarAssociado(ctx.db);

  identificarMovimento(ctx.db, {
    movimentoId: movimento.id,
    associadoId,
    motivo: MOTIVO,
    ator: 'operacao-manual',
  });

  const registros = ctx.db
    .prepare("SELECT * FROM audit_log WHERE acao = 'movimento_financeiro.identificado'")
    .all();

  assert.equal(registros.length, 1, 'deve haver exatamente um registro de identificacao');
  const registro = registros[0];

  assert.equal(registro.entidade_tipo, 'movimento_financeiro');
  assert.equal(registro.entidade_id, String(movimento.id));
  assert.equal(registro.ator, 'operacao-manual');
  assert.match(registro.criado_em, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  const anterior = JSON.parse(registro.estado_anterior);
  assert.equal(anterior.associadoId, null);
  assert.equal(anterior.estadoIdentificacao, 'nao_identificado');

  const posterior = JSON.parse(registro.estado_posterior);
  assert.equal(posterior.associadoId, associadoId);
  assert.equal(posterior.estadoIdentificacao, 'identificado');

  // M-09: o historico anterior nao foi apagado — continua legivel na trilha.
  assert.equal(anterior.valorCentavos, posterior.valorCentavos);
  assert.equal(anterior.data, posterior.data);
  assert.equal(anterior.observacao, posterior.observacao);

  const metadados = JSON.parse(registro.metadados);
  assert.equal(metadados.movimentoId, movimento.id);
  assert.equal(metadados.associadoId, associadoId);
  assert.equal(metadados.motivo, MOTIVO);
  assert.equal(metadados.origemRegistro, 'manual');
});

test('T13: o motivo chega a auditoria exatamente como informado (apenas trim)', (t) => {
  const ctx = createMigratedDb(t);

  const motivo = 'Deposito de R$ 200,00 confirmado com o associado por telefone em 12/03/2026';
  const movimento = depositoNaoIdentificado(ctx.db);
  const associadoId = criarAssociado(ctx.db);

  identificarMovimento(ctx.db, {
    movimentoId: movimento.id,
    associadoId,
    motivo: `   ${motivo}   `,
  });

  const registro = ctx.db
    .prepare("SELECT metadados FROM audit_log WHERE acao = 'movimento_financeiro.identificado'")
    .get();

  assert.equal(JSON.parse(registro.metadados).motivo, motivo);

  // O motivo NAO contamina a observacao financeira original.
  assert.equal(linhaMovimento(ctx.db, movimento.id).observacao, 'deposito sem identificacao do pagador');
});

// --- T3 / T4: liberacao para alocacao --------------------------------------

test('T3: alocacao e recusada antes e aceita depois da identificacao', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = depositoNaoIdentificado(ctx.db, 12000);
  const associadoId = criarAssociado(ctx.db);
  const competenciaId = criarCompetencia(ctx.db, 2026, 4);

  assert.throws(
    () => alocarMovimento(ctx.db, { movimentoId: movimento.id, competenciaId, valorCentavos: 4000 }),
    (error) => error instanceof LedgerError && error.codigo === 'movimento_nao_identificado'
  );

  identificarMovimento(ctx.db, { movimentoId: movimento.id, associadoId, motivo: MOTIVO });

  const alocacao = alocarMovimento(ctx.db, {
    movimentoId: movimento.id,
    competenciaId,
    valorCentavos: 4000,
  });

  assert.equal(alocacao.valorCentavos, 4000);
  assert.equal(alocacao.resumo.alocadoCentavos, 4000);
  assert.equal(alocacao.resumo.naoAlocadoCentavos, 8000);
});

test('T4: identificar nao cria alocacao automaticamente', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = depositoNaoIdentificado(ctx.db, 12000);
  const associadoId = criarAssociado(ctx.db);
  criarCompetencia(ctx.db, 2026, 4);

  const resultado = identificarMovimento(ctx.db, {
    movimentoId: movimento.id,
    associadoId,
    motivo: MOTIVO,
  });

  assert.deepEqual(resultado.alocacoes, []);
  assert.equal(resultado.resumo.quantidadeAlocacoes, 0);
  assert.equal(resultado.resumo.alocadoCentavos, 0);
  assert.equal(resultado.resumo.naoAlocadoCentavos, 12000);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM alocacao').get().t, 0);
});

// --- T5 / T6: referencias inexistentes -------------------------------------

test('T5: associado inexistente e recusado sem alterar o movimento', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = depositoNaoIdentificado(ctx.db);
  const auditoriaAntes = contarAuditoria(ctx.db);

  assert.throws(
    () => identificarMovimento(ctx.db, { movimentoId: movimento.id, associadoId: 987654, motivo: MOTIVO }),
    (error) => error instanceof LedgerError && error.codigo === 'associado_inexistente'
  );

  const depois = linhaMovimento(ctx.db, movimento.id);
  assert.equal(depois.associado_id, null);
  assert.equal(depois.estado_identificacao, 'nao_identificado');
  assert.equal(contarAuditoria(ctx.db), auditoriaAntes);
  assert.equal(ctx.db.inTransaction, false);
});

test('T6: movimento inexistente e recusado sem efeito colateral', (t) => {
  const ctx = createMigratedDb(t);

  const associadoId = criarAssociado(ctx.db);

  assert.throws(
    () => identificarMovimento(ctx.db, { movimentoId: 987654, associadoId, motivo: MOTIVO }),
    (error) => error instanceof LedgerError && error.codigo === 'movimento_inexistente'
  );

  assert.equal(contarAuditoria(ctx.db), 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM movimento_financeiro').get().t, 0);
});

// --- T7 / T8 / T9: movimento ja identificado --------------------------------

test('T7: movimento ja identificado recusa nova identificacao', (t) => {
  const ctx = createMigratedDb(t);

  const associadoA = criarAssociado(ctx.db, 'Associado A');
  const associadoB = criarAssociado(ctx.db, 'Associado B');
  const movimento = registrarMovimento(ctx.db, {
    data: '2026-04-02',
    valorCentavos: 4000,
    origem: 'pagamento',
    associadoId: associadoA,
  });

  const auditoriaAntes = contarAuditoria(ctx.db);

  assert.throws(
    () =>
      identificarMovimento(ctx.db, { movimentoId: movimento.id, associadoId: associadoB, motivo: MOTIVO }),
    (error) => error instanceof LedgerError && error.codigo === 'movimento_ja_identificado'
  );

  const depois = linhaMovimento(ctx.db, movimento.id);
  assert.equal(depois.associado_id, associadoA);
  assert.equal(depois.estado_identificacao, 'identificado');
  assert.equal(contarAuditoria(ctx.db), auditoriaAntes);
});

test('T8: informar o MESMO associado nao torna a operacao idempotente', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = depositoNaoIdentificado(ctx.db);
  const associadoId = criarAssociado(ctx.db);

  identificarMovimento(ctx.db, { movimentoId: movimento.id, associadoId, motivo: MOTIVO });
  const auditoriaAposPrimeira = contarAuditoria(ctx.db);

  assert.throws(
    () => identificarMovimento(ctx.db, { movimentoId: movimento.id, associadoId, motivo: MOTIVO }),
    (error) => error instanceof LedgerError && error.codigo === 'movimento_ja_identificado'
  );

  assert.equal(linhaMovimento(ctx.db, movimento.id).associado_id, associadoId);
  assert.equal(contarAuditoria(ctx.db), auditoriaAposPrimeira, 'nao pode haver auditoria duplicada');
  assert.equal(
    ctx.db
      .prepare("SELECT COUNT(*) AS t FROM audit_log WHERE acao = 'movimento_financeiro.identificado'")
      .get().t,
    1
  );
});

test('T9: troca de titularidade e proibida nesta operacao', (t) => {
  const ctx = createMigratedDb(t);

  const associadoA = criarAssociado(ctx.db, 'Associado A');
  const associadoB = criarAssociado(ctx.db, 'Associado B');

  const movimento = depositoNaoIdentificado(ctx.db);
  identificarMovimento(ctx.db, { movimentoId: movimento.id, associadoId: associadoA, motivo: MOTIVO });

  assert.throws(
    () =>
      identificarMovimento(ctx.db, {
        movimentoId: movimento.id,
        associadoId: associadoB,
        motivo: 'tentativa de troca de titular',
      }),
    (error) => error instanceof LedgerError && error.codigo === 'movimento_ja_identificado'
  );

  assert.equal(linhaMovimento(ctx.db, movimento.id).associado_id, associadoA);
  assert.equal(
    ctx.db.prepare("SELECT COUNT(*) AS t FROM audit_log WHERE metadados LIKE '%troca de titular%'").get().t,
    0
  );
});

// --- T10 / T11: estados que impedem a identificacao -------------------------

test('T10: movimento inativo nao pode ser identificado nem reativado', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = depositoNaoIdentificado(ctx.db);
  const associadoId = criarAssociado(ctx.db);

  ctx.db
    .prepare(
      'UPDATE movimento_financeiro SET ativo = 0, inativado_em = ?, motivo_inativacao = ? WHERE id = ?'
    )
    .run('2026-04-03T00:00:00Z', 'lancamento duplicado', movimento.id);

  const auditoriaAntes = contarAuditoria(ctx.db);

  assert.throws(
    () => identificarMovimento(ctx.db, { movimentoId: movimento.id, associadoId, motivo: MOTIVO }),
    (error) => error instanceof LedgerError && error.codigo === 'movimento_inativo'
  );

  const depois = linhaMovimento(ctx.db, movimento.id);
  assert.equal(depois.ativo, 0, 'nao pode haver reativacao implicita');
  assert.equal(depois.associado_id, null);
  assert.equal(depois.estado_identificacao, 'nao_identificado');
  assert.equal(contarAuditoria(ctx.db), auditoriaAntes);
});

test('T11: movimento em revisao nao e identificado silenciosamente (M-08)', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = depositoNaoIdentificado(ctx.db);
  const associadoId = criarAssociado(ctx.db);

  // O schema aceita 'em_revisao'; nenhum fluxo de revisao existe nesta fase.
  ctx.db
    .prepare("UPDATE movimento_financeiro SET estado_identificacao = 'em_revisao' WHERE id = ?")
    .run(movimento.id);

  const auditoriaAntes = contarAuditoria(ctx.db);

  assert.throws(
    () => identificarMovimento(ctx.db, { movimentoId: movimento.id, associadoId, motivo: MOTIVO }),
    (error) => error instanceof LedgerError && error.codigo === 'movimento_em_revisao'
  );

  const depois = linhaMovimento(ctx.db, movimento.id);
  assert.equal(depois.estado_identificacao, 'em_revisao', 'a ambiguidade declarada permanece');
  assert.equal(depois.associado_id, null);
  assert.equal(contarAuditoria(ctx.db), auditoriaAntes);
});

// --- T12: motivo obrigatorio ------------------------------------------------

test('T12: motivo ausente ou vazio e recusado', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = depositoNaoIdentificado(ctx.db);
  const associadoId = criarAssociado(ctx.db);
  const auditoriaAntes = contarAuditoria(ctx.db);

  for (const motivo of [undefined, null, '', '   ']) {
    assert.throws(
      () => identificarMovimento(ctx.db, { movimentoId: movimento.id, associadoId, motivo }),
      (error) => error instanceof LedgerError && error.codigo === 'motivo_obrigatorio',
      `motivo deveria ter sido recusado: ${JSON.stringify(motivo)}`
    );
  }

  const depois = linhaMovimento(ctx.db, movimento.id);
  assert.equal(depois.associado_id, null);
  assert.equal(depois.estado_identificacao, 'nao_identificado');
  assert.equal(contarAuditoria(ctx.db), auditoriaAntes);
});

// --- T14: atomicidade (T-07) ------------------------------------------------

test('T14: falha na auditoria desfaz o UPDATE do movimento', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = depositoNaoIdentificado(ctx.db);
  const associadoId = criarAssociado(ctx.db);
  const auditoriaAntes = contarAuditoria(ctx.db);

  // Falha induzida no banco, depois do UPDATE e dentro da mesma transacao.
  ctx.db.exec(`
    CREATE TRIGGER falha_induzida_audit BEFORE INSERT ON audit_log
    BEGIN SELECT RAISE(ABORT, 'falha induzida na auditoria'); END
  `);

  assert.throws(
    () => identificarMovimento(ctx.db, { movimentoId: movimento.id, associadoId, motivo: MOTIVO }),
    /falha induzida na auditoria/
  );

  ctx.db.exec('DROP TRIGGER falha_induzida_audit');

  const depois = linhaMovimento(ctx.db, movimento.id);
  assert.equal(depois.associado_id, null, 'o vinculo nao pode sobreviver a falha da auditoria');
  assert.equal(depois.estado_identificacao, 'nao_identificado');
  assert.equal(contarAuditoria(ctx.db), auditoriaAntes, 'nenhuma auditoria parcial');
  assert.equal(ctx.db.inTransaction, false);

  // O movimento continua alocavel apenas apos uma identificacao bem-sucedida.
  const competenciaId = criarCompetencia(ctx.db, 2026, 5);
  assert.throws(
    () => alocarMovimento(ctx.db, { movimentoId: movimento.id, competenciaId, valorCentavos: 4000 }),
    (error) => error instanceof LedgerError && error.codigo === 'movimento_nao_identificado'
  );
});

// --- T15 / T16: o legado nao participa da identificacao ---------------------

/** Remove comentarios para que as assercoes falem do CODIGO, nao da documentacao. */
function codigoSemComentarios(fonte) {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('T15: a implementacao nao consulta nenhuma fonte do legado', () => {
  const codigo = codigoSemComentarios(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ledger.js'), 'utf8')
  );

  for (const proibido of ['legacy_cell', 'legacy_cell_link', 'importacao', 'legacy_id', 'nome', 'BJ', 'BM', 'BN']) {
    assert.equal(
      codigo.includes(proibido),
      false,
      `a identificacao nao pode depender de ${proibido}`
    );
  }

  // A unica leitura de `associado` e por id interno.
  const consultas = codigo.match(/FROM associado[^']*/g) ?? [];
  assert.ok(consultas.length > 0, 'esperava ao menos uma consulta a associado');
  for (const consulta of consultas) {
    assert.match(consulta, /^FROM associado WHERE id = \?$/);
  }
});

test('T16: coincidencia entre centavos e legacy_id nao identifica nada', (t) => {
  const ctx = createMigratedDb(t);

  // Ruido proposital: o id interno do associado (2) difere do legacy_id ('37'),
  // e o valor do movimento termina justamente em 37 centavos.
  criarAssociado(ctx.db, 'Associado Um', '11');
  const associadoId = criarAssociado(ctx.db, 'Fulano de Tal', '37');
  assert.notEqual(associadoId, 37);

  const movimento = depositoNaoIdentificado(ctx.db, 15037);

  // Nenhuma correspondencia automatica acontece so por existir a coincidencia.
  assert.equal(obterMovimento(ctx.db, movimento.id).associadoId, null);
  assert.equal(obterMovimento(ctx.db, movimento.id).estadoIdentificacao, 'nao_identificado');

  identificarMovimento(ctx.db, {
    movimentoId: movimento.id,
    associadoId,
    motivo: 'associado confirmado pelo operador, nao pelo final do valor',
  });

  const depois = linhaMovimento(ctx.db, movimento.id);
  assert.equal(depois.associado_id, associadoId, 'vale o id informado, nunca o legacy_id');
  assert.equal(calcularResumoDoMovimento(ctx.db, movimento.id).totalCentavos, 15037);
});

test('id de associado invalido e recusado antes de qualquer gravacao', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = depositoNaoIdentificado(ctx.db);

  for (const associadoId of ['37', 'Fulano de Tal', 1.5, 0, -1, null, undefined]) {
    assert.throws(
      () => identificarMovimento(ctx.db, { movimentoId: movimento.id, associadoId, motivo: MOTIVO }),
      (error) => error instanceof LedgerError && error.codigo === 'id_invalido',
      `associadoId deveria ter sido recusado: ${JSON.stringify(associadoId)}`
    );
  }

  assert.equal(linhaMovimento(ctx.db, movimento.id).associado_id, null);
});
