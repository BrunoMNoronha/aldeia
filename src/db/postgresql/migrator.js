'use strict';

/**
 * Migrator PostgreSQL (ADR-003).
 *
 * Preserva integralmente as garantias do migrator SQLite (`src/db/migrator.js`),
 * que sao requisito T-05 e nao mudam por causa do banco:
 *
 *  - ordem deterministica por versao numerica;
 *  - migration aplicada roda UMA unica vez;
 *  - registro do que foi aplicado em `schema_migration`;
 *  - checksum SHA-256 do arquivo;
 *  - alteracao retroativa de migration ja aplicada ABORTA a execucao;
 *  - cada migration e atomica (SQL + registro no mesmo BEGIN/COMMIT);
 *  - falha faz ROLLBACK e nao deixa registro parcial;
 *  - banco vazio e reconstruivel integralmente pelas migrations.
 *
 * Duas diferencas em relacao ao SQLite, ambas deliberadas:
 *
 *  1. a API e assincrona (ver ADR-003);
 *  2. `aplicada_em` usa `now()` do PostgreSQL, e nao `strftime()` do SQLite —
 *     copiar a funcao SQLite para ca seria carregar uma peculiaridade de um
 *     banco para dentro do outro sem nenhum ganho.
 *
 * O DDL do PostgreSQL e transacional (diferente de MySQL), entao o BEGIN/COMMIT
 * ao redor de cada migration realmente desfaz tabelas e indices criados.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { POSTGRESQL_MIGRATIONS_DIR } = require('../../config');
const { withTransaction } = require('./connection');

const MIGRATION_FILE_RE = /^(\d{3,})_([A-Za-z0-9_-]+)\.sql$/;

const CREATE_CONTROL_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migration (
    version     TEXT PRIMARY KEY,
    nome        TEXT NOT NULL,
    checksum    TEXT NOT NULL,
    aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now()
  )
`;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Lista as migrations PostgreSQL do disco, ordenadas por versao numerica. */
function listMigrations(dir = POSTGRESQL_MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .map((file) => {
      const match = MIGRATION_FILE_RE.exec(file);
      if (match === null) return null;
      return { version: match[1], nome: match[2], file, fullPath: path.join(dir, file) };
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => Number(a.version) - Number(b.version));
}

/**
 * Garante a tabela de controle e devolve o que ja foi aplicado.
 * @param {import('pg').Pool} pool
 */
async function appliedMigrations(pool) {
  await pool.query(CREATE_CONTROL_TABLE);
  const { rows } = await pool.query('SELECT version, nome, checksum FROM schema_migration');
  return new Map(rows.map((row) => [row.version, row]));
}

/**
 * Aplica as migrations PostgreSQL pendentes.
 *
 * @param {import('pg').Pool} pool
 * @param {{ dir?: string, logger?: ((msg: string) => void) | null }} [options]
 * @returns {Promise<{applied: string[], skipped: string[]}>}
 */
async function runMigrations(pool, { dir = POSTGRESQL_MIGRATIONS_DIR, logger = null } = {}) {
  const migrations = listMigrations(dir);
  const already = await appliedMigrations(pool);

  const applied = [];
  const skipped = [];

  for (const migration of migrations) {
    const sql = fs.readFileSync(migration.fullPath, 'utf8');
    const checksum = sha256(sql);
    const previous = already.get(migration.version);

    if (previous !== undefined) {
      if (previous.checksum !== checksum) {
        throw new Error(
          `Migration ${migration.file} ja aplicada, mas o conteudo mudou ` +
            `(checksum ${previous.checksum} != ${checksum}). ` +
            'Migrations aplicadas sao imutaveis: crie uma nova migration.'
        );
      }
      skipped.push(migration.file);
      continue;
    }

    try {
      // SQL e registro no MESMO client e na MESMA transacao: se o INSERT de
      // controle falhasse fora dela, o schema avancaria sem rastro do que rodou.
      await withTransaction(pool, async (client) => {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migration (version, nome, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.nome, checksum]
        );
      });
    } catch (error) {
      throw new Error(`Falha ao aplicar migration ${migration.file}: ${error.message}`, {
        cause: error,
      });
    }

    applied.push(migration.file);
    if (logger !== null) logger(`aplicada: ${migration.file}`);
  }

  return { applied, skipped };
}

module.exports = { runMigrations, listMigrations, sha256, MIGRATION_FILE_RE, CREATE_CONTROL_TABLE };
