'use strict';

/**
 * Conexao PostgreSQL (ADR-003).
 *
 * Esta camada e PARALELA a `src/db/connection.js` (SQLite). Na fase PG-1 ela
 * NAO substitui o runtime: nenhum service, rota ou script a utiliza ainda. A
 * separacao de diretorio (`src/db/postgresql/`) e o que permite converter os
 * consumidores um a um na PG-2 sem um diff gigante.
 *
 * Diferenca estrutural em relacao ao SQLite, e que nao pode ser escondida:
 * `better-sqlite3` e SINCRONO e `pg` e ASSINCRONO. Nao existe wrapper honesto
 * que faca o segundo parecer o primeiro, entao toda a API aqui e async desde o
 * inicio (ADR-003, "mudanca de API sincrona para assincrona").
 */

const pg = require('pg');

const { resolveDatabaseUrl } = require('../../config');

// ---------------------------------------------------------------------------
// T-06 — dinheiro nunca depende de ponto flutuante binario
// ---------------------------------------------------------------------------
//
// As colunas monetarias sao BIGINT no PostgreSQL (ver
// `migrations/postgresql/001_initial_schema.sql`), porque `INTEGER` do SQLite ja
// e 64 bits e estreitar para `int4` reduziria o dominio existente.
//
// `node-postgres` entrega `int8` como STRING por padrao, exatamente para nao
// corromper valores acima de 2^53 convertendo-os para `Number`. Trocar isso por
// um `Number(v)` global seria justamente a coercao insegura que T-06 proibe.
//
// O parser abaixo converte para `Number` SOMENTE dentro da faixa segura de
// inteiros do JavaScript e LANCA fora dela — falha ruidosa em vez de centavo
// silenciosamente errado. Em centavos, `Number.MAX_SAFE_INTEGER` equivale a
// aproximadamente R$ 90 trilhoes: nenhum valor legitimo da ACASA chega perto,
// entao um estouro aqui significa dado corrompido e deve mesmo explodir.
const PG_TYPE_INT8 = 20;

function parseInt8Seguro(value) {
  if (value === null) return null;

  const numero = Number(value);
  if (!Number.isSafeInteger(numero)) {
    throw new RangeError(
      `Valor int8 fora da faixa segura de inteiros do JavaScript: ${value}. ` +
        'Converter para Number aqui corromperia o valor (T-06).'
    );
  }
  return numero;
}

pg.types.setTypeParser(PG_TYPE_INT8, parseInt8Seguro);

/** Configuracao padrao do pool. Nenhum valor exige servico externo (T-03). */
const POOL_DEFAULTS = Object.freeze({
  max: 10,
  idleTimeoutMillis: 30_000,
  // Falha de conexao deve virar erro rapido e tratavel, nao pendurar a request.
  connectionTimeoutMillis: 5_000,
});

/**
 * Cria um pool NOVO. Use para testes e para conexoes de vida curta.
 * A aplicacao deve usar `getPool()`, que compartilha um unico pool.
 *
 * @param {{ connectionString?: string } & Record<string, unknown>} [options]
 * @returns {import('pg').Pool}
 */
function createPool(options = {}) {
  const { connectionString = resolveDatabaseUrl(), ...resto } = options;

  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new Error(
      'PostgreSQL nao configurado: defina DATABASE_URL ou passe connectionString explicitamente.'
    );
  }

  const pool = new pg.Pool({ ...POOL_DEFAULTS, ...resto, connectionString });

  // Um erro em client OCIOSO (queda de rede, restart do servidor) e emitido no
  // pool, nao na query. Sem listener, o Node derruba o processo inteiro.
  pool.on('error', () => {
    /* client ocioso morreu; o pool descarta e recria sob demanda */
  });

  return pool;
}

let poolCompartilhado = null;

/**
 * Pool compartilhado do processo.
 * Criar um pool por request derrotaria o proposito do pool: cada um abriria
 * conexoes TCP proprias e o servidor acabaria recusando conexoes.
 *
 * @returns {import('pg').Pool}
 */
function getPool() {
  if (poolCompartilhado === null || poolCompartilhado.ended === true) {
    poolCompartilhado = createPool();
  }
  return poolCompartilhado;
}

/** Fecha o pool compartilhado (shutdown da aplicacao / fim de teste). */
async function closePool() {
  if (poolCompartilhado !== null && poolCompartilhado.ended !== true) {
    await poolCompartilhado.end();
  }
  poolCompartilhado = null;
}

/**
 * Verifica se a conexao responde. Nao engole erro: quem chama decide o que
 * fazer com a falha (o health check e quem a converte em resposta).
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<true>}
 */
async function testarConexao(pool) {
  await pool.query('SELECT 1');
  return true;
}

/**
 * Executa `fn` com um client DEDICADO do pool, devolvendo-o sempre.
 *
 * O `finally` nao e detalhe de estilo: client nao liberado nunca volta ao pool,
 * e alguns vazamentos desses esgotam o pool e travam a aplicacao inteira.
 *
 * @template T
 * @param {import('pg').Pool} pool
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withClient(pool, fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Executa `fn` dentro de uma transacao PostgreSQL (T-07).
 *
 * Contrato:
 *   connect -> BEGIN -> fn(client) -> COMMIT -> release
 *   em erro: ROLLBACK -> release -> rethrow
 *
 * `fn` recebe o client da transacao e DEVE usar exatamente esse client. Uma
 * operacao que volte a chamar `pool.query()` no meio do bloco pega OUTRA conexao,
 * fica fora da transacao e nao e desfeita pelo ROLLBACK — que e precisamente a
 * atomicidade que T-07 exige para operacoes financeiras multi-registro.
 *
 * Nao ha nesting (SAVEPOINT) nesta fase: nenhum consumidor precisa disso ainda,
 * e transacao aninhada silenciosa e uma fonte classica de commit parcial.
 *
 * @template T
 * @param {import('pg').Pool} pool
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTransaction(pool, fn) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    let resultado;
    try {
      resultado = await fn(client);
    } catch (error) {
      // ROLLBACK tambem pode falhar (conexao ja morta). Se falhar, o erro
      // ORIGINAL e o que interessa para o diagnostico, entao ele prevalece.
      try {
        await client.query('ROLLBACK');
      } catch {
        /* conexao perdida: o servidor ja desfez a transacao por conta propria */
      }
      throw error;
    }
    await client.query('COMMIT');
    return resultado;
  } finally {
    client.release();
  }
}

module.exports = {
  createPool,
  getPool,
  closePool,
  testarConexao,
  withClient,
  withTransaction,
  parseInt8Seguro,
  POOL_DEFAULTS,
};
