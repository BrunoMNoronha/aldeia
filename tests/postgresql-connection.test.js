'use strict';

// Camada de conexao PostgreSQL (ADR-003 / PG-1).
//
// Parte destes testes NAO precisa de PostgreSQL: configuracao ausente, erro de
// conexao e o parser de int8 sao verificaveis sem servidor. Os que exigem banco
// real ficam marcados com `skip` visivel quando TEST_DATABASE_URL nao existe.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPool,
  closePool,
  testarConexao,
  withClient,
  parseInt8Seguro,
  POOL_DEFAULTS,
} = require('../src/db/postgresql/connection');
const { motivoSkip, schemaIsolado } = require('./helpers/postgres');

// Porta 1 e reservada e nunca tem PostgreSQL escutando: e um destino de conexao
// que falha rapido e de forma deterministica, sem depender do ambiente.
const URL_INALCANCAVEL = 'postgres://ninguem:nenhuma@127.0.0.1:1/inexistente';

// ---------------------------------------------------------------------------
// Sem dependencia de PostgreSQL
// ---------------------------------------------------------------------------

test('createPool sem configuracao alguma falha com mensagem acionavel', () => {
  assert.throws(
    () => createPool({ connectionString: '   ' }),
    /DATABASE_URL|connectionString/,
    'a falta de configuracao precisa dizer o que configurar'
  );
});

test('createPool aplica os defaults do pool e aceita sobrescrita', async () => {
  const pool = createPool({ connectionString: URL_INALCANCAVEL });
  assert.equal(pool.options.max, POOL_DEFAULTS.max);
  assert.equal(pool.options.connectionTimeoutMillis, POOL_DEFAULTS.connectionTimeoutMillis);
  await pool.end();

  const menor = createPool({ connectionString: URL_INALCANCAVEL, max: 2 });
  assert.equal(menor.options.max, 2);
  await menor.end();
});

test('erro de conexao e propagado de forma controlada, sem derrubar o processo', async () => {
  const pool = createPool({ connectionString: URL_INALCANCAVEL, connectionTimeoutMillis: 2000 });

  await assert.rejects(() => testarConexao(pool), (error) => {
    assert.ok(error instanceof Error, 'a falha precisa chegar como Error, nao como valor solto');
    return true;
  });

  await pool.end();
});

test('withClient nao segura client quando a conexao nem chega a abrir', async () => {
  const pool = createPool({ connectionString: URL_INALCANCAVEL, max: 1 });

  // Com max: 1, um client vazado deixaria a segunda tentativa pendurada em vez
  // de falhar. Duas rodadas provam que nada ficou retido.
  for (let i = 0; i < 2; i += 1) {
    await assert.rejects(() => withClient(pool, async () => 'nunca chega aqui'));
  }

  await pool.end();
});

test('closePool e idempotente e nao explode sem pool aberto', async () => {
  await closePool();
  await closePool();
});

test('int8 vira Number apenas dentro da faixa segura (T-06)', () => {
  assert.equal(parseInt8Seguro(null), null);
  assert.equal(parseInt8Seguro('0'), 0);
  assert.equal(parseInt8Seguro('2500'), 2500);
  assert.equal(parseInt8Seguro('-2500'), -2500);
  assert.equal(parseInt8Seguro(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);

  // Acima da faixa segura, converter silenciosamente corromperia centavos.
  assert.throws(() => parseInt8Seguro('9007199254740993'), RangeError);
  assert.throws(() => parseInt8Seguro('9223372036854775807'), RangeError);
});

// ---------------------------------------------------------------------------
// Exigem PostgreSQL real (TEST_DATABASE_URL)
// ---------------------------------------------------------------------------

test('pool conecta e responde SELECT 1', { skip: motivoSkip() }, async (t) => {
  const { pool } = await schemaIsolado(t);

  assert.equal(await testarConexao(pool), true);
});

test('withClient devolve o client ao pool mesmo quando fn lanca', { skip: motivoSkip() }, async (t) => {
  const { pool } = await schemaIsolado(t);

  await assert.rejects(
    () =>
      withClient(pool, async () => {
        throw new Error('falha dentro do bloco');
      }),
    /falha dentro do bloco/
  );

  assert.equal(pool.idleCount, 1, 'o client precisa voltar ocioso ao pool');
  assert.equal(pool.waitingCount, 0);

  // E o pool continua utilizavel depois do erro.
  assert.equal(await testarConexao(pool), true);
});

test('pool reaproveita conexoes em vez de abrir uma por consulta', { skip: motivoSkip() }, async (t) => {
  const { pool } = await schemaIsolado(t);

  for (let i = 0; i < 5; i += 1) {
    await pool.query('SELECT 1');
  }

  assert.equal(pool.totalCount, 1, 'consultas sequenciais devem reusar a mesma conexao');
});

test('pool.end() encerra as conexoes', { skip: motivoSkip() }, async (t) => {
  const { pool } = await schemaIsolado(t);
  await pool.query('SELECT 1');

  await pool.end();

  assert.equal(pool.ended, true);
  await assert.rejects(() => pool.query('SELECT 1'));

  // `schemaIsolado` chama pool.end() de novo na limpeza; encerrar duas vezes nao
  // pode quebrar o teardown.
});
