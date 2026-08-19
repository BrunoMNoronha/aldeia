'use strict';

// Normalizacao de TRANSPORTE, comum a todas as trilhas (ADR-003).
//
// Durante a migracao SQLite -> PostgreSQL o MESMO fato chega em tipos
// diferentes: instante como texto ou como `Date`, booleano como 0/1 ou como
// `true`/`false`. O contrato publico do sistema nao pode depender de qual banco
// respondeu — se dependesse, o cutover mudaria a forma de todo campo sem
// ninguem pedir.
//
// Nada aqui e regra de dominio: o FATO nao muda, apenas a serializacao. Nada
// aqui conhece `better-sqlite3`, `pg` ou SQL.

/**
 * Instante de auditoria como texto UTC, com precisao de SEGUNDO.
 *
 * O SQLite guarda TEXT gerado por `strftime('%Y-%m-%dT%H:%M:%SZ','now')` e o
 * PostgreSQL guarda TIMESTAMPTZ, que o driver `pg` entrega como `Date`.
 *
 * `toISOString()` sozinho NAO resolve: ele produz `.000Z` (milissegundos), e o
 * contrato observavel — verificado nos testes do SQLite — e
 * `YYYY-MM-DDTHH:MM:SSZ`, sem fracao. A precisao completa continua no banco.
 *
 * @param {unknown} valor
 * @returns {string | null}
 */
function normalizarInstante(valor) {
  if (valor === undefined || valor === null) return null;
  if (valor instanceof Date) return `${valor.toISOString().slice(0, 19)}Z`;
  return valor;
}

/**
 * Data CIVIL (`movimento_financeiro.data`, `comprovante.data`, ...).
 *
 * Nao ha conversao de fuso aqui, e isso e o ponto: o PostgreSQL entrega `DATE`
 * como texto 'YYYY-MM-DD' (parser instalado em `src/db/postgresql/connection.js`)
 * e o SQLite ja guarda o mesmo texto. Promover uma data civil a instante pode
 * move-la de dia, de mes e portanto de competencia (M-10).
 *
 * @param {unknown} valor
 * @returns {string | null}
 */
function normalizarDataCivil(valor) {
  if (valor === undefined || valor === null) return null;
  return valor;
}

/**
 * `ativo` como booleano no contrato publico.
 *
 * O SQLite guarda 0/1 (`CHECK (ativo IN (0,1))`) e o PostgreSQL guarda BOOLEAN.
 * Sem esta normalizacao uma trilha devolveria `1` e a outra `true` no MESMO
 * campo.
 *
 * A conversao e ESTRITA de proposito. Um `Boolean(valor)` aceitaria qualquer
 * coisa e transformaria lixo em `true`/`false` sem ninguem perceber; um
 * `valor === 1` — como o mapper do ledger fazia — devolveria `false` para o
 * `true` do PostgreSQL, apagando silenciosamente a diferenca entre um registro
 * ativo e um inativado (M-09). Valor fora do vocabulario dos dois bancos e
 * dado corrompido e deve explodir, nao virar `false`.
 *
 * @param {unknown} valor
 * @returns {boolean}
 * @throws {TypeError} para qualquer valor que nao seja 0, 1, `false` ou `true`.
 */
function normalizarBooleano(valor) {
  if (valor === true || valor === 1) return true;
  if (valor === false || valor === 0) return false;
  throw new TypeError(
    `valor booleano invalido vindo do banco: ${typeof valor} ${String(valor)}. ` +
      'Esperado 0/1 (SQLite) ou false/true (PostgreSQL).'
  );
}

module.exports = { normalizarInstante, normalizarDataCivil, normalizarBooleano };
