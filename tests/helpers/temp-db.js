'use strict';

// Helper de testes: banco temporario fora de `data/`.
// Nenhum teste pode tocar o banco real do desenvolvedor.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase } = require('../../src/db/connection');
const { runMigrations } = require('../../src/db/migrator');

function removeTempDir(dir) {
  // maxRetries: no Windows o arquivo SQLite pode continuar bloqueado por um
  // instante depois do close().
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

/**
 * Cria um diretorio temporario e registra a limpeza no proprio contexto do teste.
 * A limpeza fecha TODAS as conexoes abertas por este helper antes de apagar os
 * arquivos, o que evita EPERM no Windows.
 *
 * @param {import('node:test').TestContext} t
 */
function tempWorkspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acasa-test-'));
  const conexoes = [];

  t.after(() => {
    for (const db of conexoes) {
      if (db.open) db.close();
    }
    removeTempDir(dir);
  });

  const dbPath = path.join(dir, 'test.sqlite');

  return {
    dir,
    dbPath,
    /** Abre uma conexao rastreada (fechada automaticamente ao fim do teste). */
    open(caminho = dbPath) {
      const db = openDatabase(caminho);
      conexoes.push(db);
      return db;
    },
  };
}

/** Banco temporario ja migrado, com limpeza registrada em `t`. */
function createMigratedDb(t) {
  const workspace = tempWorkspace(t);
  const db = workspace.open();
  const result = runMigrations(db);
  return { db, result, ...workspace };
}

module.exports = { tempWorkspace, createMigratedDb, removeTempDir };
