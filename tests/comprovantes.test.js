'use strict';

// Fase 4A - estado de comprovante e pendencia de evidencia (M-04 / F-05 / F-10 / F-11).
//
// O que estes testes provam, em uma frase: a situacao do comprovante e um DADO
// ESTRUTURADO, com quatro estados, auditavel, e que nao encosta em nenhum valor
// financeiro.
//
// Provam tambem o que o servico se RECUSA a fazer: nao trata ausencia de
// registro como 'ausente', nao le a observacao para decidir estado, nao aceita
// vocabulario fora dos quatro estados, nao mistura outras pendencias na fila e
// nao guarda arquivo nenhum.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  obterComprovanteDoMovimento,
  obterComprovantesDeMovimentos,
  definirComprovanteDoMovimento,
  listarPendenciasDeComprovante,
  ComprovanteError,
  ESTADOS,
  ESTADOS_PENDENTES,
  SEM_REGISTRO,
  ACAO_COMPROVANTE_REGISTRADO,
  ACAO_COMPROVANTE_ALTERADO,
} = require('../src/services/comprovantes');
const {
  registrarMovimento,
  alocarMovimento,
  inativarMovimento,
  registrarAjuste,
} = require('../src/services/ledger');
const { runMigrations } = require('../src/db/migrator');
const { createMigratedDb, tempWorkspace } = require('./helpers/temp-db');

/** Timestamp UTC gravado pelo SQLite (strftime), nao pelo Node. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

const OBSERVACAO = 'Comprovante solicitado ao associado.';

function criarAssociado(db, rotulo = 'Associado de Teste') {
  return Number(db.prepare('INSERT INTO associado (nome) VALUES (?)').run(rotulo).lastInsertRowid);
}

function criarCompetencia(db, ano, mes) {
  return Number(
    db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)').run(ano, mes).lastInsertRowid
  );
}

/** Movimento identificado, com valor e observacao proprios. */
function criarMovimento(db, { valorCentavos = 12000, data = '2026-05-04' } = {}) {
  return registrarMovimento(db, {
    data,
    valorCentavos,
    origem: 'pagamento',
    associadoId: criarAssociado(db),
    observacao: 'pagamento conferido no extrato',
  });
}

function linhaMovimento(db, id) {
  return db.prepare('SELECT * FROM movimento_financeiro WHERE id = ?').get(id);
}

function linhasComprovante(db, movimentoId) {
  return db.prepare('SELECT * FROM comprovante WHERE movimento_id = ?').all(movimentoId);
}

function contar(db, tabela) {
  return db.prepare(`SELECT COUNT(*) AS t FROM ${tabela}`).get().t;
}

function auditoria(db, acao = null) {
  return acao === null
    ? db.prepare('SELECT * FROM audit_log ORDER BY id').all()
    : db.prepare('SELECT * FROM audit_log WHERE acao = ? ORDER BY id').all(acao);
}

function indices(db, tabela) {
  return db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
    .all(tabela);
}

/** Falha induzida DEPOIS da gravacao e dentro da mesma transacao. */
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

// --- C1 / C2: migration em banco vazio ---------------------------------------

test('C1: a migration 003 nasce aplicada em banco vazio, com unicidade e indice de estado', (t) => {
  const ws = tempWorkspace(t);
  const db = ws.open();

  const { applied } = runMigrations(db);

  assert.ok(
    applied.includes('003_comprovante_por_movimento.sql'),
    'a migration da Fase 4A precisa rodar do zero'
  );

  const nomes = indices(db, 'comprovante').map((indice) => indice.name);
  assert.ok(nomes.includes('ux_comprovante_movimento'), 'indice de unicidade ausente');
  assert.ok(nomes.includes('ix_comprovante_estado'), 'indice de estado ausente');

  // Nenhuma coluna de arquivo foi criada nesta fase (C-06 segue TO CONFIRM).
  const colunas = db
    .prepare('PRAGMA table_info(comprovante)')
    .all()
    .map((coluna) => coluna.name);
  for (const proibida of ['arquivo', 'caminho', 'blob', 'conteudo', 'url', 'anexo']) {
    assert.equal(colunas.includes(proibida), false, `coluna de arquivo nao pode existir: ${proibida}`);
  }
});

test('C2: o banco recusa dois comprovantes para o mesmo movimento (constraint, nao so JS)', (t) => {
  const ctx = createMigratedDb(t);
  const movimento = criarMovimento(ctx.db);

  ctx.db
    .prepare('INSERT INTO comprovante (movimento_id, estado) VALUES (?, ?)')
    .run(movimento.id, 'pendente');

  assert.throws(
    () =>
      ctx.db
        .prepare('INSERT INTO comprovante (movimento_id, estado) VALUES (?, ?)')
        .run(movimento.id, 'presente'),
    /UNIQUE/i
  );

  // M-04: comprovante SEM movimento continua podendo existir mais de uma vez.
  ctx.db.prepare('INSERT INTO comprovante (estado) VALUES (?)').run('pendente');
  ctx.db.prepare('INSERT INTO comprovante (estado) VALUES (?)').run('pendente');
  assert.equal(contar(ctx.db, 'comprovante'), 3);
});

// --- C3 / C4: ausencia de registro NAO e 'ausente' ---------------------------

test('C3: movimento sem comprovante e sem_registro, nunca ausente', (t) => {
  const ctx = createMigratedDb(t);
  const movimento = criarMovimento(ctx.db);

  const evidencia = obterComprovanteDoMovimento(ctx.db, movimento.id);

  assert.equal(evidencia.registrado, false);
  assert.equal(evidencia.estado, null, 'sem registro nao tem estado de dominio');
  assert.equal(evidencia.estadoTecnico, SEM_REGISTRO);
  assert.notEqual(evidencia.estadoTecnico, 'ausente');
  assert.equal(evidencia.pendenteDeEvidencia, false, 'pendencia e declarada, nunca deduzida do vazio');
  assert.equal(evidencia.registro, null);
  assert.equal(contar(ctx.db, 'comprovante'), 0, 'ler nao pode criar registro');
});

test('C4: o estado tecnico sem_registro nao e aceito como estado de dominio', (t) => {
  const ctx = createMigratedDb(t);
  const movimento = criarMovimento(ctx.db);

  assert.throws(
    () => definirComprovanteDoMovimento(ctx.db, { movimentoId: movimento.id, estado: SEM_REGISTRO }),
    (erro) => erro instanceof ComprovanteError && erro.codigo === 'estado_comprovante_invalido'
  );
  assert.equal(contar(ctx.db, 'comprovante'), 0);
});

// --- C5..C8: registro e consulta ---------------------------------------------

test('C5: os quatro estados previstos sao aceitos e persistidos', (t) => {
  const ctx = createMigratedDb(t);

  assert.deepEqual([...ESTADOS], ['presente', 'ausente', 'pendente', 'nao_aplicavel']);

  for (const estado of ESTADOS) {
    const movimento = criarMovimento(ctx.db);
    const resultado = definirComprovanteDoMovimento(ctx.db, {
      movimentoId: movimento.id,
      estado,
    });

    assert.equal(resultado.alteracao, 'registrado');
    assert.equal(resultado.estado, estado);
    assert.equal(resultado.registrado, true);
    assert.equal(linhasComprovante(ctx.db, movimento.id)[0].estado, estado);
  }
});

test('C6: registrar grava linha unica, com timestamps do banco e sem arquivo', (t) => {
  const ctx = createMigratedDb(t);
  const movimento = criarMovimento(ctx.db);

  const resultado = definirComprovanteDoMovimento(ctx.db, {
    movimentoId: movimento.id,
    estado: 'pendente',
    observacao: OBSERVACAO,
  });

  const linhas = linhasComprovante(ctx.db, movimento.id);
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].estado, 'pendente');
  assert.equal(linhas[0].observacao, OBSERVACAO);
  assert.equal(linhas[0].referencia_externa, null, 'nenhum arquivo/referencia e gravado na Fase 4A');
  assert.equal(linhas[0].data, null);
  assert.match(linhas[0].criado_em, TIMESTAMP_RE);
  assert.match(linhas[0].atualizado_em, TIMESTAMP_RE);

  assert.equal(resultado.movimentoId, movimento.id);
  assert.equal(resultado.pendenteDeEvidencia, true);
  assert.equal(resultado.observacao, OBSERVACAO);
  assert.equal(resultado.registro.referenciaExterna, null);
});

test('C7: a consulta devolve exatamente o estado registrado', (t) => {
  const ctx = createMigratedDb(t);
  const movimento = criarMovimento(ctx.db);
  definirComprovanteDoMovimento(ctx.db, {
    movimentoId: movimento.id,
    estado: 'presente',
    observacao: 'Documento conferido pela administração.',
  });

  const evidencia = obterComprovanteDoMovimento(ctx.db, movimento.id);

  assert.equal(evidencia.registrado, true);
  assert.equal(evidencia.estado, 'presente');
  assert.equal(evidencia.estadoTecnico, 'presente');
  assert.equal(evidencia.pendenteDeEvidencia, false);
  assert.equal(evidencia.observacao, 'Documento conferido pela administração.');
  assert.equal(evidencia.registro.movimentoId, movimento.id);
});

test('C8: a caixa da palavra e normalizada, o significado nunca', (t) => {
  const ctx = createMigratedDb(t);
  const movimento = criarMovimento(ctx.db);

  // Mesma normalizacao ja aplicada a `origem` e ao `tipo` de ajuste.
  const resultado = definirComprovanteDoMovimento(ctx.db, {
    movimentoId: movimento.id,
    estado: '  NAO_APLICAVEL ',
  });
  assert.equal(resultado.estado, 'nao_aplicavel');

  // Traduzir vocabulario seria interpretar: recusado.
  for (const invalido of ['OK', 'nao aplicavel', 'N/A', 'sim', 'recebido', '', '   ', null, 7, {}]) {
    assert.throws(
      () =>
        definirComprovanteDoMovimento(ctx.db, { movimentoId: movimento.id, estado: invalido }),
      (erro) => erro instanceof ComprovanteError && erro.codigo === 'estado_comprovante_invalido',
      `estado invalido aceito: ${String(invalido)}`
    );
  }

  assert.equal(linhasComprovante(ctx.db, movimento.id)[0].estado, 'nao_aplicavel', 'nada foi sobrescrito');
});

// --- C9 / C10: observacao ----------------------------------------------------

test('C9: observacao e opcional; vazia ou so espaco vira ausencia, nao texto vazio', (t) => {
  const ctx = createMigratedDb(t);
  const semObservacao = criarMovimento(ctx.db);
  const observacaoVazia = criarMovimento(ctx.db);

  const a = definirComprovanteDoMovimento(ctx.db, {
    movimentoId: semObservacao.id,
    estado: 'presente',
  });
  const b = definirComprovanteDoMovimento(ctx.db, {
    movimentoId: observacaoVazia.id,
    estado: 'ausente',
    observacao: '   ',
  });

  assert.equal(a.observacao, null);
  assert.equal(b.observacao, null);
  assert.equal(linhasComprovante(ctx.db, semObservacao.id)[0].observacao, null);
  assert.equal(linhasComprovante(ctx.db, observacaoVazia.id)[0].observacao, null);
});

test('C10: a observacao e preservada verbatim e NAO decide o estado oficial', (t) => {
  const ctx = createMigratedDb(t);
  const movimento = criarMovimento(ctx.db);

  const texto = 'associado disse que o comprovante esta ausente e pendente de envio';
  const resultado = definirComprovanteDoMovimento(ctx.db, {
    movimentoId: movimento.id,
    estado: 'presente',
    observacao: texto,
  });

  // O texto fala em "ausente" e "pendente"; a situacao oficial continua sendo o
  // campo estruturado.
  assert.equal(resultado.estado, 'presente');
  assert.equal(resultado.pendenteDeEvidencia, false);
  assert.equal(linhasComprovante(ctx.db, movimento.id)[0].observacao, texto);
  assert.equal(listarPendenciasDeComprovante(ctx.db).paginacao.total, 0);
});

// --- C11..C13: alteracao de estado e idempotencia ----------------------------

test('C11: pendente -> presente atualiza a mesma linha e mantem uma so', (t) => {
  const ctx = createMigratedDb(t);
  const movimento = criarMovimento(ctx.db);

  const registrado = definirComprovanteDoMovimento(ctx.db, {
    movimentoId: movimento.id,
    estado: 'pendente',
    observacao: OBSERVACAO,
  });
  ctx.db
    .prepare('UPDATE comprovante SET atualizado_em = ? WHERE id = ?')
    .run('2000-01-01T00:00:00Z', registrado.registro.id);

  const alterado = definirComprovanteDoMovimento(ctx.db, {
    movimentoId: movimento.id,
    estado: 'presente',
    observacao: 'Documento conferido pela administração.',
  });

  assert.equal(alterado.alteracao, 'alterado');
  assert.equal(alterado.estado, 'presente');
  assert.equal(alterado.registro.id, registrado.registro.id, 'a mesma linha e atualizada');

  const linhas = linhasComprovante(ctx.db, movimento.id);
  assert.equal(linhas.length, 1, 'alterar nao pode duplicar comprovante');
  assert.equal(linhas[0].criado_em, registrado.registro.criadoEm, 'criado_em nao se move');
  assert.match(linhas[0].atualizado_em, TIMESTAMP_RE);
  assert.notEqual(linhas[0].atualizado_em, '2000-01-01T00:00:00Z', 'atualizado_em precisa ser refeito');
});

test('C12: reenviar estado e observacao identicos e reconhecido sem mudanca', (t) => {
  const ctx = createMigratedDb(t);
  const movimento = criarMovimento(ctx.db);

  const primeiro = definirComprovanteDoMovimento(ctx.db, {
    movimentoId: movimento.id,
    estado: 'pendente',
    observacao: OBSERVACAO,
  });
  const auditoriaAposPrimeiro = contar(ctx.db, 'audit_log');
  ctx.db
    .prepare('UPDATE comprovante SET atualizado_em = ? WHERE id = ?')
    .run('2000-01-01T00:00:00Z', primeiro.registro.id);

  const repetido = definirComprovanteDoMovimento(ctx.db, {
    movimentoId: movimento.id,
    estado: 'pendente',
    observacao: OBSERVACAO,
  });

  assert.equal(repetido.alteracao, 'sem_mudanca');
  assert.equal(repetido.estado, 'pendente');
  assert.equal(linhasComprovante(ctx.db, movimento.id).length, 1, 'sem duplicacao');
  assert.equal(
    linhasComprovante(ctx.db, movimento.id)[0].atualizado_em,
    '2000-01-01T00:00:00Z',
    'reenvio identico nao move o timestamp'
  );
  assert.equal(
    contar(ctx.db, 'audit_log'),
    auditoriaAposPrimeiro,
    'reenvio identico nao gera segunda linha de auditoria'
  );
});

test('C13: mudar SO a observacao e alteracao, e e auditada', (t) => {
  const ctx = createMigratedDb(t);
  const movimento = criarMovimento(ctx.db);

  definirComprovanteDoMovimento(ctx.db, { movimentoId: movimento.id, estado: 'pendente' });
  const resultado = definirComprovanteDoMovimento(ctx.db, {
    movimentoId: movimento.id,
    estado: 'pendente',
    observacao: 'Cobrado por telefone em 12/05.',
  });

  assert.equal(resultado.alteracao, 'alterado');
  assert.equal(resultado.estado, 'pendente');

  const trilha = auditoria(ctx.db, ACAO_COMPROVANTE_ALTERADO);
  assert.equal(trilha.length, 1);
  const metadados = JSON.parse(trilha[0].metadados);
  assert.equal(metadados.estadoAnterior, 'pendente');
  assert.equal(metadados.estadoNovo, 'pendente');
  assert.equal(metadados.observacao, 'Cobrado por telefone em 12/05.');
});

// --- C14 / C15: movimento inexistente e transacao ----------------------------

test('C14: movimento inexistente falha de forma controlada, na leitura e na escrita', (t) => {
  const ctx = createMigratedDb(t);

  for (const chamada of [
    () => obterComprovanteDoMovimento(ctx.db, 9999),
    () => definirComprovanteDoMovimento(ctx.db, { movimentoId: 9999, estado: 'pendente' }),
  ]) {
    assert.throws(
      chamada,
      (erro) => erro instanceof ComprovanteError && erro.codigo === 'movimento_inexistente'
    );
  }

  // Id malformado e recusado antes de qualquer consulta.
  for (const id of [0, -1, 1.5, '3', null, undefined]) {
    assert.throws(
      () => definirComprovanteDoMovimento(ctx.db, { movimentoId: id, estado: 'pendente' }),
      (erro) => erro instanceof ComprovanteError && erro.codigo === 'id_invalido'
    );
  }

  assert.equal(contar(ctx.db, 'comprovante'), 0);
  assert.equal(contar(ctx.db, 'audit_log'), 0);
});

test('C15: falha na auditoria desfaz o registro do comprovante (T-07)', (t) => {
  const ctx = createMigratedDb(t);
  const movimento = criarMovimento(ctx.db);
  const auditoriaAntes = contar(ctx.db, 'audit_log');

  comAuditoriaQuebrada(ctx.db, () => {
    assert.throws(
      () =>
        definirComprovanteDoMovimento(ctx.db, { movimentoId: movimento.id, estado: 'pendente' }),
      /falha induzida na auditoria/
    );
  });

  assert.equal(contar(ctx.db, 'comprovante'), 0, 'nao existe evidencia sem trilha');
  assert.equal(contar(ctx.db, 'audit_log'), auditoriaAntes);
});

// --- C16 / C17: auditoria (F-11) ---------------------------------------------

test('C16: o registro inicial deixa trilha com movimento, sem_registro -> estado e ator', (t) => {
  const ctx = createMigratedDb(t);
  const movimento = criarMovimento(ctx.db);

  const resultado = definirComprovanteDoMovimento(ctx.db, {
    movimentoId: movimento.id,
    estado: 'pendente',
    observacao: OBSERVACAO,
    ator: 'operacao-acasa',
  });

  const trilha = auditoria(ctx.db, ACAO_COMPROVANTE_REGISTRADO);
  assert.equal(trilha.length, 1);

  const registro = trilha[0];
  assert.equal(registro.entidade_tipo, 'comprovante');
  assert.equal(registro.entidade_id, String(resultado.registro.id));
  assert.equal(registro.ator, 'operacao-acasa');
  assert.match(registro.criado_em, TIMESTAMP_RE);
  assert.equal(registro.estado_anterior, null, 'nao havia linha antes');

  const posterior = JSON.parse(registro.estado_posterior);
  assert.equal(posterior.estado, 'pendente');
  assert.equal(posterior.movimentoId, movimento.id);

  const metadados = JSON.parse(registro.metadados);
  assert.equal(metadados.movimentoId, movimento.id);
  assert.equal(metadados.estadoAnterior, SEM_REGISTRO, 'ausencia de registro e declarada como tal');
  assert.equal(metadados.estadoNovo, 'pendente');
  assert.equal(metadados.observacao, OBSERVACAO);
  assert.equal(metadados.origemRegistro, 'manual');
});

test('C17: a mudanca de estado grava estado anterior e posterior, com ator padrao', (t) => {
  const ctx = createMigratedDb(t);
  const movimento = criarMovimento(ctx.db);

  definirComprovanteDoMovimento(ctx.db, { movimentoId: movimento.id, estado: 'pendente' });
  definirComprovanteDoMovimento(ctx.db, {
    movimentoId: movimento.id,
    estado: 'presente',
    observacao: 'Documento conferido pela administração.',
  });

  const trilha = auditoria(ctx.db, ACAO_COMPROVANTE_ALTERADO);
  assert.equal(trilha.length, 1);

  const registro = trilha[0];
  assert.equal(registro.ator, 'sistema', 'sem autenticacao: ator tecnico padrao do projeto');
  assert.equal(JSON.parse(registro.estado_anterior).estado, 'pendente');
  assert.equal(JSON.parse(registro.estado_posterior).estado, 'presente');

  const metadados = JSON.parse(registro.metadados);
  assert.equal(metadados.estadoAnterior, 'pendente');
  assert.equal(metadados.estadoNovo, 'presente');
  assert.equal(metadados.movimentoId, movimento.id);

  // A trilha completa da evidencia continua legivel na ordem em que aconteceu.
  const daEntidade = ctx.db
    .prepare("SELECT acao FROM audit_log WHERE entidade_tipo = 'comprovante' ORDER BY id")
    .all()
    .map((linha) => linha.acao);
  assert.deepEqual(daEntidade, [ACAO_COMPROVANTE_REGISTRADO, ACAO_COMPROVANTE_ALTERADO]);
});

// --- C18 / C19: nada financeiro e tocado -------------------------------------

test('C18: registrar e alterar comprovante nao muda o movimento nem suas alocacoes', (t) => {
  const ctx = createMigratedDb(t);
  const movimento = criarMovimento(ctx.db, { valorCentavos: 15035 });
  const alocacao = alocarMovimento(ctx.db, {
    movimentoId: movimento.id,
    competenciaId: criarCompetencia(ctx.db, 2026, 5),
    valorCentavos: 15035,
  });

  const movimentoAntes = linhaMovimento(ctx.db, movimento.id);
  const alocacoesAntes = ctx.db.prepare('SELECT * FROM alocacao ORDER BY id').all();

  definirComprovanteDoMovimento(ctx.db, { movimentoId: movimento.id, estado: 'pendente' });
  definirComprovanteDoMovimento(ctx.db, { movimentoId: movimento.id, estado: 'presente' });

  assert.deepEqual(linhaMovimento(ctx.db, movimento.id), movimentoAntes, 'movimento intacto');
  assert.deepEqual(
    ctx.db.prepare('SELECT * FROM alocacao ORDER BY id').all(),
    alocacoesAntes,
    'alocacoes intactas'
  );
  assert.equal(alocacao.resumo.alocadoCentavos, 15035);

  // Nenhuma entidade financeira nasceu por causa da evidencia.
  assert.equal(contar(ctx.db, 'movimento_financeiro'), 1);
  assert.equal(contar(ctx.db, 'alocacao'), 1);
  assert.equal(contar(ctx.db, 'ajuste_credito_debito'), 0);
  assert.equal(contar(ctx.db, 'pendencia'), 0, 'a fila de comprovante nao cria linha em `pendencia`');
});

test('C19: movimento inativado aceita evidencia e NAO e reativado por isso (M-09)', (t) => {
  const ctx = createMigratedDb(t);
  const movimento = criarMovimento(ctx.db);
  inativarMovimento(ctx.db, {
    movimentoId: movimento.id,
    motivo: 'Lancamento duplicado: o mesmo deposito foi digitado duas vezes',
  });
  const inativoAntes = linhaMovimento(ctx.db, movimento.id);

  const resultado = definirComprovanteDoMovimento(ctx.db, {
    movimentoId: movimento.id,
    estado: 'presente',
    observacao: 'Comprovante recebido depois da correção.',
  });

  assert.equal(resultado.estado, 'presente');
  assert.deepEqual(linhaMovimento(ctx.db, movimento.id), inativoAntes, 'movimento inativado intacto');
  assert.equal(linhaMovimento(ctx.db, movimento.id).ativo, 0);
});

// --- C20..C24: fila de pendencia de evidencia (F-05 / F-10) ------------------

test('C20: PENDENTE e AUSENTE entram na fila; PRESENTE e NAO_APLICAVEL nao', (t) => {
  const ctx = createMigratedDb(t);

  const porEstado = new Map();
  for (const estado of ESTADOS) {
    const movimento = criarMovimento(ctx.db);
    definirComprovanteDoMovimento(ctx.db, { movimentoId: movimento.id, estado });
    porEstado.set(estado, movimento.id);
  }

  const fila = listarPendenciasDeComprovante(ctx.db);
  const ids = fila.itens.map((item) => item.movimentoId);

  assert.deepEqual([...ESTADOS_PENDENTES], ['pendente', 'ausente']);
  assert.equal(fila.paginacao.total, 2);
  assert.ok(ids.includes(porEstado.get('pendente')), 'PENDENTE precisa aparecer');
  assert.ok(ids.includes(porEstado.get('ausente')), 'AUSENTE precisa aparecer');
  assert.equal(ids.includes(porEstado.get('presente')), false, 'PRESENTE nao e pendencia');
  assert.equal(
    ids.includes(porEstado.get('nao_aplicavel')),
    false,
    'NAO_APLICAVEL nao e pendencia'
  );

  const pendente = fila.itens.find((item) => item.estado === 'pendente');
  assert.equal(pendente.movimento.valorCentavos, 12000, 'valor continua em centavos inteiros');
  assert.equal(pendente.movimento.ativo, true);
  assert.match(pendente.atualizadoEm, TIMESTAMP_RE);
});

test('C21: movimento sem registro e comprovante sem movimento ficam fora da fila', (t) => {
  const ctx = createMigratedDb(t);

  // Movimento existente, nenhuma declaracao sobre a evidencia dele.
  criarMovimento(ctx.db);
  // M-04: comprovante independente, pendente, sem movimento algum.
  ctx.db.prepare('INSERT INTO comprovante (estado) VALUES (?)').run('pendente');

  const fila = listarPendenciasDeComprovante(ctx.db);

  assert.equal(fila.paginacao.total, 0, 'ausencia de registro nao e pendencia declarada');
  assert.deepEqual(fila.itens, []);
});

test('C22: a fila filtra por estado e recusa estado que ela nao serve', (t) => {
  const ctx = createMigratedDb(t);
  const pendenteId = criarMovimento(ctx.db).id;
  const ausenteId = criarMovimento(ctx.db).id;
  definirComprovanteDoMovimento(ctx.db, { movimentoId: pendenteId, estado: 'pendente' });
  definirComprovanteDoMovimento(ctx.db, { movimentoId: ausenteId, estado: 'ausente' });

  const soPendente = listarPendenciasDeComprovante(ctx.db, { estado: 'pendente' });
  assert.deepEqual(
    soPendente.itens.map((item) => item.movimentoId),
    [pendenteId]
  );

  const soAusente = listarPendenciasDeComprovante(ctx.db, { estado: 'AUSENTE' });
  assert.deepEqual(
    soAusente.itens.map((item) => item.movimentoId),
    [ausenteId]
  );

  // Pedir 'presente' seria pedir uma pendencia que nao existe: recusado em vez
  // de devolver lista vazia, que seria lida como "nada pendente".
  for (const estado of ['presente', 'nao_aplicavel', 'OK']) {
    assert.throws(
      () => listarPendenciasDeComprovante(ctx.db, { estado }),
      (erro) => erro instanceof ComprovanteError && erro.codigo === 'estado_comprovante_invalido'
    );
  }
});

test('C23: a fila e paginada, com total contado antes do recorte', (t) => {
  const ctx = createMigratedDb(t);
  for (let i = 0; i < 3; i += 1) {
    const movimento = criarMovimento(ctx.db, { data: `2026-05-0${i + 1}` });
    definirComprovanteDoMovimento(ctx.db, { movimentoId: movimento.id, estado: 'pendente' });
  }

  const pagina = listarPendenciasDeComprovante(ctx.db, { limite: 2, offset: 0 });
  assert.equal(pagina.itens.length, 2);
  assert.equal(pagina.paginacao.total, 3);

  const alemDoFim = listarPendenciasDeComprovante(ctx.db, { limite: 2, offset: 10 });
  assert.deepEqual(alemDoFim.itens, []);
  assert.equal(alemDoFim.paginacao.total, 3);

  // Ordem cronologica estavel.
  assert.deepEqual(
    listarPendenciasDeComprovante(ctx.db).itens.map((item) => item.movimento.data),
    ['2026-05-01', '2026-05-02', '2026-05-03']
  );

  for (const invalido of [{ limite: 0 }, { limite: 201 }, { limite: '10' }, { offset: -1 }]) {
    assert.throws(
      () => listarPendenciasDeComprovante(ctx.db, invalido),
      (erro) => erro instanceof ComprovanteError && erro.codigo === 'paginacao_invalida'
    );
  }
});

test('C24: pendencia de comprovante nao se mistura com outras pendencias', (t) => {
  const ctx = createMigratedDb(t);

  // Deposito nao identificado (F-06): pendencia de OUTRA natureza.
  registrarMovimento(ctx.db, { data: '2026-05-02', valorCentavos: 20000, origem: 'deposito' });
  // Ajuste de debito: tambem nao e pendencia de evidencia.
  registrarAjuste(ctx.db, {
    associadoId: criarAssociado(ctx.db, 'Com Ajuste'),
    tipo: 'debito',
    valorCentavos: 4000,
    motivo: 'acerto combinado com a administracao',
    data: '2026-05-02',
  });

  const comPendencia = criarMovimento(ctx.db);
  definirComprovanteDoMovimento(ctx.db, { movimentoId: comPendencia.id, estado: 'ausente' });

  const fila = listarPendenciasDeComprovante(ctx.db);

  assert.equal(fila.paginacao.total, 1, 'apenas a pendencia de comprovante');
  assert.equal(fila.itens[0].movimentoId, comPendencia.id);
});

test('C25: movimento inativado com pendencia continua na fila, com o estado real visivel', (t) => {
  const ctx = createMigratedDb(t);
  const movimento = criarMovimento(ctx.db);
  definirComprovanteDoMovimento(ctx.db, { movimentoId: movimento.id, estado: 'pendente' });
  inativarMovimento(ctx.db, { movimentoId: movimento.id, motivo: 'lancamento digitado duas vezes' });

  const fila = listarPendenciasDeComprovante(ctx.db);

  assert.equal(fila.paginacao.total, 1, 'esconder seria decidir que evidencia deixou de importar');
  assert.equal(fila.itens[0].movimento.ativo, false, 'o estado real do movimento vai junto');
});

// --- C26: leitura em lote (usada pela tela) ----------------------------------

test('C26: a leitura em lote devolve uma entrada por movimento, inclusive sem registro', (t) => {
  const ctx = createMigratedDb(t);
  const comRegistro = criarMovimento(ctx.db);
  const semRegistro = criarMovimento(ctx.db);
  definirComprovanteDoMovimento(ctx.db, { movimentoId: comRegistro.id, estado: 'ausente' });

  const mapa = obterComprovantesDeMovimentos(ctx.db, [comRegistro.id, semRegistro.id]);

  assert.equal(mapa.size, 2);
  assert.equal(mapa.get(comRegistro.id).estado, 'ausente');
  assert.equal(mapa.get(semRegistro.id).estadoTecnico, SEM_REGISTRO);
  assert.equal(mapa.get(semRegistro.id).estado, null, 'sem registro nunca vira ausente');

  assert.equal(obterComprovantesDeMovimentos(ctx.db, []).size, 0);
});
