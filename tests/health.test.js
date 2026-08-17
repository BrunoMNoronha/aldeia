'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/web/app');
const { createMigratedDb } = require('./helpers/temp-db');

/** Sobe a app em porta efemera e devolve a base URL. */
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

test('aplicacao inicia e /health responde com sucesso', async (t) => {
  const ctx = createMigratedDb(t);

  const { server, baseUrl } = await listen(createApp({ db: ctx.db }));
  t.after(() => close(server));

  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.database, 'ok');
  assert.ok(body.migrations > 0, '/health deve enxergar as migrations aplicadas');
});

test('/health reporta erro quando o banco esta indisponivel', async (t) => {
  const ctx = createMigratedDb(t);
  ctx.db.close();

  const { server, baseUrl } = await listen(createApp({ db: ctx.db }));
  t.after(() => close(server));

  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, 'erro');
});

test('rota inexistente responde 404 em JSON', async (t) => {
  const ctx = createMigratedDb(t);

  const { server, baseUrl } = await listen(createApp({ db: ctx.db }));
  t.after(() => close(server));

  const response = await fetch(`${baseUrl}/rota-que-nao-existe`);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).status, 'erro');
});
