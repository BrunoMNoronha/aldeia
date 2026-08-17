'use strict';

// Migrator PostgreSQL (ADR-003 / PG-1).
//
// As garantias verificadas aqui sao as MESMAS de `tests/migrations.test.js`
// (SQLite): T-05 nao muda por causa do banco. Migration aplicada e imutavel,
// nao roda duas vezes, e falha no meio nao deixa schema pela metade.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runMigrations, listMigrations, sha256 } = require('../src/db/postgresql/migrator');
const { motivoSkip, schemaIsolado } = require('./helpers/postgres');

const TABELAS_OBRIGATORIAS = [
  'associado',
  'competencia',
  'movimento_financeiro',
  'alocacao',
  'ajuste_credito_debito',
  'comprovante',
  'pendencia',
  'importacao',
  'legacy_cell',
  'legacy_cell_link',
  'audit_log',
];

async function tabelas(pool, schema) {
  const { rows } = await pool.query(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
    [schema]
  );
  return rows.map((row) => row.table_name);
}

/** Diretorio de migrations descartavel, para os casos de erro. */
function migrationsTemporarias(t, arquivos) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acasa-pgmig-'));
  for (const [nome, conteudo] of Object.entries(arquivos)) {
    fs.writeFileSync(path.join(dir, nome), conteudo);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return dir;
}

// ---------------------------------------------------------------------------
// Sem dependencia de PostgreSQL
// ---------------------------------------------------------------------------

test('as migrations PostgreSQL do projeto seguem a convencao versionada', () => {
  const migrations = listMigrations();

  assert.ok(migrations.length > 0, 'deve existir ao menos uma migration PostgreSQL');
  assert.equal(migrations[0].file, '001_initial_schema.sql');

  const versoes = migrations.map((m) => m.version);
  assert.equal(new Set(versoes).size, versoes.length, 'versoes de migration devem ser unicas');
});

test('as migrations PostgreSQL nao usam tipo de ponto flutuante (T-06)', () => {
  for (const migration of listMigrations()) {
    const sql = fs.readFileSync(migration.fullPath, 'utf8');
    // Fora de comentario: nenhuma coluna pode ser declarada como float.
    const codigo = sql
      .split('\n')
      .filter((linha) => !linha.trim().startsWith('--'))
      .join('\n');

    assert.doesNotMatch(codigo, /\b(REAL|FLOAT|DOUBLE\s+PRECISION)\b/i, migration.file);
  }
});

test('a trilha SQLite e a trilha PostgreSQL nao se enxergam', () => {
  const sqlite = require('../src/db/migrator').listMigrations();
  const postgres = listMigrations();

  const arquivosSqlite = sqlite.map((m) => m.fullPath);
  const arquivosPostgres = postgres.map((m) => m.fullPath);

  for (const arquivo of arquivosPostgres) {
    assert.equal(arquivosSqlite.includes(arquivo), false, `vazou para o SQLite: ${arquivo}`);
  }
  assert.deepEqual(
    sqlite.map((m) => m.file),
    [
      '001_initial_schema.sql',
      '002_legacy_cell_valor_bruto_tipado.sql',
      '003_comprovante_por_movimento.sql',
    ],
    'as migrations SQLite historicas nao podem mudar'
  );
});

// ---------------------------------------------------------------------------
// Exigem PostgreSQL real (TEST_DATABASE_URL)
// ---------------------------------------------------------------------------

test('migrations criam o schema a partir do zero', { skip: motivoSkip() }, async (t) => {
  const { pool, schema } = await schemaIsolado(t);

  assert.deepEqual(await tabelas(pool, schema), [], 'o schema deve comecar vazio');

  const { applied, skipped } = await runMigrations(pool);

  assert.ok(applied.length > 0, 'ao menos uma migration deve ser aplicada');
  assert.deepEqual(skipped, []);
});

test('todas as entidades principais existem apos a migration', { skip: motivoSkip() }, async (t) => {
  const { pool, schema } = await schemaIsolado(t);
  await runMigrations(pool);

  const existentes = await tabelas(pool, schema);
  for (const tabela of TABELAS_OBRIGATORIAS) {
    assert.ok(existentes.includes(tabela), `tabela ausente: ${tabela}`);
  }
  assert.ok(existentes.includes('schema_migration'), 'controle de migrations ausente');
});

test('migrations ja aplicadas nao sao reaplicadas e nao destroem dados', { skip: motivoSkip() }, async (t) => {
  const { pool } = await schemaIsolado(t);

  const r1 = await runMigrations(pool);
  await pool.query('INSERT INTO associado (legacy_id, nome) VALUES ($1, $2)', [
    'LEGADO-1',
    'Associado de Teste',
  ]);

  const r2 = await runMigrations(pool);

  assert.deepEqual(r2.applied, [], 'nenhuma migration deve ser reaplicada');
  assert.deepEqual(r2.skipped, r1.applied, 'todas devem constar como ja aplicadas');

  const registradas = await pool.query('SELECT COUNT(*) AS total FROM schema_migration');
  assert.equal(
    Number(registradas.rows[0].total),
    r1.applied.length,
    'sem registros duplicados de migration'
  );

  const associados = await pool.query('SELECT COUNT(*) AS total FROM associado');
  assert.equal(Number(associados.rows[0].total), 1, 'reexecutar migrations nao pode apagar dados');
});

test('o checksum de cada migration aplicada e persistido', { skip: motivoSkip() }, async (t) => {
  const { pool } = await schemaIsolado(t);
  await runMigrations(pool);

  const { rows } = await pool.query(
    'SELECT version, nome, checksum, aplicada_em FROM schema_migration ORDER BY version'
  );
  const noDisco = listMigrations();

  assert.equal(rows.length, noDisco.length);

  for (const [i, registro] of rows.entries()) {
    const esperado = sha256(fs.readFileSync(noDisco[i].fullPath, 'utf8'));

    assert.equal(registro.version, noDisco[i].version);
    assert.equal(registro.nome, noDisco[i].nome);
    assert.equal(registro.checksum, esperado, 'checksum divergente do arquivo');
    assert.match(registro.checksum, /^[0-9a-f]{64}$/, 'checksum deve ser SHA-256 hexadecimal');
    assert.ok(registro.aplicada_em instanceof Date, 'aplicada_em deve ser timestamp nativo');
  }
});

test('migrations aplicadas sao imutaveis: alteracao no arquivo aborta a execucao', { skip: motivoSkip() }, async (t) => {
  const { pool } = await schemaIsolado(t);
  const dir = migrationsTemporarias(t, { '001_teste.sql': 'CREATE TABLE t1 (id INTEGER);' });

  await runMigrations(pool, { dir });

  fs.writeFileSync(path.join(dir, '001_teste.sql'), 'CREATE TABLE t2 (id INTEGER);');

  await assert.rejects(() => runMigrations(pool, { dir }), /checksum/i);
});

test('falha no meio da migration nao deixa o schema parcialmente migrado', { skip: motivoSkip() }, async (t) => {
  const { pool, schema } = await schemaIsolado(t);
  const dir = migrationsTemporarias(t, {
    '001_quebrada.sql': 'CREATE TABLE ok_antes (id INTEGER);\nISTO NAO E SQL VALIDO;\n',
  });

  await assert.rejects(() => runMigrations(pool, { dir }), /001_quebrada\.sql/);

  const existentes = await tabelas(pool, schema);
  assert.equal(existentes.includes('ok_antes'), false, 'rollback deve desfazer o que ja rodou');

  const registradas = await pool.query('SELECT COUNT(*) AS total FROM schema_migration');
  assert.equal(
    Number(registradas.rows[0].total),
    0,
    'migration falha nao pode ficar registrada em schema_migration'
  );
});

test('uma migration que falha nao impede as anteriores de permanecerem aplicadas', { skip: motivoSkip() }, async (t) => {
  const { pool, schema } = await schemaIsolado(t);
  const dir = migrationsTemporarias(t, {
    '001_boa.sql': 'CREATE TABLE primeira (id INTEGER);',
    '002_quebrada.sql': 'CREATE TABLE segunda (id INTEGER);\nSINTAXE INVALIDA AQUI;\n',
  });

  await assert.rejects(() => runMigrations(pool, { dir }), /002_quebrada\.sql/);

  const existentes = await tabelas(pool, schema);
  assert.ok(existentes.includes('primeira'), '001 ja estava commitada e deve permanecer');
  assert.equal(existentes.includes('segunda'), false, '002 deve ter sido inteiramente desfeita');

  const { rows } = await pool.query('SELECT version FROM schema_migration ORDER BY version');
  assert.deepEqual(
    rows.map((r) => r.version),
    ['001'],
    'apenas a migration efetivamente concluida fica registrada'
  );
});
