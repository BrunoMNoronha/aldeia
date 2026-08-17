'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runMigrations, listMigrations } = require('../src/db/migrator');
const { tempWorkspace, createMigratedDb } = require('./helpers/temp-db');

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

function tabelas(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
}

test('migrations criam o banco a partir do zero', (t) => {
  const ws = tempWorkspace(t);

  assert.equal(fs.existsSync(ws.dbPath), false, 'banco nao deve existir antes da migration');

  const db = ws.open();
  const { applied, skipped } = runMigrations(db);

  assert.ok(applied.length > 0, 'ao menos uma migration deve ser aplicada');
  assert.equal(skipped.length, 0);
  assert.equal(fs.existsSync(ws.dbPath), true);
});

test('todas as entidades principais existem apos a migration', (t) => {
  const { db } = createMigratedDb(t);

  const existentes = tabelas(db);
  for (const tabela of TABELAS_OBRIGATORIAS) {
    assert.ok(existentes.includes(tabela), `tabela ausente: ${tabela}`);
  }
  assert.ok(existentes.includes('schema_migration'), 'controle de migrations ausente');
});

test('foreign keys estao habilitadas e sao aplicadas', (t) => {
  const { db } = createMigratedDb(t);

  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);

  // FK inexistente deve ser rejeitada pelo banco, nao pela aplicacao.
  assert.throws(
    () =>
      db
        .prepare(
          'INSERT INTO movimento_financeiro (data, valor_centavos, tipo, associado_id) VALUES (?, ?, ?, ?)'
        )
        .run('2026-01-10', 2500, 'credito', 999999),
    /FOREIGN KEY/i
  );
});

test('migrations ja aplicadas nao sao reaplicadas e nao destroem dados', (t) => {
  const ws = tempWorkspace(t);

  const primeira = ws.open();
  const r1 = runMigrations(primeira);
  primeira
    .prepare('INSERT INTO associado (legacy_id, nome) VALUES (?, ?)')
    .run('LEGADO-1', 'Associado de Teste');
  primeira.close();

  const segunda = ws.open();
  const r2 = runMigrations(segunda);

  assert.equal(r2.applied.length, 0, 'nenhuma migration deve ser reaplicada');
  assert.deepEqual(r2.skipped, r1.applied, 'todas devem constar como ja aplicadas');

  const registradas = segunda.prepare('SELECT COUNT(*) AS total FROM schema_migration').get();
  assert.equal(registradas.total, r1.applied.length, 'sem registros duplicados de migration');

  const associados = segunda.prepare('SELECT COUNT(*) AS total FROM associado').get();
  assert.equal(associados.total, 1, 'reexecutar migrations nao pode apagar dados');
});

test('migrations aplicadas sao imutaveis: alteracao no arquivo aborta a execucao', (t) => {
  const ws = tempWorkspace(t);
  const migrationsDir = path.join(ws.dir, 'migrations');
  fs.mkdirSync(migrationsDir);
  fs.writeFileSync(path.join(migrationsDir, '001_teste.sql'), 'CREATE TABLE t1 (id INTEGER);');

  const db = ws.open();
  runMigrations(db, { dir: migrationsDir });

  fs.writeFileSync(path.join(migrationsDir, '001_teste.sql'), 'CREATE TABLE t2 (id INTEGER);');

  assert.throws(() => runMigrations(db, { dir: migrationsDir }), /checksum/i);
});

test('falha no meio da migration nao deixa o banco parcialmente migrado', (t) => {
  const ws = tempWorkspace(t);
  const migrationsDir = path.join(ws.dir, 'migrations');
  fs.mkdirSync(migrationsDir);
  fs.writeFileSync(
    path.join(migrationsDir, '001_quebrada.sql'),
    'CREATE TABLE ok_antes (id INTEGER);\nISTO NAO E SQL VALIDO;\n'
  );

  const db = ws.open();

  assert.throws(() => runMigrations(db, { dir: migrationsDir }), /001_quebrada\.sql/);

  assert.equal(tabelas(db).includes('ok_antes'), false, 'rollback deve desfazer o que ja rodou');

  const registradas = db.prepare('SELECT COUNT(*) AS total FROM schema_migration').get();
  assert.equal(registradas.total, 0, 'migration falha nao pode ficar registrada');
});

test('as migrations do projeto seguem a convencao versionada', () => {
  const migrations = listMigrations();
  assert.ok(migrations.length > 0, 'deve existir ao menos uma migration');
  assert.equal(migrations[0].file, '001_initial_schema.sql');

  const versoes = migrations.map((m) => m.version);
  assert.equal(new Set(versoes).size, versoes.length, 'versoes de migration devem ser unicas');
});
