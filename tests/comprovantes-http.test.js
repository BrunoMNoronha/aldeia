'use strict';

// Fase 4A - superficie HTTP e tela do estado de comprovante.
// As regras estao em tests/comprovantes.test.js; aqui se verifica que as rotas
// delegam ao servico, traduzem erro de dominio em status HTTP e que o estado
// aparece EM PALAVRAS no HTML entregue ao navegador.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/web/app');
const { registrarMovimento } = require('../src/services/ledger');
const { definirComprovanteDoMovimento } = require('../src/services/comprovantes');
const { createMigratedDb } = require('./helpers/temp-db');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function subir(t) {
  const ctx = createMigratedDb(t);
  const { server, baseUrl } = await listen(createApp({ db: ctx.db }));
  t.after(() => close(server));
  return { ...ctx, baseUrl };
}

function putJson(baseUrl, rota, corpo) {
  return fetch(`${baseUrl}${rota}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

function criarAssociado(db, nome = 'Associado HTTP') {
  return Number(db.prepare('INSERT INTO associado (nome) VALUES (?)').run(nome).lastInsertRowid);
}

function criarMovimento(db, associadoId, valorCentavos = 15035) {
  return registrarMovimento(db, {
    data: '2026-06-01',
    valorCentavos,
    origem: 'pagamento',
    associadoId,
  });
}

async function obterHtml(baseUrl, rota) {
  const response = await fetch(`${baseUrl}${rota}`);
  return { response, html: await response.text() };
}

// --- GET /api/movimentos/:id/comprovante -------------------------------------

test('HC1: GET sem registro responde 200 com sem_registro, nunca ausente', async (t) => {
  const ctx = await subir(t);
  const movimento = criarMovimento(ctx.db, criarAssociado(ctx.db));

  const response = await fetch(`${ctx.baseUrl}/api/movimentos/${movimento.id}/comprovante`);
  const corpo = await response.json();

  assert.equal(response.status, 200);
  assert.equal(corpo.comprovante.registrado, false);
  assert.equal(corpo.comprovante.estado, null);
  assert.equal(corpo.comprovante.estadoTecnico, 'sem_registro');
  assert.equal(corpo.comprovante.pendenteDeEvidencia, false);
});

test('HC2: GET de movimento inexistente ou malformado responde 404/422', async (t) => {
  const ctx = await subir(t);

  const inexistente = await fetch(`${ctx.baseUrl}/api/movimentos/9999/comprovante`);
  assert.equal(inexistente.status, 404);
  assert.equal((await inexistente.json()).codigo, 'movimento_inexistente');

  const malformado = await fetch(`${ctx.baseUrl}/api/movimentos/abc/comprovante`);
  assert.equal(malformado.status, 422);
  assert.equal((await malformado.json()).codigo, 'id_invalido');
});

// --- PUT /api/movimentos/:id/comprovante -------------------------------------

test('HC3: PUT registra o estado e devolve o que aconteceu', async (t) => {
  const ctx = await subir(t);
  const movimento = criarMovimento(ctx.db, criarAssociado(ctx.db));

  const response = await putJson(ctx.baseUrl, `/api/movimentos/${movimento.id}/comprovante`, {
    estado: 'PENDENTE',
    observacao: 'Comprovante solicitado ao associado.',
  });
  const { comprovante } = await response.json();

  assert.equal(response.status, 200);
  assert.equal(comprovante.alteracao, 'registrado');
  assert.equal(comprovante.estado, 'pendente');
  assert.equal(comprovante.pendenteDeEvidencia, true);
  assert.equal(comprovante.observacao, 'Comprovante solicitado ao associado.');
  assert.equal(
    ctx.db.prepare('SELECT COUNT(*) AS t FROM comprovante').get().t,
    1,
    'uma linha, so uma'
  );
});

test('HC4: PUT altera pendente -> presente e o reenvio identico nao muda nada', async (t) => {
  const ctx = await subir(t);
  const movimento = criarMovimento(ctx.db, criarAssociado(ctx.db));
  const rota = `/api/movimentos/${movimento.id}/comprovante`;

  await putJson(ctx.baseUrl, rota, { estado: 'pendente' });
  const alterado = await (
    await putJson(ctx.baseUrl, rota, { estado: 'presente', observacao: 'Documento conferido.' })
  ).json();
  const auditoriaApos = ctx.db.prepare('SELECT COUNT(*) AS t FROM audit_log').get().t;

  const repetido = await putJson(ctx.baseUrl, rota, {
    estado: 'presente',
    observacao: 'Documento conferido.',
  });
  const corpoRepetido = await repetido.json();

  assert.equal(alterado.comprovante.alteracao, 'alterado');
  assert.equal(alterado.comprovante.estado, 'presente');
  assert.equal(repetido.status, 200);
  assert.equal(corpoRepetido.comprovante.alteracao, 'sem_mudanca');
  assert.equal(corpoRepetido.comprovante.estado, 'presente');
  assert.equal(
    ctx.db.prepare('SELECT COUNT(*) AS t FROM audit_log').get().t,
    auditoriaApos,
    'reenvio identico nao gera auditoria'
  );
});

test('HC5: PUT com estado fora do vocabulario responde 422 e nao grava', async (t) => {
  const ctx = await subir(t);
  const movimento = criarMovimento(ctx.db, criarAssociado(ctx.db));

  const response = await putJson(ctx.baseUrl, `/api/movimentos/${movimento.id}/comprovante`, {
    estado: 'OK',
  });
  const corpo = await response.json();

  assert.equal(response.status, 422);
  assert.equal(corpo.status, 'erro');
  assert.equal(corpo.codigo, 'estado_comprovante_invalido');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM comprovante').get().t, 0);
});

test('HC6: PUT em movimento inexistente responde 404 sem criar nada', async (t) => {
  const ctx = await subir(t);

  const response = await putJson(ctx.baseUrl, '/api/movimentos/9999/comprovante', {
    estado: 'pendente',
  });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).codigo, 'movimento_inexistente');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM comprovante').get().t, 0);
});

test('HC7: PUT nao altera valor, associado nem alocacoes do movimento', async (t) => {
  const ctx = await subir(t);
  const movimento = criarMovimento(ctx.db, criarAssociado(ctx.db));
  const antes = ctx.db.prepare('SELECT * FROM movimento_financeiro WHERE id = ?').get(movimento.id);

  await putJson(ctx.baseUrl, `/api/movimentos/${movimento.id}/comprovante`, { estado: 'ausente' });

  assert.deepEqual(
    ctx.db.prepare('SELECT * FROM movimento_financeiro WHERE id = ?').get(movimento.id),
    antes
  );
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM alocacao').get().t, 0);
});

// --- GET /api/pendencias/comprovantes ----------------------------------------

test('HC8: a fila lista PENDENTE e AUSENTE e exclui PRESENTE e NAO_APLICAVEL', async (t) => {
  const ctx = await subir(t);
  const associadoId = criarAssociado(ctx.db);
  const ids = {};
  for (const estado of ['pendente', 'ausente', 'presente', 'nao_aplicavel']) {
    const movimento = criarMovimento(ctx.db, associadoId);
    definirComprovanteDoMovimento(ctx.db, { movimentoId: movimento.id, estado });
    ids[estado] = movimento.id;
  }

  const response = await fetch(`${ctx.baseUrl}/api/pendencias/comprovantes`);
  const corpo = await response.json();
  const listados = corpo.itens.map((item) => item.movimentoId);

  assert.equal(response.status, 200);
  assert.equal(corpo.status, 'ok');
  assert.equal(corpo.paginacao.total, 2);
  assert.deepEqual(listados.sort(), [ids.pendente, ids.ausente].sort());
  assert.equal(listados.includes(ids.presente), false);
  assert.equal(listados.includes(ids.nao_aplicavel), false);
});

test('HC9: a fila aceita filtro por estado e recusa estado que nao serve', async (t) => {
  const ctx = await subir(t);
  const associadoId = criarAssociado(ctx.db);
  const pendente = criarMovimento(ctx.db, associadoId);
  const ausente = criarMovimento(ctx.db, associadoId);
  definirComprovanteDoMovimento(ctx.db, { movimentoId: pendente.id, estado: 'pendente' });
  definirComprovanteDoMovimento(ctx.db, { movimentoId: ausente.id, estado: 'ausente' });

  const soAusente = await (
    await fetch(`${ctx.baseUrl}/api/pendencias/comprovantes?estado=ausente`)
  ).json();
  assert.deepEqual(
    soAusente.itens.map((item) => item.movimentoId),
    [ausente.id]
  );

  const recusado = await fetch(`${ctx.baseUrl}/api/pendencias/comprovantes?estado=presente`);
  assert.equal(recusado.status, 422);
  assert.equal((await recusado.json()).codigo, 'estado_comprovante_invalido');

  const paginacao = await fetch(`${ctx.baseUrl}/api/pendencias/comprovantes?limite=0`);
  assert.equal(paginacao.status, 422);
  assert.equal((await paginacao.json()).codigo, 'paginacao_invalida');
});

// --- tela de detalhe do associado --------------------------------------------

test('HC10: o extrato mostra o estado do comprovante em palavras', async (t) => {
  const ctx = await subir(t);
  const associadoId = criarAssociado(ctx.db, 'Com Evidencia');
  const rotulos = {
    presente: 'Presente',
    ausente: 'Ausente',
    pendente: 'Pendente',
    nao_aplicavel: 'Não aplicável',
  };

  for (const estado of Object.keys(rotulos)) {
    const movimento = criarMovimento(ctx.db, associadoId);
    definirComprovanteDoMovimento(ctx.db, { movimentoId: movimento.id, estado });
  }

  const { response, html } = await obterHtml(ctx.baseUrl, `/associados/${associadoId}`);

  assert.equal(response.status, 200);
  for (const rotulo of Object.values(rotulos)) {
    assert.ok(
      html.includes(`<dt>Comprovante</dt><dd>${rotulo}</dd>`),
      `rotulo textual ausente: ${rotulo}`
    );
  }
});

test('HC11: movimento sem registro diz "sem registro", nunca "Ausente"', async (t) => {
  const ctx = await subir(t);
  const associadoId = criarAssociado(ctx.db, 'Sem Evidencia');
  criarMovimento(ctx.db, associadoId);

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${associadoId}`);

  assert.ok(html.includes('<dt>Comprovante</dt><dd>Sem registro de comprovante</dd>'));
  assert.equal(
    html.includes('<dd>Ausente</dd>'),
    false,
    'ausencia de registro nao pode ser exibida como ausencia declarada'
  );
});

test('HC12: a observacao do comprovante aparece escapada e separada do estado', async (t) => {
  const ctx = await subir(t);
  const associadoId = criarAssociado(ctx.db, 'Com Observacao');
  const movimento = criarMovimento(ctx.db, associadoId);
  definirComprovanteDoMovimento(ctx.db, {
    movimentoId: movimento.id,
    estado: 'pendente',
    observacao: 'operador anotou: <b>ligar</b> para o associado',
  });

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${associadoId}`);

  assert.ok(html.includes('<dt>Comprovante</dt><dd>Pendente</dd>'));
  assert.ok(html.includes('<dt>Observação do comprovante</dt>'));
  assert.ok(html.includes('operador anotou: &lt;b&gt;ligar&lt;/b&gt; para o associado'));
  assert.equal(html.includes('<b>ligar</b>'), false);
});
