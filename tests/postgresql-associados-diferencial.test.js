'use strict';

// Teste DIFERENCIAL SQLite x PostgreSQL — leitura de associados (ADR-003, PG-2A).
//
// Os dois arquivos de teste que ja existem provam cada implementacao contra um
// resultado ESCRITO A MAO. Isso deixa um buraco: se as duas trilhas divergirem
// num caso que ninguem pensou em escrever, nada acusa. Aqui as duas rodam sobre
// o MESMO dataset e os resultados sao comparados UM CONTRA O OUTRO — o oraculo
// e a outra implementacao, nao a expectativa do autor.
//
// E deliberadamente CURTO: cobre as duas construcoes SQL que precisaram de
// decisao propria no PostgreSQL — a ordenacao (`COLLATE NOCASE` nao existe la) e
// o LIKE insensivel a caixa com metacaracteres literais. O resto do contrato ja
// esta coberto pelas duas suites, e duplica-lo aqui so criaria manutencao dupla.
//
// Isolamento: schema PostgreSQL dedicado + banco SQLite temporario, ambos
// criados e derrubados pelo proprio teste. Somente `TEST_DATABASE_URL` habilita
// a suite; `DATABASE_URL` nunca e usada como fallback.
//
// Fixtures minimas e ficticias.

const test = require('node:test');
const assert = require('node:assert/strict');

const sqlite = require('../src/services/associados');
const postgresql = require('../src/services/associados-postgresql');
const { runMigrations } = require('../src/db/postgresql/migrator');
const { createMigratedDb } = require('./helpers/temp-db');
const { motivoSkip, schemaIsolado } = require('./helpers/postgres');

const skip = motivoSkip();

/**
 * Dataset comum. A ordem de INSERCAO e a mesma nos dois bancos, entao os ids
 * gerados coincidem e o desempate por id e comparavel de verdade.
 *
 * Inclui, de proposito:
 *   * `Ana Lima`, `carlos Dias`, `Zebra` — caixa mista em ASCII;
 *   * `Álvaro`, `ábaco` — acentuados, onde `lower()` com locale divergiria;
 *   * `ANA lima` / `ana LIMA` — caixa diferente para o MESMO nome, que so o
 *     desempate por id mantem estavel;
 *   * `Ana%Paula`, `Ana_Paula`, `Ana\Paula` — metacaracteres de LIKE no dado.
 */
const NOMES = [
  'Zebra',
  'ábaco',
  'Ana Lima',
  'Álvaro',
  'carlos Dias',
  'ANA lima',
  'ana LIMA',
  'Ana%Paula',
  'Ana_Paula',
  'Ana\\Paula',
  'José Gonçalves',
  'jose goncalves',
];

/** Termos de busca comparados nos dois bancos. */
const BUSCAS = [
  // caixa ASCII
  'ana',
  'ANA',
  'AnA lImA',
  'zebra',
  'Dias',
  // acentuado
  'Álvaro',
  'álvaro',
  'ábaco',
  'Gonçalves',
  'gonçalves',
  // metacaracteres de LIKE digitados pelo usuario: devem ser LITERAIS
  '%',
  '_',
  '\\',
  'Ana%',
  'Ana_',
  'Ana\\',
  'Ana%Paula',
  'Ana_Paula',
  'Ana\\Paula',
  // sem correspondencia
  'Ninguem',
];

function nomes(resultado) {
  return resultado.itens.map((item) => item.nome);
}

async function montarCenario(t) {
  const { db } = createMigratedDb(t);
  const { pool } = await schemaIsolado(t);
  await runMigrations(pool);

  for (const [indice, nome] of NOMES.entries()) {
    const legacyId = String(indice + 1);
    db.prepare('INSERT INTO associado (legacy_id, nome) VALUES (?, ?)').run(legacyId, nome);
    await pool.query('INSERT INTO associado (legacy_id, nome) VALUES ($1, $2)', [legacyId, nome]);
  }

  return { db, pool };
}

test('DIFERENCIAL: a ordenacao e identica nos dois bancos', { skip }, async (t) => {
  const { db, pool } = await montarCenario(t);

  const ordemSqlite = nomes(sqlite.listarAssociados(db));
  const ordemPostgresql = nomes(await postgresql.listarAssociados(pool));

  // A comparacao que importa: uma implementacao contra a outra.
  assert.deepEqual(
    ordemPostgresql,
    ordemSqlite,
    'a ordenacao PostgreSQL divergiu da SQLite — `lower(nome COLLATE "C")` ' +
      'deixou de reproduzir `COLLATE NOCASE`'
  );

  // Ancora explicita: se as DUAS mudarem juntas, a comparacao acima passaria
  // sem que ninguem percebesse a mudanca de comportamento.
  assert.deepEqual(ordemSqlite, [
    // Mesma chave de ordenacao ('ana lima'): a ordem entre os tres vem do
    // desempate por id, isto e, da ordem de insercao.
    'Ana Lima',
    'ANA lima',
    'ana LIMA',
    // Espaco (0x20) < '%' (0x25) < '\' (0x5C) < '_' (0x5F): comparacao por byte.
    'Ana%Paula',
    'Ana\\Paula',
    'Ana_Paula',
    'carlos Dias',
    // 'e' (0x65) < 'é' (0xC3...): a grafia sem acento vem antes.
    'jose goncalves',
    'José Gonçalves',
    'Zebra',
    // Acentuados depois de todo o ASCII, nos dois bancos.
    'Álvaro',
    'ábaco',
  ]);

  // Os ids tambem batem: o desempate e o mesmo, nao so a sequencia de nomes.
  assert.deepEqual(
    (await postgresql.listarAssociados(pool)).itens.map((item) => item.id),
    sqlite.listarAssociados(db).itens.map((item) => item.id)
  );
});

test('DIFERENCIAL: a busca por nome devolve o mesmo conjunto nos dois bancos', { skip }, async (t) => {
  const { db, pool } = await montarCenario(t);

  for (const termo of BUSCAS) {
    const esperado = nomes(sqlite.listarAssociados(db, { nome: termo }));
    const obtido = nomes(await postgresql.listarAssociados(pool, { nome: termo }));

    assert.deepEqual(obtido, esperado, `busca divergiu para o termo ${JSON.stringify(termo)}`);
  }

  // Ancoras de comportamento, para o caso de as duas mudarem juntas:
  // metacaractere digitado e literal, e nao curinga que lista todo mundo.
  assert.deepEqual(nomes(sqlite.listarAssociados(db, { nome: '%' })), ['Ana%Paula']);
  assert.deepEqual(nomes(sqlite.listarAssociados(db, { nome: '_' })), ['Ana_Paula']);
  assert.deepEqual(nomes(sqlite.listarAssociados(db, { nome: '\\' })), ['Ana\\Paula']);
  // Caixa ASCII casa; acentuado casa apenas na grafia acentuada.
  assert.deepEqual(nomes(sqlite.listarAssociados(db, { nome: 'ANA lima' })), [
    'Ana Lima',
    'ANA lima',
    'ana LIMA',
  ]);
  assert.deepEqual(nomes(sqlite.listarAssociados(db, { nome: 'Gonçalves' })), ['José Gonçalves']);
});

test('DIFERENCIAL: legacy_id textual e detalhe por id coincidem', { skip }, async (t) => {
  const { db, pool } = await montarCenario(t);

  // '007' nao pode colidir com '7' em nenhuma das duas trilhas.
  db.prepare('INSERT INTO associado (legacy_id, nome) VALUES (?, ?)').run('007', 'Zero Zero Sete');
  await pool.query('INSERT INTO associado (legacy_id, nome) VALUES ($1, $2)', [
    '007',
    'Zero Zero Sete',
  ]);

  for (const legacyId of ['007', '7', '1', '12', 'inexistente', '   ', '']) {
    const esperado = sqlite.obterAssociadoPorLegacyId(db, legacyId);
    const obtido = await postgresql.obterAssociadoPorLegacyId(pool, legacyId);

    assert.deepEqual(
      obtido === null ? null : { legacyId: obtido.legacyId, nome: obtido.nome },
      esperado === null ? null : { legacyId: esperado.legacyId, nome: esperado.nome },
      `legacy_id divergiu para ${JSON.stringify(legacyId)}`
    );
  }

  // Detalhe por id: o conjunto de chaves do contrato tem de ser o mesmo, e
  // nenhuma das duas pode ganhar campo financeiro derivado (M-06).
  const detalheSqlite = sqlite.obterAssociado(db, 1);
  const detalhePostgresql = await postgresql.obterAssociado(pool, 1);

  assert.deepEqual(Object.keys(detalhePostgresql).sort(), Object.keys(detalheSqlite).sort());
  assert.equal(detalhePostgresql.nome, detalheSqlite.nome);
  assert.equal(detalhePostgresql.legacyId, detalheSqlite.legacyId);
  assert.equal(detalhePostgresql.legacyStatusCode, detalheSqlite.legacyStatusCode);
  assert.equal(typeof detalhePostgresql.criadoEm, typeof detalheSqlite.criadoEm);

  // Id invalido e id inexistente: mesma resposta nas duas.
  for (const id of [999, 'abc', 0, -1, null, undefined]) {
    assert.equal(await postgresql.obterAssociado(pool, id), sqlite.obterAssociado(db, id));
  }
});
