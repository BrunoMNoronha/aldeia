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
const { PG_TYPE_DATE, parseDataCivilSegura, ID_MAXIMO_INT4 } = require('./tipos');

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

// ---------------------------------------------------------------------------
// DATA CIVIL — `DATE` nunca vira instante (M-10)
// ---------------------------------------------------------------------------
//
// O parser vive em `./tipos` junto com o teto do `int4`: sao os dois fatos de
// TIPO que a trilha PostgreSQL inteira precisa respeitar. Aqui ele apenas e
// INSTALADO, e a instalacao acontece no carregamento deste modulo — antes de
// qualquer pool existir, portanto antes de qualquer linha ser lida.
//
// Resumo do porque (detalhe completo em `./tipos`): o parser padrao do
// `node-postgres` converte `DATE` em `Date` na meia-noite LOCAL, o que devolve o
// DIA ANTERIOR a leste de Greenwich e pode mover um pagamento de competencia.
// O parser seguro devolve o texto 'YYYY-MM-DD' e RECUSA ruidosamente os valores
// de DATE que nao sao data civil ('infinity', ' BC', ano de cinco digitos).
pg.types.setTypeParser(PG_TYPE_DATE, parseDataCivilSegura);

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

/**
 * Executa `fn` dentro de uma transacao de LEITURA com snapshot consistente.
 *
 * Contrato:
 *   connect -> BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY
 *           -> fn(client) -> COMMIT -> release
 *   em erro: ROLLBACK -> release -> rethrow do erro ORIGINAL
 *
 * O "em erro" vale para TUDO que acontece depois de um `BEGIN` bem sucedido —
 * inclusive para o proprio `COMMIT` (PG-2C1R2). Se o `COMMIT` falha, o helper NAO
 * pode assumir que o client esta em estado transacional reutilizavel: a falha e
 * observada deste lado, e o que o servidor efetivou nao e inequivoco daqui. Por
 * isso ele tenta o cleanup antes de devolver o client ao pool, num UNICO caminho
 * de erro guardado por `transacaoAberta` — era o aninhamento anterior que deixava
 * o `COMMIT` fora do bloco responsavel pelo ROLLBACK.
 *
 * Se o proprio ROLLBACK falhar, duas informacoes DISTINTAS sao preservadas: o
 * CHAMADOR recebe o erro original (de `fn` ou do `COMMIT`), e o POOL recebe o
 * client marcado para descarte via `release(erro)`. Cleanup que falhou nao
 * autoriza reutilizar a conexao — e tambem nao justifica trocar a causa de que o
 * diagnostico depende.
 *
 * POR QUE ISSO EXISTE. Uma resposta do sistema costuma sair de MAIS DE UMA
 * consulta — o movimento, suas alocacoes e o resumo agregado, ou o COUNT e a
 * pagina de uma fila. Em autocommit cada statement enxerga o banco no instante
 * em que roda, entao um commit alheio entre duas delas produz uma resposta
 * internamente incoerente: a lista com uma alocacao e o resumo dizendo que ha
 * duas. Nao e dado errado no banco — e uma fotografia costurada de dois
 * momentos, que quem le nao tem como perceber.
 *
 * `REPEATABLE READ` fixa UM snapshot no primeiro comando da transacao; todas as
 * consultas seguintes leem esse mesmo estado, mesmo que outras transacoes
 * commitem no meio. A resposta passa a ser sempre um retrato de um instante.
 *
 * `READ ONLY` e a outra metade: o proprio PostgreSQL recusa INSERT/UPDATE/DELETE
 * aqui (SQLSTATE 25006). Leitura que grava deixa de ser possivel por
 * construcao, e nao por disciplina de quem escreve o codigo.
 *
 * O que este helper NAO faz, de proposito:
 *   * NAO adquire lock de linha (`FOR UPDATE`, `FOR NO KEY UPDATE`) nem lock de
 *     tabela. Leitura nao serializa quem escreve: writers concorrentes seguem
 *     em frente e apenas nao aparecem neste snapshot;
 *   * NAO substitui `withTransaction`, que continua sendo a transacao de
 *     ESCRITA financeira (T-07) — misturar as duas tornaria ambiguo o que uma
 *     transacao significa em cada ponto do codigo;
 *   * NAO aninha. Chamar um snapshot dentro de outro emitiria um `BEGIN` dentro
 *     de transacao aberta, que o PostgreSQL ignora com aviso — e o segundo bloco
 *     terminaria commitando o primeiro. Nesta fase nenhum caso de uso precisa
 *     disso; quem compoe leituras compoe DENTRO do mesmo bloco.
 *
 * `fn` recebe o client da transacao e DEVE usar exatamente esse client: voltar a
 * chamar `pool.query()` la dentro pega outra conexao, com outro snapshot, e
 * traz de volta exatamente a incoerencia que este helper elimina.
 *
 * @template T
 * @param {import('pg').Pool} pool
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withReadSnapshot(pool, fn) {
  const client = await pool.connect();

  // Estado explicito em vez de aninhamento: enquanto isto for `true`, existe uma
  // transacao que ALGUEM precisa encerrar. O `BEGIN` que falha nunca o liga, e o
  // `COMMIT` bem sucedido o desliga — as duas unicas situacoes em que um ROLLBACK
  // seria indevido.
  let transacaoAberta = false;
  // Motivo para NAO devolver este client ao pool. Continua `null` enquanto o
  // encerramento for confiavel.
  let erroDeCleanup = null;

  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transacaoAberta = true;

    const resultado = await fn(client);

    await client.query('COMMIT');
    transacaoAberta = false;

    return resultado;
  } catch (error) {
    if (transacaoAberta) {
      try {
        await client.query('ROLLBACK');
        transacaoAberta = false;
      } catch (erroRollback) {
        // O erro do cleanup NAO substitui a causa: quem chamou continua
        // recebendo o erro de `fn` ou do `COMMIT`. Ele decide outra coisa — que
        // este client nao e mais confiavel. Normalizado para `Error` porque e
        // a verdade do `release` que importa: um valor falsy passaria batido
        // pela checagem do pool e o client voltaria a circular.
        erroDeCleanup =
          erroRollback instanceof Error ? erroRollback : new Error(String(erroRollback));
      }
    }
    throw error;
  } finally {
    // `release` num `finally` unico: um por chamada, em todos os caminhos.
    //
    // Com argumento, o `pg` REMOVE o client do pool em vez de devolve-lo
    // (`pg-pool`: "include an error to remove it from the pool"; o `_release`
    // cai em `_remove` assim que `err` e truthy). E o mecanismo suportado para
    // descartar uma conexao que AINDA parece saudavel — diferente do client cuja
    // conexao morreu, que o proprio driver ja descarta por `!_queryable`.
    client.release(erroDeCleanup ?? undefined);
  }
}

module.exports = {
  createPool,
  getPool,
  closePool,
  testarConexao,
  withClient,
  withTransaction,
  withReadSnapshot,
  parseInt8Seguro,
  POOL_DEFAULTS,
  PG_TYPE_INT8,
  PG_TYPE_DATE,
  parseDataCivilSegura,
  ID_MAXIMO_INT4,
};
