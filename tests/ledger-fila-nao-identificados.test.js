'use strict';

// Fase 2C - fila paginada de movimentos NAO IDENTIFICADOS (F-06 / F-10).
//
// A consulta e uma LEITURA: os testes provam tanto o que ela retorna quanto o
// que ela NAO faz — nao altera registro, nao gera auditoria, nao promove
// 'em_revisao' a 'nao_identificado' e nao usa nada do legado como heuristica.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  registrarMovimento,
  identificarMovimento,
  listarMovimentosNaoIdentificados,
  LedgerError,
  PAGINACAO,
} = require('../src/services/ledger');
const { createMigratedDb } = require('./helpers/temp-db');

const MOTIVO = 'Deposito confirmado manualmente apos conferencia do extrato';

function criarAssociado(db, nomeDoAssociado = 'Associado de Teste', legacyId = null) {
  return Number(
    db.prepare('INSERT INTO associado (nome, legacy_id) VALUES (?, ?)').run(nomeDoAssociado, legacyId)
      .lastInsertRowid
  );
}

/** Deposito sem associado: nasce `nao_identificado` (M-05) e entra na fila. */
function depositoNaoIdentificado(db, data = '2026-04-02', valorCentavos = 20000) {
  return registrarMovimento(db, {
    data,
    valorCentavos,
    origem: 'deposito',
    observacao: 'deposito sem identificacao do pagador',
  });
}

function inativar(db, movimentoId) {
  db.prepare(
    'UPDATE movimento_financeiro SET ativo = 0, inativado_em = ?, motivo_inativacao = ? WHERE id = ?'
  ).run('2026-04-03T00:00:00Z', 'lancamento duplicado', movimentoId);
}

function marcarEmRevisao(db, movimentoId) {
  db.prepare("UPDATE movimento_financeiro SET estado_identificacao = 'em_revisao' WHERE id = ?").run(
    movimentoId
  );
}

function ids(resultado) {
  return resultado.itens.map((item) => item.id);
}

function fotografarMovimentos(db) {
  return db.prepare('SELECT * FROM movimento_financeiro ORDER BY id').all();
}

function contarAuditoria(db) {
  return db.prepare('SELECT COUNT(*) AS t FROM audit_log').get().t;
}

// --- T1: elegibilidade ------------------------------------------------------

test('T1: movimento ativo, sem associado e nao_identificado aparece na fila', (t) => {
  const ctx = createMigratedDb(t);

  const movimento = depositoNaoIdentificado(ctx.db);

  const resultado = listarMovimentosNaoIdentificados(ctx.db);

  assert.equal(resultado.itens.length, 1);
  assert.equal(resultado.paginacao.total, 1);

  const item = resultado.itens[0];
  assert.equal(item.id, movimento.id);
  assert.equal(item.data, '2026-04-02');
  assert.equal(item.valorCentavos, 20000);
  assert.equal(item.tipo, 'credito');
  assert.equal(item.origem, 'deposito');
  assert.equal(item.observacao, 'deposito sem identificacao do pagador');
  assert.equal(item.estadoIdentificacao, 'nao_identificado');
  assert.equal(item.associadoId, null);
  assert.match(item.criadoEm, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.match(item.atualizadoEm, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('T1b: valor sai em centavos INTEIROS, nunca convertido para reais (T-06)', (t) => {
  const ctx = createMigratedDb(t);

  depositoNaoIdentificado(ctx.db, '2026-04-02', 15037);

  const [item] = listarMovimentosNaoIdentificados(ctx.db).itens;

  assert.equal(item.valorCentavos, 15037);
  assert.equal(Number.isInteger(item.valorCentavos), true);
  assert.equal(Object.prototype.hasOwnProperty.call(item, 'valor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(item, 'valorReais'), false);
});

// --- T2..T5: quem NAO entra na fila -----------------------------------------

test('T2: movimento identificado nao aparece', (t) => {
  const ctx = createMigratedDb(t);

  const associadoId = criarAssociado(ctx.db);
  const naoIdentificado = depositoNaoIdentificado(ctx.db);
  const identificado = depositoNaoIdentificado(ctx.db, '2026-04-01');

  identificarMovimento(ctx.db, { movimentoId: identificado.id, associadoId, motivo: MOTIVO });

  const resultado = listarMovimentosNaoIdentificados(ctx.db);

  assert.deepEqual(ids(resultado), [naoIdentificado.id]);
  assert.equal(resultado.paginacao.total, 1);
});

test('T3: movimento em_revisao permanece FORA da fila (M-08)', (t) => {
  const ctx = createMigratedDb(t);

  const elegivel = depositoNaoIdentificado(ctx.db);
  const emRevisao = depositoNaoIdentificado(ctx.db, '2026-04-01');
  marcarEmRevisao(ctx.db, emRevisao.id);

  const resultado = listarMovimentosNaoIdentificados(ctx.db);

  assert.deepEqual(ids(resultado), [elegivel.id]);
  assert.equal(resultado.paginacao.total, 1);

  // A ambiguidade declarada continua declarada: a leitura nao promove estado.
  assert.equal(
    ctx.db.prepare('SELECT estado_identificacao FROM movimento_financeiro WHERE id = ?').get(emRevisao.id)
      .estado_identificacao,
    'em_revisao'
  );
});

test('T4: movimento inativo nao aparece (M-09)', (t) => {
  const ctx = createMigratedDb(t);

  const elegivel = depositoNaoIdentificado(ctx.db);
  const inativo = depositoNaoIdentificado(ctx.db, '2026-04-01');
  inativar(ctx.db, inativo.id);

  const resultado = listarMovimentosNaoIdentificados(ctx.db);

  assert.deepEqual(ids(resultado), [elegivel.id]);
  assert.equal(resultado.paginacao.total, 1);

  // M-09: continua no banco, apenas fora da fila operacional.
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM movimento_financeiro').get().t, 2);
});

test('T5: movimento com associado_id preenchido nao aparece, mesmo com estado inconsistente', (t) => {
  const ctx = createMigratedDb(t);

  const elegivel = depositoNaoIdentificado(ctx.db);
  const inconsistente = depositoNaoIdentificado(ctx.db, '2026-04-01');
  const associadoId = criarAssociado(ctx.db);

  // Inconsistencia manual proposital: vinculo gravado direto no banco, sem
  // passar pela identificacao, deixando o estado desatualizado.
  ctx.db
    .prepare('UPDATE movimento_financeiro SET associado_id = ? WHERE id = ?')
    .run(associadoId, inconsistente.id);

  const resultado = listarMovimentosNaoIdentificados(ctx.db);

  assert.deepEqual(ids(resultado), [elegivel.id], 'movimento com associado nunca volta para a fila');
  assert.equal(resultado.paginacao.total, 1);
});

// --- T6: ordenacao deterministica -------------------------------------------

test('T6: a fila e ordenada por data ASC, id ASC de forma estavel', (t) => {
  const ctx = createMigratedDb(t);

  // Inseridos fora de ordem cronologica e com datas repetidas de proposito.
  const c = depositoNaoIdentificado(ctx.db, '2026-05-10');
  const a = depositoNaoIdentificado(ctx.db, '2026-01-05');
  const b1 = depositoNaoIdentificado(ctx.db, '2026-03-01');
  const b2 = depositoNaoIdentificado(ctx.db, '2026-03-01');

  const esperado = [a.id, b1.id, b2.id, c.id];

  assert.deepEqual(ids(listarMovimentosNaoIdentificados(ctx.db)), esperado);
  // Reexecutar devolve exatamente a mesma sequencia.
  assert.deepEqual(ids(listarMovimentosNaoIdentificados(ctx.db)), esperado);

  // Empate de data resolvido pelo id, nao pela ordem de insercao no arquivo.
  assert.ok(b1.id < b2.id);
});

// --- T7..T10: paginacao ------------------------------------------------------

function filaDe(db, quantidade) {
  const criados = [];
  for (let i = 1; i <= quantidade; i += 1) {
    const dia = String(i).padStart(2, '0');
    criados.push(depositoNaoIdentificado(db, `2026-02-${dia}`, 1000 * i).id);
  }
  return criados;
}

test('T7: limite recorta a pagina sem esconder o resto', (t) => {
  const ctx = createMigratedDb(t);
  const criados = filaDe(ctx.db, 5);

  const resultado = listarMovimentosNaoIdentificados(ctx.db, { limite: 2 });

  assert.deepEqual(ids(resultado), criados.slice(0, 2));
  assert.equal(resultado.paginacao.limite, 2);
  assert.equal(resultado.paginacao.offset, 0);
});

test('T8: offset avanca na mesma sequencia', (t) => {
  const ctx = createMigratedDb(t);
  const criados = filaDe(ctx.db, 5);

  const pagina1 = listarMovimentosNaoIdentificados(ctx.db, { limite: 2, offset: 0 });
  const pagina2 = listarMovimentosNaoIdentificados(ctx.db, { limite: 2, offset: 2 });
  const pagina3 = listarMovimentosNaoIdentificados(ctx.db, { limite: 2, offset: 4 });

  assert.deepEqual(ids(pagina1), criados.slice(0, 2));
  assert.deepEqual(ids(pagina2), criados.slice(2, 4));
  assert.deepEqual(ids(pagina3), criados.slice(4, 5));

  // Paginar cobre a fila inteira, sem repetir nem pular ninguem.
  assert.deepEqual([...ids(pagina1), ...ids(pagina2), ...ids(pagina3)], criados);
  assert.equal(pagina2.paginacao.offset, 2);
});

test('T9: total conta os elegiveis ANTES do LIMIT/OFFSET', (t) => {
  const ctx = createMigratedDb(t);
  filaDe(ctx.db, 5);

  // Ruido nao elegivel: nao pode entrar na contagem.
  inativar(ctx.db, depositoNaoIdentificado(ctx.db, '2026-02-20').id);
  marcarEmRevisao(ctx.db, depositoNaoIdentificado(ctx.db, '2026-02-21').id);

  const recorte = listarMovimentosNaoIdentificados(ctx.db, { limite: 2, offset: 1 });

  assert.equal(recorte.itens.length, 2);
  assert.equal(recorte.paginacao.total, 5, 'total nao e reduzido pela pagina');
  assert.equal(listarMovimentosNaoIdentificados(ctx.db, { limite: 200 }).paginacao.total, 5);
});

test('T10: pagina alem do fim devolve lista vazia e mantem o total', (t) => {
  const ctx = createMigratedDb(t);
  filaDe(ctx.db, 3);

  const alemDoFim = listarMovimentosNaoIdentificados(ctx.db, { limite: 10, offset: 3 });

  assert.deepEqual(alemDoFim.itens, []);
  assert.equal(alemDoFim.paginacao.total, 3);
  assert.equal(alemDoFim.paginacao.offset, 3);
});

test('T10b: fila vazia devolve itens vazios e total zero', (t) => {
  const ctx = createMigratedDb(t);

  const resultado = listarMovimentosNaoIdentificados(ctx.db);

  assert.deepEqual(resultado.itens, []);
  assert.equal(resultado.paginacao.total, 0);
  assert.equal(resultado.paginacao.limite, PAGINACAO.limitePadrao);
  assert.equal(resultado.paginacao.offset, PAGINACAO.offsetPadrao);
});

// --- T11: parametros invalidos ----------------------------------------------

test('T11: limite e offset invalidos sao recusados de forma estavel', (t) => {
  const ctx = createMigratedDb(t);
  filaDe(ctx.db, 3);

  const limitesInvalidos = [0, -1, 1.5, PAGINACAO.limiteMaximo + 1, '50', '', true, {}, [], NaN, Infinity];
  for (const limite of limitesInvalidos) {
    assert.throws(
      () => listarMovimentosNaoIdentificados(ctx.db, { limite }),
      (error) => error instanceof LedgerError && error.codigo === 'paginacao_invalida',
      `limite deveria ter sido recusado: ${JSON.stringify(limite)}`
    );
  }

  const offsetsInvalidos = [-1, 2.5, '0', true, {}, NaN, Infinity];
  for (const offset of offsetsInvalidos) {
    assert.throws(
      () => listarMovimentosNaoIdentificados(ctx.db, { offset }),
      (error) => error instanceof LedgerError && error.codigo === 'paginacao_invalida',
      `offset deveria ter sido recusado: ${JSON.stringify(offset)}`
    );
  }

  // Os limites da faixa continuam validos.
  assert.equal(
    listarMovimentosNaoIdentificados(ctx.db, { limite: PAGINACAO.limiteMinimo }).itens.length,
    1
  );
  assert.equal(
    listarMovimentosNaoIdentificados(ctx.db, { limite: PAGINACAO.limiteMaximo, offset: 0 }).paginacao
      .limite,
    PAGINACAO.limiteMaximo
  );
  assert.equal(listarMovimentosNaoIdentificados(ctx.db, { offset: 0 }).paginacao.offset, 0);
});

// --- T12 / T13: leitura sem efeito colateral --------------------------------

test('T12: a consulta nao gera audit_log', (t) => {
  const ctx = createMigratedDb(t);

  filaDe(ctx.db, 3);
  marcarEmRevisao(ctx.db, depositoNaoIdentificado(ctx.db, '2026-02-21').id);

  const auditoriaAntes = contarAuditoria(ctx.db);

  listarMovimentosNaoIdentificados(ctx.db);
  listarMovimentosNaoIdentificados(ctx.db, { limite: 1, offset: 2 });
  assert.throws(() => listarMovimentosNaoIdentificados(ctx.db, { limite: 0 }), LedgerError);

  assert.equal(contarAuditoria(ctx.db), auditoriaAntes, 'leitura nao deixa trilha de alteracao');
});

test('T13: a consulta nao altera nenhum movimento', (t) => {
  const ctx = createMigratedDb(t);

  filaDe(ctx.db, 3);
  const identificado = depositoNaoIdentificado(ctx.db, '2026-02-19');
  identificarMovimento(ctx.db, {
    movimentoId: identificado.id,
    associadoId: criarAssociado(ctx.db),
    motivo: MOTIVO,
  });
  inativar(ctx.db, depositoNaoIdentificado(ctx.db, '2026-02-20').id);
  marcarEmRevisao(ctx.db, depositoNaoIdentificado(ctx.db, '2026-02-21').id);

  const antes = fotografarMovimentos(ctx.db);

  listarMovimentosNaoIdentificados(ctx.db);
  listarMovimentosNaoIdentificados(ctx.db, { limite: 1, offset: 1 });
  listarMovimentosNaoIdentificados(ctx.db, { limite: 10, offset: 99 });

  assert.deepEqual(fotografarMovimentos(ctx.db), antes, 'nenhuma coluna de nenhum movimento mudou');
  assert.equal(ctx.db.inTransaction, false);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM alocacao').get().t, 0);
});

// --- T17: o legado nao participa da fila ------------------------------------

/** Remove comentarios para que as assercoes falem do CODIGO, nao da documentacao. */
function codigoSemComentarios(fonte) {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('T17: a fila e formada so pelo movimento — o legado nao entra na consulta', (t) => {
  const ctx = createMigratedDb(t);

  const codigo = codigoSemComentarios(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'ledger.js'), 'utf8')
  );
  for (const proibido of ['legacy_cell', 'legacy_id', 'BJ', 'BM', 'BN']) {
    assert.equal(codigo.includes(proibido), false, `a fila nao pode depender de ${proibido}`);
  }

  // Ruido proposital: legacy_id '37' e um deposito terminado em 37 centavos.
  criarAssociado(ctx.db, 'Fulano de Tal', '37');
  const movimento = depositoNaoIdentificado(ctx.db, '2026-04-02', 15037);

  const [item] = listarMovimentosNaoIdentificados(ctx.db).itens;

  // 15037 e apenas o valor do movimento: nao vira associado, nem palpite.
  assert.equal(item.id, movimento.id);
  assert.equal(item.valorCentavos, 15037);
  assert.equal(item.associadoId, null);
  assert.equal(item.estadoIdentificacao, 'nao_identificado');
  assert.equal(Object.prototype.hasOwnProperty.call(item, 'associadoSugerido'), false);
  assert.equal(
    ctx.db.prepare('SELECT associado_id FROM movimento_financeiro WHERE id = ?').get(movimento.id)
      .associado_id,
    null
  );
});

// --- integracao com a Fase 2B -----------------------------------------------

test('identificar um movimento o remove da fila, sem tocar nos demais', (t) => {
  const ctx = createMigratedDb(t);

  const criados = filaDe(ctx.db, 3);
  const associadoId = criarAssociado(ctx.db);

  assert.equal(listarMovimentosNaoIdentificados(ctx.db).paginacao.total, 3);

  identificarMovimento(ctx.db, { movimentoId: criados[1], associadoId, motivo: MOTIVO });

  const depois = listarMovimentosNaoIdentificados(ctx.db);
  assert.deepEqual(ids(depois), [criados[0], criados[2]]);
  assert.equal(depois.paginacao.total, 2);
});
