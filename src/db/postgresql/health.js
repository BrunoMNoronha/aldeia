'use strict';

/**
 * Sonda de saude do PostgreSQL (ADR-003).
 *
 * Espelha o contrato de `src/db/health.js` (SQLite): devolve `{ saudavel, corpo }`
 * e NAO decide status HTTP — isso e transporte.
 *
 * O que esta funcao NAO faz, de proposito:
 *
 * - nao aplica migration (health check e leitura, nao manutencao de schema);
 * - nao cria pool proprio: recebe um resolvedor, porque criar o pool tambem pode
 *   falhar (DATABASE_URL ausente ou invalida) e essa falha precisa virar
 *   `saudavel: false`, nunca escapar como erro interno;
 * - nao altera o `/health` publico. Na PG-1 o endpoint continua respondendo pelo
 *   SQLite; trocar a fonte do health check e trocar o runtime, e isso e PG-2+.
 */

/**
 * Classifica a falha para que "banco fora do ar" nao se confunda com "consulta
 * quebrada". A distincao importa em producao: a primeira e infraestrutura, a
 * segunda e schema/aplicacao, e elas tem donos diferentes.
 *
 * Os codigos de erro vem do driver (`err.code`): os textuais sao do `pg`/Node,
 * os de 5 caracteres sao SQLSTATE do proprio PostgreSQL.
 */
const CODIGOS_DE_CONEXAO = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '08P01', // protocol_violation
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);

function classificarErro(error) {
  if (error === null || typeof error !== 'object') return 'consulta';

  const codigo = error.code;
  if (typeof codigo === 'string' && CODIGOS_DE_CONEXAO.has(codigo)) return 'conexao';

  // `connectionTimeoutMillis` do pool estoura sem `code`, apenas com mensagem.
  const mensagem = typeof error.message === 'string' ? error.message : '';
  if (/timeout/i.test(mensagem) || /connect/i.test(mensagem)) return 'conexao';

  return 'consulta';
}

/**
 * @param {() => import('pg').Pool | Promise<import('pg').Pool>} resolvePool
 * @returns {Promise<{
 *   saudavel: boolean,
 *   corpo: { status: string, database: string, migrations?: number, motivo?: string }
 * }>}
 */
async function verificarSaudePostgresql(resolvePool) {
  try {
    const pool = await resolvePool();

    // Sonda barata e sem dependencia de schema: se isto responde, o servidor
    // esta de pe e as credenciais valem.
    await pool.query('SELECT 1');

    // Banco acessivel mas ainda nao migrado responde `migrations: 0` — e um
    // estado real do sistema, nao um erro. `to_regclass` devolve NULL quando a
    // tabela nao existe, entao nao ha excecao a tratar aqui.
    const controle = await pool.query("SELECT to_regclass('schema_migration') AS tabela");

    const migrations =
      controle.rows[0].tabela === null
        ? 0
        : Number((await pool.query('SELECT COUNT(*) AS total FROM schema_migration')).rows[0].total);

    return { saudavel: true, corpo: { status: 'ok', database: 'ok', migrations } };
  } catch (error) {
    return {
      saudavel: false,
      corpo: { status: 'erro', database: 'erro', motivo: classificarErro(error) },
    };
  }
}

module.exports = { verificarSaudePostgresql, classificarErro };
