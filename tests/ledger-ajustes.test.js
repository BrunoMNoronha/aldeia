'use strict';

// Fase 3D - ajuste EXPLICITO de credito/debito (M-03 / F-04 / T-06 / T-07 / F-11).
//
// O que estes testes provam, em uma frase: um credito ou um debito pode ser
// registrado como EVENTO estruturado, com motivo e trilha, sem que isso vire
// saldo, quitacao ou situacao financeira.
//
// Provam tambem o contorno da operacao: ela nao toca movimento, nao toca
// alocacao, nao cria competencia, nao le legado e — se a auditoria falhar — nao
// deixa ajuste nenhum para tras.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registrarAjuste,
  inativarAjuste,
  LedgerError,
  ACAO_AJUSTE_CRIADO,
  ACAO_AJUSTE_INATIVADO,
} = require('../src/services/ledger');
const { TIPO_AJUSTE } = require('../src/domain/constants');
const { createMigratedDb } = require('./helpers/temp-db');

const MOTIVO = 'Ajuste aprovado em assembleia, ata 2026-08';
const DATA = '2026-08-16';

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

function linhaAjuste(db, id) {
  return db.prepare('SELECT * FROM ajuste_credito_debito WHERE id = ?').get(id);
}

function contar(db, tabela) {
  return db.prepare(`SELECT COUNT(*) AS t FROM ${tabela}`).get().t;
}

function auditoriaDoAjuste(db, ajusteId) {
  return db
    .prepare('SELECT * FROM audit_log WHERE entidade_tipo = ? AND entidade_id = ?')
    .all('ajuste_credito_debito', String(ajusteId));
}

/** Entrada valida minima; cada teste sobrescreve so o campo que investiga. */
function entradaValida(db, extra = {}) {
  return {
    associadoId: criarAssociado(db),
    tipo: 'credito',
    valorCentavos: 4000,
    motivo: MOTIVO,
    data: DATA,
    ...extra,
  };
}

/** Falha induzida DEPOIS do INSERT e dentro da mesma transacao. */
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

// --- A1..A4: criacao valida -------------------------------------------------

test('A1: credito valido e criado ativo, com os campos exatamente como enviados', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);

  const ajuste = registrarAjuste(ctx.db, {
    associadoId,
    tipo: 'credito',
    valorCentavos: 4000,
    motivo: MOTIVO,
    data: DATA,
  });

  assert.equal(ajuste.associadoId, associadoId);
  assert.equal(ajuste.tipo, 'credito');
  assert.equal(ajuste.valorCentavos, 4000);
  assert.equal(ajuste.motivo, MOTIVO);
  assert.equal(ajuste.data, DATA);
  assert.equal(ajuste.competenciaId, null);
  assert.equal(ajuste.observacao, null);

  // Todo ajuste nasce ATIVO e sem trilha de inativacao (M-09).
  assert.equal(ajuste.ativo, true);
  assert.equal(ajuste.inativadoEm, null);
  assert.equal(ajuste.motivoInativacao, null);

  // Defaults do schema, nao valores enviados pelo chamador.
  assert.match(ajuste.criadoEm, TIMESTAMP_RE);
  assert.match(ajuste.atualizadoEm, TIMESTAMP_RE);

  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 1);
  assert.equal(linhaAjuste(ctx.db, ajuste.id).ativo, 1);
});

test('A2: debito valido e criado com o MESMO valor positivo, so o tipo muda', (t) => {
  const ctx = createMigratedDb(t);

  const ajuste = registrarAjuste(ctx.db, entradaValida(ctx.db, { tipo: 'debito', valorCentavos: 2500 }));

  assert.equal(ajuste.tipo, 'debito');
  assert.equal(ajuste.valorCentavos, 2500);
  assert.equal(ajuste.ativo, true);

  // T-06: o sinal economico e o TIPO. Debito nunca vira valor negativo.
  const linha = linhaAjuste(ctx.db, ajuste.id);
  assert.equal(linha.tipo, 'debito');
  assert.equal(linha.valor_centavos, 2500);
  assert.ok(linha.valor_centavos > 0, 'debito nao pode ser persistido como valor negativo');
});

test('A3: T-06 - o valor persistido continua INTEIRO em centavos, sem float', (t) => {
  const ctx = createMigratedDb(t);

  const ajuste = registrarAjuste(ctx.db, entradaValida(ctx.db, { valorCentavos: 15035 }));

  const linha = linhaAjuste(ctx.db, ajuste.id);
  assert.equal(linha.valor_centavos, 15035);
  assert.equal(typeof linha.valor_centavos, 'number');
  assert.ok(Number.isSafeInteger(linha.valor_centavos));
  assert.equal(
    ctx.db.prepare('SELECT typeof(valor_centavos) AS t FROM ajuste_credito_debito WHERE id = ?').get(ajuste.id).t,
    'integer'
  );
});

test('A4: credito e debito do MESMO associado coexistem sem se anular', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);

  const credito = registrarAjuste(ctx.db, {
    associadoId,
    tipo: 'credito',
    valorCentavos: 4000,
    motivo: MOTIVO,
    data: DATA,
  });
  const debito = registrarAjuste(ctx.db, {
    associadoId,
    tipo: 'debito',
    valorCentavos: 4000,
    motivo: 'Cobranca retroativa aprovada',
    data: DATA,
  });

  // Dois EVENTOS. Nenhuma compensacao automatica, nenhum saldo zerado.
  assert.notEqual(credito.id, debito.id);
  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 2);
  assert.equal(credito.ativo, true);
  assert.equal(debito.ativo, true);
  assert.equal(linhaAjuste(ctx.db, credito.id).valor_centavos, 4000);
  assert.equal(linhaAjuste(ctx.db, debito.id).valor_centavos, 4000);
});

// --- A5..A6: associado ------------------------------------------------------

test('A5: associadoId e obrigatorio e precisa ser inteiro positivo', (t) => {
  const ctx = createMigratedDb(t);

  for (const associadoId of [undefined, null, 0, -1, 1.5, '1', NaN]) {
    assert.throws(
      () =>
        registrarAjuste(ctx.db, {
          associadoId,
          tipo: 'credito',
          valorCentavos: 4000,
          motivo: MOTIVO,
          data: DATA,
        }),
      (error) => error instanceof LedgerError && error.codigo === 'id_invalido',
      `associadoId ${String(associadoId)} deveria ser recusado`
    );
  }

  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 0);
  assert.equal(contar(ctx.db, 'audit_log'), 0);
});

test('A6: associado inexistente e recusado, sem qualquer inferencia', (t) => {
  const ctx = createMigratedDb(t);
  criarAssociado(ctx.db, 'Fulano de Tal');

  assert.throws(
    () =>
      registrarAjuste(ctx.db, {
        associadoId: 9999,
        tipo: 'credito',
        valorCentavos: 4000,
        motivo: MOTIVO,
        data: DATA,
      }),
    (error) => error instanceof LedgerError && error.codigo === 'associado_inexistente'
  );

  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 0);
  assert.equal(contar(ctx.db, 'audit_log'), 0);
  assert.equal(ctx.db.inTransaction, false);
});

// --- A7: tipo ---------------------------------------------------------------

test('A7: tipo aceita SOMENTE o vocabulario estruturado credito|debito', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);

  // M-03: sinonimo, abreviacao, sinal e acento NAO sao traduzidos para
  // significado. Nenhum destes vira credito ou debito por conveniencia.
  const recusados = [
    'crédito',
    'débito',
    'deb',
    'cred',
    'entrada',
    'saida',
    'estorno',
    '+',
    '-',
    'CREDITO/DEBITO',
    '',
    '   ',
    null,
    undefined,
    1,
    true,
  ];

  for (const tipo of recusados) {
    assert.throws(
      () =>
        registrarAjuste(ctx.db, { associadoId, tipo, valorCentavos: 4000, motivo: MOTIVO, data: DATA }),
      (error) => error instanceof LedgerError && error.codigo === 'tipo_ajuste_invalido',
      `tipo ${JSON.stringify(tipo)} deveria ser recusado`
    );
  }

  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 0);
  assert.equal(contar(ctx.db, 'audit_log'), 0);

  // O vocabulario aceito e exatamente o de domain/constants (espelho do CHECK).
  assert.deepEqual([...TIPO_AJUSTE], ['credito', 'debito']);
  for (const tipo of TIPO_AJUSTE) {
    const ajuste = registrarAjuste(ctx.db, {
      associadoId,
      tipo,
      valorCentavos: 4000,
      motivo: MOTIVO,
      data: DATA,
    });
    assert.equal(ajuste.tipo, tipo);
  }
});

// --- A8..A11: valor (T-06) --------------------------------------------------

test('A8: valor decimal e recusado, sem arredondar nem truncar', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);

  assert.throws(
    () =>
      registrarAjuste(ctx.db, {
        associadoId,
        tipo: 'credito',
        valorCentavos: 150.35,
        motivo: MOTIVO,
        data: DATA,
      }),
    (error) => error instanceof LedgerError && error.codigo === 'valor_nao_inteiro'
  );

  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 0);
});

test('A9: valor em string e recusado, sem conversao silenciosa', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);

  for (const valorCentavos of ['15035', '4000', 'R$ 40,00', NaN, Infinity, -Infinity, null, undefined]) {
    assert.throws(
      () =>
        registrarAjuste(ctx.db, {
          associadoId,
          tipo: 'credito',
          valorCentavos,
          motivo: MOTIVO,
          data: DATA,
        }),
      (error) => error instanceof LedgerError && error.codigo === 'valor_nao_inteiro',
      `valorCentavos ${String(valorCentavos)} deveria ser recusado`
    );
  }

  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 0);
});

test('A10: zero e recusado', (t) => {
  const ctx = createMigratedDb(t);

  assert.throws(
    () => registrarAjuste(ctx.db, entradaValida(ctx.db, { valorCentavos: 0 })),
    (error) => error instanceof LedgerError && error.codigo === 'valor_nao_positivo'
  );

  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 0);
});

test('A11: valor negativo e recusado, inclusive para debito', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);

  for (const tipo of ['credito', 'debito']) {
    assert.throws(
      () =>
        registrarAjuste(ctx.db, {
          associadoId,
          tipo,
          valorCentavos: -100,
          motivo: MOTIVO,
          data: DATA,
        }),
      (error) => error instanceof LedgerError && error.codigo === 'valor_nao_positivo',
      `${tipo} com valor negativo deveria ser recusado`
    );
  }

  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 0);
});

// --- A12..A13: motivo e data ------------------------------------------------

test('A12: motivo vazio ou so espaco e recusado; observacao nao o substitui', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);

  for (const motivo of ['', '   ', '\t\n', null, undefined]) {
    assert.throws(
      () =>
        registrarAjuste(ctx.db, {
          associadoId,
          tipo: 'credito',
          valorCentavos: 4000,
          motivo,
          data: DATA,
          observacao: 'texto que NAO pode virar motivo',
        }),
      (error) => error instanceof LedgerError && error.codigo === 'motivo_obrigatorio',
      `motivo ${JSON.stringify(motivo)} deveria ser recusado`
    );
  }

  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 0);

  // Nao ha tamanho minimo arbitrario: um motivo curto e valido.
  const ajuste = registrarAjuste(ctx.db, {
    associadoId,
    tipo: 'credito',
    valorCentavos: 4000,
    motivo: 'ok',
    data: DATA,
  });
  assert.equal(ajuste.motivo, 'ok');
});

test('A13: data invalida e recusada pelo MESMO validador do movimento', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);

  for (const data of ['2026-13-01', '2026-02-30', '10/03/2026', '2026-2-3', '', null, undefined, 20260816]) {
    assert.throws(
      () =>
        registrarAjuste(ctx.db, {
          associadoId,
          tipo: 'credito',
          valorCentavos: 4000,
          motivo: MOTIVO,
          data,
        }),
      (error) => error instanceof LedgerError && error.codigo === 'data_invalida',
      `data ${JSON.stringify(data)} deveria ser recusada`
    );
  }

  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 0);

  // Data civil real e aceita, inclusive 29/02 em ano bissexto.
  const ajuste = registrarAjuste(ctx.db, {
    associadoId,
    tipo: 'credito',
    valorCentavos: 4000,
    motivo: MOTIVO,
    data: '2028-02-29',
  });
  assert.equal(ajuste.data, '2028-02-29');
});

// --- A14..A16: competencia --------------------------------------------------

test('A14: competencia e OPCIONAL - ausente ou null grava NULL, e so isso', (t) => {
  const ctx = createMigratedDb(t);

  const semCampo = registrarAjuste(ctx.db, entradaValida(ctx.db));
  const comNull = registrarAjuste(ctx.db, entradaValida(ctx.db, { competenciaId: null }));

  assert.equal(semCampo.competenciaId, null);
  assert.equal(comNull.competenciaId, null);
  assert.equal(linhaAjuste(ctx.db, semCampo.id).competencia_id, null);
  assert.equal(linhaAjuste(ctx.db, comNull.id).competencia_id, null);

  // Ausencia de competencia NAO cria competencia nem inventa vinculo.
  assert.equal(contar(ctx.db, 'competencia'), 0);
});

test('A15: competencia existente e vinculada pelo id informado', (t) => {
  const ctx = createMigratedDb(t);
  const competenciaId = criarCompetencia(ctx.db, 2026, 4);

  const ajuste = registrarAjuste(ctx.db, entradaValida(ctx.db, { competenciaId }));

  assert.equal(ajuste.competenciaId, competenciaId);
  assert.equal(linhaAjuste(ctx.db, ajuste.id).competencia_id, competenciaId);
  // Nenhuma competencia extra apareceu.
  assert.equal(contar(ctx.db, 'competencia'), 1);
});

test('A16: competencia inexistente e recusada e NENHUMA e criada (M-10)', (t) => {
  const ctx = createMigratedDb(t);

  assert.throws(
    () => registrarAjuste(ctx.db, entradaValida(ctx.db, { competenciaId: 4242 })),
    (error) => error instanceof LedgerError && error.codigo === 'competencia_inexistente'
  );

  assert.equal(contar(ctx.db, 'competencia'), 0);
  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 0);
  assert.equal(contar(ctx.db, 'audit_log'), 0);
  assert.equal(ctx.db.inTransaction, false);

  // 'ano', 'mes' e '2026-04' NAO sao aceitos como substitutos de competenciaId:
  // chegam como id invalido e nunca viram uma competencia nova.
  for (const competenciaId of ['2026-04', { ano: 2026, mes: 4 }, 2026.04]) {
    assert.throws(
      () => registrarAjuste(ctx.db, entradaValida(ctx.db, { competenciaId })),
      (error) => error instanceof LedgerError && error.codigo === 'id_invalido',
      `competenciaId ${JSON.stringify(competenciaId)} deveria ser recusado`
    );
  }
  assert.equal(contar(ctx.db, 'competencia'), 0);
});

// --- A17: observacao --------------------------------------------------------

test('A17: observacao e preservada literalmente e nao e interpretada', (t) => {
  const ctx = createMigratedDb(t);
  const competenciaId = criarCompetencia(ctx.db, 2026, 4);

  // Texto recheado de coisas que o servico PODERIA tentar deduzir — e nao deduz.
  const observacao = 'debito de R$ 40,00 ref. 2026-05 do associado 999, legacy_id 123, DESLIGADO';
  const ajuste = registrarAjuste(
    ctx.db,
    entradaValida(ctx.db, { observacao, competenciaId, tipo: 'credito', valorCentavos: 4000 })
  );

  assert.equal(ajuste.observacao, observacao);
  assert.equal(linhaAjuste(ctx.db, ajuste.id).observacao, observacao);

  // Nada foi extraido do texto: tipo, valor, competencia e associado seguem os
  // campos ESTRUTURADOS, nao a observacao.
  assert.equal(ajuste.tipo, 'credito');
  assert.equal(ajuste.valorCentavos, 4000);
  assert.equal(ajuste.competenciaId, competenciaId);
  assert.equal(contar(ctx.db, 'competencia'), 1);
});

// --- A18..A21: auditoria (F-11) ---------------------------------------------

test('A18: criacao valida gera EXATAMENTE uma auditoria', (t) => {
  const ctx = createMigratedDb(t);

  const ajuste = registrarAjuste(ctx.db, entradaValida(ctx.db));

  assert.equal(contar(ctx.db, 'audit_log'), 1);
  const linhas = auditoriaDoAjuste(ctx.db, ajuste.id);
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].acao, ACAO_AJUSTE_CRIADO);
  assert.equal(linhas[0].acao, 'ajuste_credito_debito.criado');
  assert.equal(linhas[0].entidade_tipo, 'ajuste_credito_debito');
  assert.equal(linhas[0].ator, 'sistema');
});

test('A19: estado_anterior e null - criacao nao tinha estado antes', (t) => {
  const ctx = createMigratedDb(t);

  const ajuste = registrarAjuste(ctx.db, entradaValida(ctx.db, { ator: 'operador' }));
  const [linha] = auditoriaDoAjuste(ctx.db, ajuste.id);

  assert.equal(linha.estado_anterior, null);
  assert.equal(linha.ator, 'operador');
});

test('A20: estado_posterior contem o registro criado, como ele existe no banco', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);

  const ajuste = registrarAjuste(ctx.db, {
    associadoId,
    tipo: 'credito',
    valorCentavos: 4000,
    motivo: 'ajuste aprovado',
    data: DATA,
  });

  const [linha] = auditoriaDoAjuste(ctx.db, ajuste.id);
  const posterior = JSON.parse(linha.estado_posterior);

  assert.equal(posterior.id, ajuste.id);
  assert.equal(posterior.associadoId, associadoId);
  assert.equal(posterior.tipo, 'credito');
  assert.equal(posterior.valorCentavos, 4000);
  assert.equal(posterior.motivo, 'ajuste aprovado');
  assert.equal(posterior.data, DATA);
  assert.equal(posterior.competenciaId, null);
  assert.equal(posterior.observacao, null);
  assert.equal(posterior.ativo, true);

  // A trilha grava o objeto RELIDO do banco, entao bate com o retorno.
  assert.deepEqual(posterior, ajuste);
});

test('A21: metadados identificam o ajuste, sem inventar situacao financeira', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);
  const competenciaId = criarCompetencia(ctx.db, 2026, 4);

  const semCompetencia = registrarAjuste(ctx.db, {
    associadoId,
    tipo: 'credito',
    valorCentavos: 4000,
    motivo: MOTIVO,
    data: DATA,
  });
  const metaSem = JSON.parse(auditoriaDoAjuste(ctx.db, semCompetencia.id)[0].metadados);

  assert.deepEqual(metaSem, {
    origemRegistro: 'manual',
    ajusteId: semCompetencia.id,
    associadoId,
    tipo: 'credito',
    valorCentavos: 4000,
    competenciaId: null,
    competencia: null,
  });

  const comCompetencia = registrarAjuste(ctx.db, {
    associadoId,
    tipo: 'debito',
    valorCentavos: 2500,
    motivo: MOTIVO,
    data: DATA,
    competenciaId,
  });
  const metaCom = JSON.parse(auditoriaDoAjuste(ctx.db, comCompetencia.id)[0].metadados);

  assert.equal(metaCom.competenciaId, competenciaId);
  // Rotulo AAAA-MM vem do helper ja existente, nao de uma segunda formatacao.
  assert.equal(metaCom.competencia, '2026-04');
  assert.equal(metaCom.tipo, 'debito');
  assert.equal(metaCom.valorCentavos, 2500);

  // Nenhum metadado afirma saldo, quitacao ou adimplencia.
  for (const meta of [metaSem, metaCom]) {
    for (const proibido of [
      'saldo',
      'saldoCentavos',
      'adimplencia',
      'inadimplencia',
      'totalDevido',
      'totalPago',
      'creditoDisponivel',
      'quitado',
    ]) {
      assert.equal(proibido in meta, false, `metadados nao podem conter '${proibido}'`);
    }
  }
});

// --- A22: rollback (T-07) ---------------------------------------------------

test('A22: falha no audit_log desfaz o ajuste por completo', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);
  const competenciaId = criarCompetencia(ctx.db, 2026, 4);

  // Estado anterior: um ajuste ja existente precisa sobreviver intacto.
  const anterior = registrarAjuste(ctx.db, {
    associadoId,
    tipo: 'credito',
    valorCentavos: 1000,
    motivo: MOTIVO,
    data: DATA,
  });
  const ajustesAntes = contar(ctx.db, 'ajuste_credito_debito');
  const auditoriaAntes = contar(ctx.db, 'audit_log');

  comAuditoriaQuebrada(ctx.db, () => {
    assert.throws(() =>
      registrarAjuste(ctx.db, {
        associadoId,
        tipo: 'debito',
        valorCentavos: 9999,
        motivo: 'este ajuste nao pode sobreviver',
        data: DATA,
        competenciaId,
      })
    );
  });

  // T-07: sem trilha, sem ajuste. Nenhum efeito parcial.
  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), ajustesAntes);
  assert.equal(contar(ctx.db, 'audit_log'), auditoriaAntes);
  assert.equal(
    ctx.db.prepare('SELECT COUNT(*) AS t FROM ajuste_credito_debito WHERE valor_centavos = 9999').get().t,
    0
  );

  // O ajuste anterior continua exatamente como estava.
  assert.equal(linhaAjuste(ctx.db, anterior.id).valor_centavos, 1000);
  assert.equal(linhaAjuste(ctx.db, anterior.id).ativo, 1);

  // A conexao nao pode ficar com transacao aberta.
  assert.equal(ctx.db.inTransaction, false);
});

// --- A23..A24: erro de validacao nao grava nada -----------------------------

test('A23/A24: erro de validacao nao cria ajuste nem auditoria', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);

  const entradasInvalidas = [
    { associadoId, tipo: 'entrada', valorCentavos: 4000, motivo: MOTIVO, data: DATA },
    { associadoId, tipo: 'credito', valorCentavos: 150.35, motivo: MOTIVO, data: DATA },
    { associadoId, tipo: 'credito', valorCentavos: 0, motivo: MOTIVO, data: DATA },
    { associadoId, tipo: 'credito', valorCentavos: 4000, motivo: '  ', data: DATA },
    { associadoId, tipo: 'credito', valorCentavos: 4000, motivo: MOTIVO, data: '2026-02-30' },
    { associadoId: 9999, tipo: 'credito', valorCentavos: 4000, motivo: MOTIVO, data: DATA },
    { associadoId, tipo: 'credito', valorCentavos: 4000, motivo: MOTIVO, data: DATA, competenciaId: 77 },
  ];

  for (const entrada of entradasInvalidas) {
    assert.throws(() => registrarAjuste(ctx.db, entrada), LedgerError);
  }

  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 0);
  assert.equal(contar(ctx.db, 'audit_log'), 0);
  assert.equal(ctx.db.inTransaction, false);
});

// --- A25..A29: o que a operacao NAO toca ------------------------------------

test('A25/A26: nenhum movimento e nenhuma alocacao sao criados ou alterados', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);
  const competenciaId = criarCompetencia(ctx.db, 2026, 4);

  // Um movimento com alocacao ja existente, para provar que nada nele muda.
  const movimentoId = Number(
    ctx.db
      .prepare(
        `INSERT INTO movimento_financeiro
           (data, valor_centavos, tipo, origem, associado_id, estado_identificacao)
         VALUES (?, ?, 'credito', 'pagamento', ?, 'identificado')`
      )
      .run('2026-05-01', 12000, associadoId).lastInsertRowid
  );
  ctx.db
    .prepare('INSERT INTO alocacao (movimento_id, competencia_id, valor_centavos) VALUES (?, ?, ?)')
    .run(movimentoId, competenciaId, 12000);

  const movimentosAntes = ctx.db.prepare('SELECT * FROM movimento_financeiro ORDER BY id').all();
  const alocacoesAntes = ctx.db.prepare('SELECT * FROM alocacao ORDER BY id').all();

  registrarAjuste(ctx.db, {
    associadoId,
    tipo: 'debito',
    valorCentavos: 12000,
    motivo: MOTIVO,
    data: DATA,
    competenciaId,
  });

  // Byte a byte: nem linha nova, nem coluna alterada, nem `ativo` mexido.
  assert.deepEqual(ctx.db.prepare('SELECT * FROM movimento_financeiro ORDER BY id').all(), movimentosAntes);
  assert.deepEqual(ctx.db.prepare('SELECT * FROM alocacao ORDER BY id').all(), alocacoesAntes);
  assert.equal(contar(ctx.db, 'movimento_financeiro'), 1);
  assert.equal(contar(ctx.db, 'alocacao'), 1);
});

test('A27/A28: nenhuma competencia, comprovante ou pendencia e criada automaticamente', (t) => {
  const ctx = createMigratedDb(t);

  registrarAjuste(ctx.db, entradaValida(ctx.db));
  registrarAjuste(ctx.db, entradaValida(ctx.db, { tipo: 'debito' }));

  assert.equal(contar(ctx.db, 'competencia'), 0);
  assert.equal(contar(ctx.db, 'comprovante'), 0);
  assert.equal(contar(ctx.db, 'pendencia'), 0);
  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 2);
});

test('A29: nada depende do legado - ajuste funciona com as tabelas legadas vazias', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);

  // Nenhuma importacao aconteceu: as tabelas do legado estao vazias.
  assert.equal(contar(ctx.db, 'legacy_cell'), 0);
  assert.equal(contar(ctx.db, 'legacy_cell_link'), 0);

  const ajuste = registrarAjuste(ctx.db, {
    associadoId,
    tipo: 'credito',
    valorCentavos: 4000,
    motivo: MOTIVO,
    data: DATA,
  });

  assert.equal(ajuste.valorCentavos, 4000);
  // E continuam vazias: o ajuste nao le nem escreve proveniencia legada.
  assert.equal(contar(ctx.db, 'legacy_cell'), 0);
  assert.equal(contar(ctx.db, 'legacy_cell_link'), 0);
});

// --- A30: seguranca ---------------------------------------------------------

test('A30: SQL parametrizado - texto malicioso vira DADO, nunca comando', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);

  const injecao = "'); DROP TABLE ajuste_credito_debito; --";
  const ajuste = registrarAjuste(ctx.db, {
    associadoId,
    tipo: 'credito',
    valorCentavos: 4000,
    motivo: injecao,
    data: DATA,
    observacao: injecao,
    ator: injecao,
  });

  // A tabela continua de pe e o texto foi gravado LITERALMENTE.
  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 1);
  assert.equal(linhaAjuste(ctx.db, ajuste.id).motivo, injecao);
  assert.equal(linhaAjuste(ctx.db, ajuste.id).observacao, injecao);
  assert.equal(auditoriaDoAjuste(ctx.db, ajuste.id)[0].ator, injecao);

  // Persistencia guarda o texto original; escaping e assunto da renderizacao.
  assert.equal(ajuste.motivo, injecao);
});

test('A30b: o retorno nao carrega saldo, adimplencia nem qualquer agregado', (t) => {
  const ctx = createMigratedDb(t);

  const ajuste = registrarAjuste(ctx.db, entradaValida(ctx.db, { tipo: 'debito' }));

  // Contrato FECHADO: exatamente estas chaves, nada derivado.
  assert.deepEqual(Object.keys(ajuste).sort(), [
    'associadoId',
    'ativo',
    'atualizadoEm',
    'competenciaId',
    'criadoEm',
    'data',
    'id',
    'inativadoEm',
    'motivo',
    'motivoInativacao',
    'observacao',
    'tipo',
    'valorCentavos',
  ]);
});

// ============================================================================
// Fase 3E - inativacao auditavel do ajuste (M-09 / F-11).
//
// Corrigir um ajuste registrado por engano NAO e apaga-lo: a linha continua no
// banco, ganha quando/por que, e o `motivo` ORIGINAL do ajuste permanece
// intocado — `motivo_inativacao` e uma segunda informacao, nao uma correcao da
// primeira. Nenhum ajuste oposto e criado, nada e compensado, nada e estornado.
// ============================================================================

const MOTIVO_INATIVACAO = 'Lancamento duplicado: o mesmo ajuste foi digitado duas vezes';

/** Ajuste ativo pronto para os cenarios de correcao, com todos os campos preenchidos. */
function ajusteCompleto(db, extra = {}) {
  const associadoId = criarAssociado(db);
  const competenciaId = criarCompetencia(db, 2026, 4);
  return registrarAjuste(db, {
    associadoId,
    tipo: 'debito',
    valorCentavos: 2500,
    motivo: 'correcao financeira aprovada',
    data: '2026-08-16',
    competenciaId,
    observacao: 'referencia interna',
    ...extra,
  });
}

/** Marca `atualizado_em` com um valor antigo para provar que o UPDATE o refaz. */
function envelhecerAtualizadoEm(db, id) {
  const sentinela = '2000-01-01T00:00:00Z';
  db.prepare('UPDATE ajuste_credito_debito SET atualizado_em = ? WHERE id = ?').run(sentinela, id);
  return sentinela;
}

// --- S1..S4: inativacao valida ----------------------------------------------

test('S1: ajuste ativo e inativado com timestamp, motivo e atualizado_em refeito', (t) => {
  const ctx = createMigratedDb(t);

  const ajuste = ajusteCompleto(ctx.db);
  const sentinela = envelhecerAtualizadoEm(ctx.db, ajuste.id);

  const resultado = inativarAjuste(ctx.db, { ajusteId: ajuste.id, motivo: MOTIVO_INATIVACAO });

  assert.equal(resultado.ativo, false);
  assert.match(resultado.inativadoEm, TIMESTAMP_RE);
  assert.equal(resultado.motivoInativacao, MOTIVO_INATIVACAO);

  const linha = linhaAjuste(ctx.db, ajuste.id);
  assert.equal(linha.ativo, 0);
  assert.match(linha.inativado_em, TIMESTAMP_RE);
  assert.equal(linha.motivo_inativacao, MOTIVO_INATIVACAO);
  assert.notEqual(linha.atualizado_em, sentinela, 'atualizado_em precisa ser refeito');

  // M-09: nada foi excluido — a linha continua exatamente onde estava.
  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 1);
});

test('S2: os dados financeiros originais permanecem intactos (T-06)', (t) => {
  const ctx = createMigratedDb(t);

  const ajuste = ajusteCompleto(ctx.db);
  const antes = linhaAjuste(ctx.db, ajuste.id);

  inativarAjuste(ctx.db, { ajusteId: ajuste.id, motivo: MOTIVO_INATIVACAO });
  const depois = linhaAjuste(ctx.db, ajuste.id);

  for (const coluna of [
    'id',
    'associado_id',
    'tipo',
    'valor_centavos',
    'motivo',
    'data',
    'competencia_id',
    'observacao',
    'criado_em',
  ]) {
    assert.equal(depois[coluna], antes[coluna], `${coluna} nao pode mudar na inativacao`);
  }

  // Um debito inativado continua sendo um debito daquele valor, sem efeito.
  assert.equal(depois.tipo, 'debito');
  assert.equal(depois.valor_centavos, 2500);
  assert.equal(
    ctx.db.prepare('SELECT typeof(valor_centavos) AS t FROM ajuste_credito_debito WHERE id = ?').get(ajuste.id).t,
    'integer'
  );

  // O motivo ORIGINAL nao e sobrescrito pelo motivo da inativacao.
  assert.equal(depois.motivo, 'correcao financeira aprovada');
  assert.notEqual(depois.motivo, depois.motivo_inativacao);
});

test('S3: inativacao gera EXATAMENTE uma auditoria, identificando o ajuste', (t) => {
  const ctx = createMigratedDb(t);

  const ajuste = ajusteCompleto(ctx.db);
  const auditoriaAposCriacao = contar(ctx.db, 'audit_log');
  assert.equal(auditoriaAposCriacao, 1);

  inativarAjuste(ctx.db, { ajusteId: ajuste.id, motivo: MOTIVO_INATIVACAO, ator: 'operador' });

  assert.equal(contar(ctx.db, 'audit_log'), auditoriaAposCriacao + 1);

  const linhas = auditoriaDoAjuste(ctx.db, ajuste.id).filter((l) => l.acao === ACAO_AJUSTE_INATIVADO);
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].acao, 'ajuste_credito_debito.inativado');
  assert.equal(linhas[0].entidade_tipo, 'ajuste_credito_debito');
  assert.equal(linhas[0].entidade_id, String(ajuste.id));
  assert.equal(linhas[0].ator, 'operador');

  const meta = JSON.parse(linhas[0].metadados);
  assert.equal(meta.ajusteId, ajuste.id);
  assert.equal(meta.tipo, 'debito');
  assert.equal(meta.valorCentavos, 2500);
  assert.equal(meta.competencia, '2026-04');
  assert.equal(meta.motivo, MOTIVO_INATIVACAO);

  // Nenhum agregado financeiro entra na trilha.
  for (const proibido of [
    'saldo',
    'adimplencia',
    'inadimplencia',
    'totalDevido',
    'totalPago',
    'creditoDisponivel',
    'quitado',
  ]) {
    assert.equal(proibido in meta, false, `metadados nao podem conter '${proibido}'`);
  }
});

test('S4: auditoria mostra ativo true -> false e os campos de inativacao', (t) => {
  const ctx = createMigratedDb(t);

  const ajuste = ajusteCompleto(ctx.db);
  const resultado = inativarAjuste(ctx.db, { ajusteId: ajuste.id, motivo: MOTIVO_INATIVACAO });

  const [linha] = auditoriaDoAjuste(ctx.db, ajuste.id).filter((l) => l.acao === ACAO_AJUSTE_INATIVADO);
  const anterior = JSON.parse(linha.estado_anterior);
  const posterior = JSON.parse(linha.estado_posterior);

  assert.equal(anterior.ativo, true);
  assert.equal(anterior.inativadoEm, null);
  assert.equal(anterior.motivoInativacao, null);

  assert.equal(posterior.ativo, false);
  assert.match(posterior.inativadoEm, TIMESTAMP_RE);
  assert.equal(posterior.motivoInativacao, MOTIVO_INATIVACAO);

  // O estado anterior e o ajuste como ele foi criado; o posterior e o RELIDO do
  // banco, entao bate exatamente com o retorno do servico.
  assert.deepEqual(anterior, ajuste);
  assert.deepEqual(posterior, resultado);

  // Prova de que so o estado mudou: todo o resto e identico nos dois lados.
  for (const campo of [
    'id',
    'associadoId',
    'tipo',
    'valorCentavos',
    'motivo',
    'data',
    'competenciaId',
    'observacao',
    'criadoEm',
  ]) {
    assert.equal(posterior[campo], anterior[campo], `${campo} nao pode mudar na inativacao`);
  }
});

// --- S5..S7: recusas --------------------------------------------------------

test('S5: ajuste inexistente e recusado, sem auditoria', (t) => {
  const ctx = createMigratedDb(t);
  ajusteCompleto(ctx.db);
  const auditoriaAntes = contar(ctx.db, 'audit_log');

  assert.throws(
    () => inativarAjuste(ctx.db, { ajusteId: 9999, motivo: MOTIVO_INATIVACAO }),
    (error) => error instanceof LedgerError && error.codigo === 'ajuste_inexistente'
  );

  assert.equal(contar(ctx.db, 'audit_log'), auditoriaAntes);
  assert.equal(ctx.db.inTransaction, false);
});

test('S6: ajusteId invalido e recusado antes de qualquer leitura', (t) => {
  const ctx = createMigratedDb(t);
  const ajuste = ajusteCompleto(ctx.db);
  const auditoriaAntes = contar(ctx.db, 'audit_log');

  for (const ajusteId of [0, -1, 1.5, NaN, Infinity, '1', 'abc', null, undefined, {}]) {
    assert.throws(
      () => inativarAjuste(ctx.db, { ajusteId, motivo: MOTIVO_INATIVACAO }),
      (error) => error instanceof LedgerError && error.codigo === 'id_invalido',
      `ajusteId ${JSON.stringify(ajusteId)} deveria ser recusado`
    );
  }

  // O ajuste existente continua ATIVO e intacto.
  assert.equal(linhaAjuste(ctx.db, ajuste.id).ativo, 1);
  assert.equal(contar(ctx.db, 'audit_log'), auditoriaAntes);
});

test('S7: motivo ausente ou vazio e recusado e o ajuste continua ativo', (t) => {
  const ctx = createMigratedDb(t);
  const ajuste = ajusteCompleto(ctx.db);
  const auditoriaAntes = contar(ctx.db, 'audit_log');

  for (const motivo of [undefined, null, '', ' ', '   ', '\t\n']) {
    assert.throws(
      () => inativarAjuste(ctx.db, { ajusteId: ajuste.id, motivo }),
      (error) => error instanceof LedgerError && error.codigo === 'motivo_obrigatorio',
      `motivo ${JSON.stringify(motivo)} deveria ser recusado`
    );
  }

  const linha = linhaAjuste(ctx.db, ajuste.id);
  assert.equal(linha.ativo, 1);
  assert.equal(linha.inativado_em, null);
  assert.equal(linha.motivo_inativacao, null);
  assert.equal(contar(ctx.db, 'audit_log'), auditoriaAntes);
  assert.equal(ctx.db.inTransaction, false);
});

// --- S8: dupla inativacao ---------------------------------------------------

test('S8: segunda inativacao falha sem tocar timestamp, motivo ou auditoria', (t) => {
  const ctx = createMigratedDb(t);

  const ajuste = ajusteCompleto(ctx.db);
  inativarAjuste(ctx.db, { ajusteId: ajuste.id, motivo: MOTIVO_INATIVACAO });

  const depoisDaPrimeira = linhaAjuste(ctx.db, ajuste.id);
  const auditoriaDepoisDaPrimeira = contar(ctx.db, 'audit_log');

  assert.throws(
    () => inativarAjuste(ctx.db, { ajusteId: ajuste.id, motivo: 'outro motivo qualquer' }),
    (error) => error instanceof LedgerError && error.codigo === 'ajuste_inativo'
  );

  // A linha nao mudou em NENHUMA coluna: o historico original fica de pe.
  assert.deepEqual(linhaAjuste(ctx.db, ajuste.id), depoisDaPrimeira);
  assert.equal(linhaAjuste(ctx.db, ajuste.id).motivo_inativacao, MOTIVO_INATIVACAO);
  assert.equal(contar(ctx.db, 'audit_log'), auditoriaDepoisDaPrimeira);
  assert.equal(ctx.db.inTransaction, false);
});

// --- S9: rollback (T-07) ----------------------------------------------------

test('S9: falha no audit_log devolve o ajuste ATIVO', (t) => {
  const ctx = createMigratedDb(t);

  const ajuste = ajusteCompleto(ctx.db);
  const antes = linhaAjuste(ctx.db, ajuste.id);
  const auditoriaAntes = contar(ctx.db, 'audit_log');

  comAuditoriaQuebrada(ctx.db, () => {
    assert.throws(() => inativarAjuste(ctx.db, { ajusteId: ajuste.id, motivo: MOTIVO_INATIVACAO }));
  });

  const depois = linhaAjuste(ctx.db, ajuste.id);
  assert.equal(depois.ativo, 1, 'sem trilha, o ajuste continua ativo');
  assert.equal(depois.inativado_em, null);
  assert.equal(depois.motivo_inativacao, null);
  assert.deepEqual(depois, antes, 'nenhuma coluna pode ter sobrado alterada');
  assert.equal(contar(ctx.db, 'audit_log'), auditoriaAntes);
  assert.equal(ctx.db.inTransaction, false);

  // Depois do rollback a operacao volta a funcionar normalmente.
  const resultado = inativarAjuste(ctx.db, { ajusteId: ajuste.id, motivo: MOTIVO_INATIVACAO });
  assert.equal(resultado.ativo, false);
  assert.equal(contar(ctx.db, 'audit_log'), auditoriaAntes + 1);
});

// --- S10: sem efeitos colaterais --------------------------------------------

test('S10: movimentos, alocacoes e demais ajustes ficam identicos', (t) => {
  const ctx = createMigratedDb(t);
  const associadoId = criarAssociado(ctx.db);
  const competenciaId = criarCompetencia(ctx.db, 2026, 4);

  const movimentoId = Number(
    ctx.db
      .prepare(
        `INSERT INTO movimento_financeiro
           (data, valor_centavos, tipo, origem, associado_id, estado_identificacao)
         VALUES (?, ?, 'credito', 'pagamento', ?, 'identificado')`
      )
      .run('2026-05-01', 12000, associadoId).lastInsertRowid
  );
  ctx.db
    .prepare('INSERT INTO alocacao (movimento_id, competencia_id, valor_centavos) VALUES (?, ?, ?)')
    .run(movimentoId, competenciaId, 12000);

  // Dois ajustes: um sera inativado, o outro precisa ficar exatamente como esta.
  const alvo = registrarAjuste(ctx.db, {
    associadoId,
    tipo: 'debito',
    valorCentavos: 2500,
    motivo: 'ajuste a corrigir',
    data: '2026-08-16',
    competenciaId,
  });
  const vizinho = registrarAjuste(ctx.db, {
    associadoId,
    tipo: 'credito',
    valorCentavos: 4000,
    motivo: 'ajuste que nao deve ser tocado',
    data: '2026-08-16',
  });

  const movimentosAntes = ctx.db.prepare('SELECT * FROM movimento_financeiro ORDER BY id').all();
  const alocacoesAntes = ctx.db.prepare('SELECT * FROM alocacao ORDER BY id').all();
  const vizinhoAntes = linhaAjuste(ctx.db, vizinho.id);

  inativarAjuste(ctx.db, { ajusteId: alvo.id, motivo: MOTIVO_INATIVACAO });

  assert.deepEqual(ctx.db.prepare('SELECT * FROM movimento_financeiro ORDER BY id').all(), movimentosAntes);
  assert.deepEqual(ctx.db.prepare('SELECT * FROM alocacao ORDER BY id').all(), alocacoesAntes);
  assert.deepEqual(linhaAjuste(ctx.db, vizinho.id), vizinhoAntes);

  // Nenhum ajuste OPOSTO foi criado automaticamente: continuam exatamente dois.
  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 2);
  assert.equal(contar(ctx.db, 'movimento_financeiro'), 1);
  assert.equal(contar(ctx.db, 'alocacao'), 1);
  assert.equal(contar(ctx.db, 'comprovante'), 0);
  assert.equal(contar(ctx.db, 'pendencia'), 0);
  assert.equal(contar(ctx.db, 'competencia'), 1);
});

// --- S11: seguranca ---------------------------------------------------------

test('S11: motivo/ator maliciosos viram DADO, nunca comando', (t) => {
  const ctx = createMigratedDb(t);

  const ajuste = ajusteCompleto(ctx.db);
  const injecao = "'); DROP TABLE ajuste_credito_debito; --";

  const resultado = inativarAjuste(ctx.db, {
    ajusteId: ajuste.id,
    motivo: injecao,
    ator: injecao,
  });

  // A tabela continua de pe e o texto foi gravado LITERALMENTE.
  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 1);
  assert.equal(resultado.motivoInativacao, injecao);
  assert.equal(linhaAjuste(ctx.db, ajuste.id).motivo_inativacao, injecao);

  const [linha] = auditoriaDoAjuste(ctx.db, ajuste.id).filter((l) => l.acao === ACAO_AJUSTE_INATIVADO);
  assert.equal(linha.ator, injecao);

  // O motivo ORIGINAL do ajuste continua intocado.
  assert.equal(linhaAjuste(ctx.db, ajuste.id).motivo, 'correcao financeira aprovada');
});

test('S12: o retorno da inativacao mantem o mesmo contrato fechado do mapper', (t) => {
  const ctx = createMigratedDb(t);

  const ajuste = ajusteCompleto(ctx.db);
  const resultado = inativarAjuste(ctx.db, { ajusteId: ajuste.id, motivo: MOTIVO_INATIVACAO });

  assert.deepEqual(Object.keys(resultado).sort(), Object.keys(ajuste).sort());
  // Nenhum agregado financeiro aparece no retorno.
  for (const proibido of ['saldo', 'adimplencia', 'totalDevido', 'creditoDisponivel', 'resumo']) {
    assert.equal(proibido in resultado, false, `retorno nao pode conter '${proibido}'`);
  }
});
