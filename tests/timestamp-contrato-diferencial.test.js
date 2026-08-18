'use strict';

// Teste DIFERENCIAL de contrato — precisao publica de timestamp (SQLite x PG-2A x PG-2B1).
//
// `mapearAssociado` (`associados-contrato.js`) e `mapearComprovante`
// (`comprovantes-contrato.js`) NAO sao funcoes exclusivas do PostgreSQL: sao o
// MESMO caminho que `src/services/associados.js` e `src/services/comprovantes.js`
// (trilha SQLite, runtime atual) chamam sobre a linha que leem do
// `better-sqlite3`. Nao existe um "mapeador SQLite" separado — o contrato e
// compartilhado por desenho (ver AGENTS.md, T-08).
//
// A unica coisa que difere entre as trilhas e o TIPO que `row.criado_em` chega:
//   SQLite     -> string, ja no formato TEXT gravado pelo schema
//                 (`strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`);
//   PostgreSQL -> `Date`, que e o que o driver `pg` entrega para TIMESTAMPTZ.
//
// Este teste exercita os DOIS caminhos reais — mesma funcao de mapeamento,
// entrada string de um lado e `Date` do outro — e compara o resultado publico
// por VALOR exato, nao por tipo ou regex.

const test = require('node:test');
const assert = require('node:assert/strict');

const { mapearAssociado } = require('../src/services/associados-contrato');
const { mapearComprovante } = require('../src/services/comprovantes-contrato');

// Mesmo instante, duas representacoes de origem — a diferenca real entre as trilhas.
const INSTANTE_SQLITE = '2026-01-10T12:34:56Z'; // como o SQLite ja guarda em TEXT.
const INSTANTE_POSTGRESQL = new Date('2026-01-10T12:34:56.000Z'); // como o driver `pg` entrega.
const ESPERADO = '2026-01-10T12:34:56Z';

function linhaAssociado(criadoEm) {
  return {
    id: 1,
    legacy_id: '1',
    nome: 'Fulano',
    status_cadastral: 'ativo',
    legacy_status_code: null,
    observacoes: null,
    criado_em: criadoEm,
    atualizado_em: criadoEm,
  };
}

function linhaComprovante(criadoEm) {
  return {
    id: 1,
    movimento_id: 1,
    estado: 'presente',
    observacao: null,
    referencia_externa: null,
    data: '2026-01-10',
    criado_em: criadoEm,
    atualizado_em: criadoEm,
  };
}

test('DIFERENCIAL: mapearAssociado devolve o mesmo timestamp publico para linha SQLite e linha PostgreSQL', () => {
  // A — SQLite real: a MESMA funcao de mapeamento do runtime SQLite, com a
  // entrada string que `better-sqlite3` de fato entrega.
  const resultadoSqlite = mapearAssociado(linhaAssociado(INSTANTE_SQLITE));
  // B — PostgreSQL real: a MESMA funcao, com a entrada `Date` que `pg` entrega.
  const resultadoPostgresql = mapearAssociado(linhaAssociado(INSTANTE_POSTGRESQL));

  // C — igualdade exata, por valor, nao por tipo/regex.
  assert.equal(resultadoSqlite.criadoEm, ESPERADO);
  assert.equal(resultadoPostgresql.criadoEm, ESPERADO);
  assert.equal(resultadoSqlite.criadoEm, resultadoPostgresql.criadoEm);

  // F — atualizadoEm tambem.
  assert.equal(resultadoSqlite.atualizadoEm, ESPERADO);
  assert.equal(resultadoPostgresql.atualizadoEm, ESPERADO);
  assert.equal(resultadoSqlite.atualizadoEm, resultadoPostgresql.atualizadoEm);

  // D — tipo, nas duas trilhas.
  assert.equal(typeof resultadoSqlite.criadoEm, 'string');
  assert.equal(typeof resultadoPostgresql.criadoEm, 'string');

  // E — sem fracao de milissegundo no contrato publico.
  assert.ok(!resultadoSqlite.criadoEm.includes('.000Z'));
  assert.ok(!resultadoPostgresql.criadoEm.includes('.000Z'));
});

test('DIFERENCIAL: mapearComprovante devolve o mesmo timestamp publico para linha SQLite e linha PostgreSQL', () => {
  // A/B — mesma funcao real de PG-2B1, entrada string (SQLite) e Date (PostgreSQL).
  const resultadoSqlite = mapearComprovante(linhaComprovante(INSTANTE_SQLITE));
  const resultadoPostgresql = mapearComprovante(linhaComprovante(INSTANTE_POSTGRESQL));

  // C — igualdade exata.
  assert.equal(resultadoSqlite.criadoEm, ESPERADO);
  assert.equal(resultadoPostgresql.criadoEm, ESPERADO);
  assert.equal(resultadoSqlite.criadoEm, resultadoPostgresql.criadoEm);

  // F — atualizadoEm tambem.
  assert.equal(resultadoSqlite.atualizadoEm, ESPERADO);
  assert.equal(resultadoPostgresql.atualizadoEm, ESPERADO);
  assert.equal(resultadoSqlite.atualizadoEm, resultadoPostgresql.atualizadoEm);

  // D — tipo.
  assert.equal(typeof resultadoSqlite.criadoEm, 'string');
  assert.equal(typeof resultadoPostgresql.criadoEm, 'string');

  // E — sem fracao de milissegundo.
  assert.ok(!resultadoSqlite.criadoEm.includes('.000Z'));
  assert.ok(!resultadoPostgresql.criadoEm.includes('.000Z'));
});

test('DIFERENCIAL: PG-2A e PG-2B1 concordam entre si sobre o mesmo instante (G)', () => {
  // G — os dois mapeadores PostgreSQL continuam obedecendo ao mesmo contrato
  // um do outro, com o mesmo `Date` de entrada.
  const associado = mapearAssociado(linhaAssociado(INSTANTE_POSTGRESQL));
  const comprovante = mapearComprovante(linhaComprovante(INSTANTE_POSTGRESQL));

  assert.equal(associado.criadoEm, comprovante.criadoEm);
  assert.equal(associado.atualizadoEm, comprovante.atualizadoEm);
  assert.equal(associado.criadoEm, ESPERADO);
});
