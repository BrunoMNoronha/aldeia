'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const { resolveDbPath } = require('../config');

/**
 * Abre uma conexao SQLite ja configurada.
 *
 * - PRAGMA foreign_keys = ON (obrigatorio: integridade referencial).
 * - WAL em bancos em arquivo (leitura concorrente com escrita).
 * - busy_timeout evita SQLITE_BUSY imediato em acesso concorrente.
 *
 * Cria o diretorio do arquivo se ainda nao existir.
 */
function openDatabase(dbPath = resolveDbPath()) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }

  return db;
}

/**
 * Executa `fn` dentro de uma transacao SQLite (T-07).
 * Faz COMMIT no sucesso e ROLLBACK em qualquer erro.
 *
 * Usa BEGIN IMMEDIATE para adquirir o lock de escrita no inicio, evitando
 * falha tardia de upgrade de lock em operacoes financeiras multi-registro.
 */
function withTransaction(db, fn) {
  if (db.inTransaction) return fn(db);

  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

let singleton = null;

/** Conexao compartilhada do processo (aplicacao web). */
function getDatabase() {
  if (singleton === null || !singleton.open) {
    singleton = openDatabase();
  }
  return singleton;
}

function closeDatabase() {
  if (singleton !== null && singleton.open) singleton.close();
  singleton = null;
}

module.exports = { openDatabase, getDatabase, closeDatabase, withTransaction };
