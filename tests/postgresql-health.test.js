'use strict';

// Sonda de saude do PostgreSQL (ADR-003 / PG-1).
//
// A sonda PG e paralela: o `/health` publico continua respondendo pelo SQLite
// nesta fase (ver `tests/health-check.test.js`). O que se garante aqui e que a
// sonda PostgreSQL nunca trate falha como sucesso — o erro mais caro que um
// health check pode cometer.

const test = require('node:test');
const assert = require('node:assert/strict');

const { verificarSaudePostgresql, classificarErro } = require('../src/db/postgresql/health');
const { createPool } = require('../src/db/postgresql/connection');
const { runMigrations } = require('../src/db/postgresql/migrator');
const { motivoSkip, schemaIsolado } = require('./helpers/postgres');

const URL_INALCANCAVEL = 'postgres://ninguem:nenhuma@127.0.0.1:1/inexistente';

// ---------------------------------------------------------------------------
// Sem dependencia de PostgreSQL
// ---------------------------------------------------------------------------

test('health: banco inalcancavel responde erro, e nao excecao', async () => {
  const pool = createPool({ connectionString: URL_INALCANCAVEL, connectionTimeoutMillis: 2000 });

  const { saudavel, corpo } = await verificarSaudePostgresql(() => pool);

  assert.equal(saudavel, false);
  assert.equal(corpo.status, 'erro');
  assert.equal(corpo.database, 'erro');
  assert.equal(corpo.motivo, 'conexao');
  assert.equal(corpo.migrations, undefined, 'sem banco nao ha contagem de migrations a informar');

  await pool.end();
});

test('health: falha ao CRIAR o pool tambem vira erro, nao excecao', async () => {
  const { saudavel, corpo } = await verificarSaudePostgresql(() => {
    throw new Error('DATABASE_URL ausente');
  });

  assert.equal(saudavel, false);
  assert.equal(corpo.status, 'erro');
  assert.equal(corpo.database, 'erro');
});

test('health: erro de conexao e erro de consulta sao classificados diferente', () => {
  assert.equal(classificarErro(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), 'conexao');
  assert.equal(classificarErro(Object.assign(new Error('x'), { code: '08006' })), 'conexao');
  assert.equal(classificarErro(new Error('connection timeout expired')), 'conexao');

  // 42P01 = undefined_table: o servidor respondeu, quem esta errado e a consulta.
  assert.equal(classificarErro(Object.assign(new Error('x'), { code: '42P01' })), 'consulta');
  assert.equal(classificarErro(null), 'consulta');
});

// ---------------------------------------------------------------------------
// Exigem PostgreSQL real (TEST_DATABASE_URL)
// ---------------------------------------------------------------------------

test('health: banco acessivel e nao migrado responde migrations 0', { skip: motivoSkip() }, async (t) => {
  const { pool } = await schemaIsolado(t);

  const { saudavel, corpo } = await verificarSaudePostgresql(() => pool);

  assert.equal(saudavel, true);
  assert.equal(corpo.database, 'ok');
  assert.equal(corpo.migrations, 0, 'banco vazio e um estado real, nao um erro');
});

test('health: banco migrado responde ok com a contagem de migrations', { skip: motivoSkip() }, async (t) => {
  const { pool } = await schemaIsolado(t);
  await runMigrations(pool);

  const { saudavel, corpo } = await verificarSaudePostgresql(() => pool);

  assert.equal(saudavel, true);
  assert.equal(corpo.status, 'ok');
  assert.equal(corpo.database, 'ok');
  assert.ok(corpo.migrations > 0, '/health deve enxergar as migrations aplicadas');
});

test('health: a sonda nao aplica migration por conta propria', { skip: motivoSkip() }, async (t) => {
  const { pool, schema } = await schemaIsolado(t);

  await verificarSaudePostgresql(() => pool);

  const { rows } = await pool.query(
    'SELECT COUNT(*) AS total FROM information_schema.tables WHERE table_schema = $1',
    [schema]
  );
  assert.equal(Number(rows[0].total), 0, 'health check nao pode criar schema');
});
