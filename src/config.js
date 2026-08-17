'use strict';

const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

/** Diretorio das migrations SQL versionadas. */
const MIGRATIONS_DIR = path.join(ROOT_DIR, 'migrations');

/** Caminho padrao do banco quando DB_PATH nao e informado. */
const DEFAULT_DB_PATH = path.join(ROOT_DIR, 'data', 'acasa.sqlite');

/**
 * Resolve o caminho do banco.
 * Configuravel por DB_PATH; nao exige arquivo .env para funcionar.
 */
function resolveDbPath(env = process.env) {
  const raw = env.DB_PATH;
  if (!raw || raw.trim() === '') return DEFAULT_DB_PATH;
  const value = raw.trim();
  if (value === ':memory:') return value;
  return path.resolve(ROOT_DIR, value);
}

function resolvePort(env = process.env) {
  const parsed = Number.parseInt(env.PORT ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 3000;
}

module.exports = {
  ROOT_DIR,
  MIGRATIONS_DIR,
  DEFAULT_DB_PATH,
  resolveDbPath,
  resolvePort,
};
