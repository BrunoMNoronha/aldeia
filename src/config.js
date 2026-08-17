'use strict';

const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

/** Diretorio das migrations SQL versionadas (SQLite). */
const MIGRATIONS_DIR = path.join(ROOT_DIR, 'migrations');

/**
 * Diretorio das migrations PostgreSQL (ADR-003).
 *
 * Fica em um subdiretorio de `migrations/` de proposito: `listMigrations` do
 * migrator SQLite so aceita arquivos que casem com `NNN_nome.sql`, entao a
 * pasta `postgresql/` e ignorada por ele e as duas trilhas nao se misturam.
 */
const POSTGRESQL_MIGRATIONS_DIR = path.join(ROOT_DIR, 'migrations', 'postgresql');

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
  // O comentario `turbopackIgnore` e um adaptador para o build do Next.js, sem
  // nenhum efeito em tempo de execucao: o caminho vem de DB_PATH e so pode ser
  // resolvido rodando, entao a analise estatica do Turbopack incluiria o projeto
  // INTEIRO — `data/` e a planilha legada junto — no rastreamento do servidor.
  // O banco continua sendo resolvido exatamente como antes.
  return path.resolve(/* turbopackIgnore: true */ ROOT_DIR, value);
}

/**
 * URL de conexao do PostgreSQL oficial (ADR-003).
 *
 * Retorna `null` quando nao configurada: durante a transicao SQLite -> PostgreSQL
 * a aplicacao ainda roda sem PostgreSQL nenhum, entao ausencia de DATABASE_URL
 * NAO e erro de configuracao — e o estado normal de quem so usa o runtime SQLite.
 * Quem exige PostgreSQL e responsavel por recusar o `null`.
 *
 * @returns {string | null}
 */
function resolveDatabaseUrl(env = process.env) {
  const raw = env.DATABASE_URL;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw.trim();
}

/**
 * URL de conexao do PostgreSQL usado por TESTES de integracao.
 *
 * Deliberadamente NAO cai para `DATABASE_URL`: teste de integracao cria e
 * derruba schema, e herdar silenciosamente a conexao oficial seria o caminho
 * mais curto para um teste apagar producao. Sem TEST_DATABASE_URL, os testes que
 * exigem banco real sao PULADOS de forma visivel (ver `tests/helpers/postgres.js`).
 *
 * @returns {string | null}
 */
function resolveTestDatabaseUrl(env = process.env) {
  const raw = env.TEST_DATABASE_URL;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw.trim();
}

function resolvePort(env = process.env) {
  const parsed = Number.parseInt(env.PORT ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : 3000;
}

module.exports = {
  ROOT_DIR,
  MIGRATIONS_DIR,
  POSTGRESQL_MIGRATIONS_DIR,
  DEFAULT_DB_PATH,
  resolveDbPath,
  resolveDatabaseUrl,
  resolveTestDatabaseUrl,
  resolvePort,
};
