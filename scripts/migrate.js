#!/usr/bin/env node
'use strict';

// Cria/atualiza o banco SQLite exclusivamente a partir das migrations versionadas (T-05).
// Uso: npm run migrate            (usa DB_PATH ou data/acasa.sqlite)
//      DB_PATH=... npm run migrate

const { openDatabase } = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrator');
const { resolveDbPath } = require('../src/config');

function main() {
  const dbPath = resolveDbPath();
  const db = openDatabase(dbPath);

  try {
    console.log(`banco: ${dbPath}`);
    const { applied, skipped } = runMigrations(db, { logger: (msg) => console.log(`  ${msg}`) });

    if (applied.length === 0) {
      console.log(`nenhuma migration pendente (${skipped.length} ja aplicada(s))`);
    } else {
      console.log(`${applied.length} migration(s) aplicada(s), ${skipped.length} ja aplicada(s)`);
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`erro na migracao: ${error.message}`);
  process.exitCode = 1;
}
