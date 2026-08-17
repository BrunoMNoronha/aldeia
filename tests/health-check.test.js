'use strict';

// Contrato do GET /health (Fase NX-0).
//
// A sonda `verificarSaude` e a UNICA fonte da resposta de /health nos dois
// transportes que existem durante a migracao: o Express (`src/web/app.js`) e o
// Route Handler do Next.js (`app/health/route.js`). Testar a sonda aqui e o que
// garante que os dois publiquem exatamente o mesmo corpo e o mesmo status.
//
// O Route Handler em si nao e importado por este arquivo: `app/health/route.js`
// e um modulo ESM compilado pelo Next, e o pacote e "type": "commonjs" por causa
// de todo o resto de `src/`. O handler foi mantido com duas linhas de logica
// justamente para que nada de contratual fique fora deste teste.

const test = require('node:test');
const assert = require('node:assert/strict');

const { verificarSaude } = require('../src/db/health');
const { createMigratedDb } = require('./helpers/temp-db');

test('health: banco migrado responde ok com a contagem de migrations', (t) => {
  const ctx = createMigratedDb(t);

  const { saudavel, corpo } = verificarSaude(() => ctx.db);

  assert.equal(saudavel, true);
  assert.equal(corpo.status, 'ok');
  assert.equal(corpo.database, 'ok');
  assert.ok(corpo.migrations > 0, '/health deve enxergar as migrations aplicadas');
});

test('health: banco fechado responde erro sem lancar excecao', (t) => {
  const ctx = createMigratedDb(t);
  ctx.db.close();

  const { saudavel, corpo } = verificarSaude(() => ctx.db);

  assert.equal(saudavel, false);
  assert.deepEqual(corpo, { status: 'erro', database: 'erro' });
});

test('health: falha ao ABRIR o banco tambem vira erro, nao excecao', () => {
  const { saudavel, corpo } = verificarSaude(() => {
    throw new Error('nao foi possivel abrir o banco');
  });

  assert.equal(saudavel, false);
  assert.deepEqual(corpo, { status: 'erro', database: 'erro' });
});

test('health: banco acessivel e nao migrado responde migrations 0', (t) => {
  const ctx = createMigratedDb(t);
  // Banco novo, no mesmo workspace temporario, sem nenhuma migration aplicada.
  const db = ctx.open(`${ctx.dbPath}.vazio`);

  const { saudavel, corpo } = verificarSaude(() => db);

  assert.equal(saudavel, true);
  assert.equal(corpo.database, 'ok');
  assert.equal(corpo.migrations, 0);
});

test('health: a sonda nao aplica migration por conta propria', (t) => {
  const ctx = createMigratedDb(t);
  const db = ctx.open(`${ctx.dbPath}.intacto`);

  verificarSaude(() => db);

  const tabelas = db
    .prepare("SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table'")
    .get();
  assert.equal(tabelas.total, 0, 'health check nao pode criar schema');
});
