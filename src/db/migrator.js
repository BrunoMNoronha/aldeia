'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { MIGRATIONS_DIR } = require('../config');

const MIGRATION_FILE_RE = /^(\d{3,})_([A-Za-z0-9_-]+)\.sql$/;

const CREATE_CONTROL_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migration (
    version     TEXT PRIMARY KEY,
    nome        TEXT NOT NULL,
    checksum    TEXT NOT NULL,
    aplicada_em TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )
`;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Lista as migrations do disco, ordenadas por versao numerica. */
function listMigrations(dir = MIGRATIONS_DIR) {
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

function appliedMigrations(db) {
  db.exec(CREATE_CONTROL_TABLE);
  const rows = db.prepare('SELECT version, nome, checksum FROM schema_migration').all();
  return new Map(rows.map((row) => [row.version, row]));
}

/**
 * Aplica as migrations pendentes.
 *
 * Garantias:
 *  - idempotente: migration ja registrada nao roda de novo (nao destroi dados);
 *  - atomica por migration: SQL + registro no mesmo BEGIN/COMMIT, entao uma
 *    falha nao deixa o banco parcialmente migrado;
 *  - deteccao de deriva: se o arquivo de uma migration ja aplicada mudou,
 *    o checksum diverge e a execucao aborta em vez de reaplicar.
 *
 * @returns {{applied: string[], skipped: string[]}}
 */
function runMigrations(db, { dir = MIGRATIONS_DIR, logger = null } = {}) {
  const migrations = listMigrations(dir);
  const already = appliedMigrations(db);

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

    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migration (version, nome, checksum) VALUES (?, ?, ?)').run(
        migration.version,
        migration.nome,
        checksum
      );
      db.exec('COMMIT');
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw new Error(`Falha ao aplicar migration ${migration.file}: ${error.message}`, {
        cause: error,
      });
    }

    applied.push(migration.file);
    if (logger !== null) logger(`aplicada: ${migration.file}`);
  }

  return { applied, skipped };
}

module.exports = { runMigrations, listMigrations, MIGRATION_FILE_RE };
