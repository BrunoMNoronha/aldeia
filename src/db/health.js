'use strict';

/**
 * Sonda de saude do SQLite.
 *
 * Existe como modulo proprio por causa da migracao para Next.js (NX-0): durante
 * a transicao o mesmo `/health` e servido por DOIS transportes — o Express de
 * `src/web/app.js` e o Route Handler de `app/health/route.js`. Manter a sonda em
 * um unico lugar e o que garante que o contrato publicado nao divirja entre eles.
 *
 * O que esta funcao NAO faz, de proposito:
 *
 * - nao aplica migration (health check e leitura, nao manutencao de schema);
 * - nao abre conexao propria: recebe um resolvedor e usa a conexao do processo;
 * - nao decide status HTTP — isso e transporte, e fica em quem chama.
 */

/**
 * @param {() => import('better-sqlite3').Database} resolveDb resolvedor da
 *        conexao. E uma FUNCAO, e nao a conexao pronta, porque abrir o banco
 *        tambem pode falhar: essa falha precisa ser capturada aqui e virar
 *        `saudavel: false`, nunca escapar como erro interno.
 * @returns {{ saudavel: boolean, corpo: { status: string, database: string, migrations?: number } }}
 */
function verificarSaude(resolveDb) {
  try {
    const db = resolveDb();
    db.prepare('SELECT 1').get();

    // Banco acessivel mas ainda nao migrado responde `migrations: 0` — e um
    // estado real do sistema, nao um erro.
    const row = db
      .prepare(
        "SELECT COUNT(*) AS total FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'"
      )
      .get();
    const migrations =
      row.total === 0 ? 0 : db.prepare('SELECT COUNT(*) AS total FROM schema_migration').get().total;

    return { saudavel: true, corpo: { status: 'ok', database: 'ok', migrations } };
  } catch {
    return { saudavel: false, corpo: { status: 'erro', database: 'erro' } };
  }
}

module.exports = { verificarSaude };
