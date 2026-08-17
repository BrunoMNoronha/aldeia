'use strict';

// Protecao defensiva do banco de teste PostgreSQL (ADR-003).
//
// Estes testes nao precisam de PostgreSQL nenhum: eles verificam a barreira que
// decide SE um teste destrutivo pode rodar. E a barreira mais importante do
// pacote PG-1, porque a falha que ela previne — apontar a suite para o banco
// oficial — nao tem desfazer.

const test = require('node:test');
const assert = require('node:assert/strict');

const { avaliarBancoDeTeste, NOMES_PROIBIDOS } = require('./helpers/postgres');

const OFICIAL = 'postgres://app:senha@db.interno:5432/acasa';

test('sem TEST_DATABASE_URL, nenhum teste destrutivo e liberado', () => {
  const { seguro, motivo } = avaliarBancoDeTeste(null, OFICIAL);

  assert.equal(seguro, false);
  assert.match(motivo, /TEST_DATABASE_URL/);
});

test('DATABASE_URL nunca vira banco de teste por reaproveitamento', () => {
  const { seguro, motivo } = avaliarBancoDeTeste(OFICIAL, OFICIAL);

  assert.equal(seguro, false);
  assert.match(motivo, /identica a DATABASE_URL/);
});

test('URL invalida falha fechado', () => {
  for (const url of ['', 'nao-e-url', 'postgres//sem-dois-pontos']) {
    const { seguro } = avaliarBancoDeTeste(url === '' ? null : url, OFICIAL);
    assert.equal(seguro, false, `deveria recusar: ${JSON.stringify(url)}`);
  }
});

test('protocolo diferente de postgres e recusado', () => {
  const { seguro, motivo } = avaliarBancoDeTeste('mysql://u:p@localhost:3306/acasa_test', OFICIAL);

  assert.equal(seguro, false);
  assert.match(motivo, /protocolo/);
});

test('bancos de sistema e de producao sao recusados pelo nome', () => {
  for (const nome of NOMES_PROIBIDOS) {
    const { seguro } = avaliarBancoDeTeste(`postgres://u:p@localhost:5432/${nome}`, OFICIAL);
    assert.equal(seguro, false, `deveria recusar o banco ${nome}`);
  }
});

test('banco que nao se declara de teste no nome e recusado', () => {
  const { seguro, motivo } = avaliarBancoDeTeste('postgres://u:p@localhost:5432/aldeia', OFICIAL);

  assert.equal(seguro, false);
  assert.match(motivo, /nao contem "test"/);
});

test('URL sem nome de banco e recusada', () => {
  const { seguro, motivo } = avaliarBancoDeTeste('postgres://u:p@localhost:5432', OFICIAL);

  assert.equal(seguro, false);
  assert.match(motivo, /nao nomeia um banco/);
});

test('banco de teste explicito e aceito', () => {
  const { seguro, motivo } = avaliarBancoDeTeste(
    'postgres://u:p@localhost:5432/acasa_test',
    OFICIAL
  );

  assert.equal(seguro, true);
  assert.equal(motivo, 'ok');
});

test('banco de teste e aceito mesmo quando DATABASE_URL nao existe', () => {
  const { seguro } = avaliarBancoDeTeste('postgres://u:p@localhost:5432/acasa_test', null);

  assert.equal(seguro, true);
});
