'use strict';

// Leitura cadastral de associados no SQLite (F-01 / F-02).
//
// Este servico e SOMENTE LEITURA: nao ha INSERT, UPDATE, DELETE nem
// withTransaction. Ele existe para alimentar a superficie HTML operacional.
//
// O contrato (normalizacao de entrada, escape de LIKE, mapeamento de saida,
// limite/truncamento) vive em `associados-contrato.js` e e COMPARTILHADO com a
// implementacao PostgreSQL (`associados-postgresql.js`, ADR-003 / PG-2). Aqui
// fica apenas o que e especifico do SQLite: o SQL e a chamada sincrona do
// `better-sqlite3`.
//
// Este arquivo e TRANSITORIO. O SQLite continua sendo o runtime ate PG-6 e a
// retirada do `better-sqlite3` acontece em PG-7; nesse momento este modulo sai e
// o contrato permanece.
//
// O que este servico NAO faz:
//   * interpretar `legacy_status_code` ('a', 'i', 'DESLIGADO', ...) — C-01 segue
//     TO CONFIRM e o codigo bruto e devolvido verbatim;
//   * derivar situacao financeira, adimplencia, saldo ou "em dia" (M-06:
//     status cadastral != situacao financeira);
//   * corrigir acentuacao, caixa, grafia ou zeros a esquerda do legado;
//   * tratar `legacy_id` como numero (a planilha pode ter '007' e '7' como
//     identidades DIFERENTES).

const {
  LIMITE_PADRAO,
  normalizarTexto,
  idInteiroPositivo,
  limiteValido,
  padraoContem,
  mapearAssociado,
  montarListagem,
} = require('./associados-contrato');

/** Colunas lidas. Nomes de coluna do schema SQLite (`migrations/001_...sql`). */
const COLUNAS_ASSOCIADO = `
    id,
    legacy_id,
    nome,
    status_cadastral,
    legacy_status_code,
    observacoes,
    criado_em,
    atualizado_em`;

/**
 * Ordenacao deterministica: nome sem sensibilidade a caixa, desempate estavel
 * pelo id. Sem isso duas chamadas iguais poderiam devolver ordens diferentes.
 */
const ORDENACAO = 'ORDER BY nome COLLATE NOCASE ASC, id ASC';

const SQL_ASSOCIADO_POR_ID = `SELECT ${COLUNAS_ASSOCIADO} FROM associado WHERE id = ?`;

const SQL_ASSOCIADO_POR_LEGACY_ID = `SELECT ${COLUNAS_ASSOCIADO} FROM associado WHERE legacy_id = ?`;

// --- leitura ------------------------------------------------------------------

/**
 * Lista associados com filtros opcionais.
 *
 * Os dois filtros combinam com AND: pedir nome E legacy_id significa "este
 * associado", nunca "qualquer um dos dois".
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [filtros]
 * @param {string|null} [filtros.nome] busca parcial, case-insensitive (ASCII).
 * @param {string|null} [filtros.legacyId] igualdade EXATA como texto.
 * @param {number} [filtros.limite]
 * @returns {{itens: object[], total: number, truncado: boolean,
 *            filtros: {nome: string|null, legacyId: string|null}}}
 *          `total` e a quantidade de itens DESTA resposta. Quando `truncado` e
 *          true existem mais registros que nao foram contados — a UI precisa
 *          dizer isso em vez de apresentar um recorte como se fosse o universo.
 */
function listarAssociados(db, { nome = null, legacyId = null, limite = LIMITE_PADRAO } = {}) {
  const nomeFiltro = normalizarTexto(nome);
  const legacyIdFiltro = normalizarTexto(legacyId);
  const teto = limiteValido(limite);

  const clausulas = [];
  const parametros = [];

  if (nomeFiltro !== null) {
    clausulas.push("nome LIKE ? ESCAPE '\\'");
    parametros.push(padraoContem(nomeFiltro));
  }
  if (legacyIdFiltro !== null) {
    // Comparacao de TEXTO: '007' e '7' sao identidades diferentes.
    clausulas.push('legacy_id = ?');
    parametros.push(legacyIdFiltro);
  }

  const where = clausulas.length === 0 ? '' : `WHERE ${clausulas.join(' AND ')} `;
  const sql = `SELECT ${COLUNAS_ASSOCIADO} FROM associado ${where}${ORDENACAO} LIMIT ?`;

  // Uma linha a mais que o teto: e assim que se sabe que houve corte sem
  // contar o universo inteiro.
  const linhas = db.prepare(sql).all(...parametros, teto + 1);

  return montarListagem(linhas, teto, { nome: nomeFiltro, legacyId: legacyIdFiltro });
}

/**
 * Detalhe cadastral por id interno.
 *
 * Id invalido e id inexistente sao a MESMA resposta: `null`. Nao existir nao e
 * excecao de dominio — e o caso normal de uma URL digitada a mao.
 */
function obterAssociado(db, id) {
  const idValido = idInteiroPositivo(id);
  if (idValido === null) return null;
  return mapearAssociado(db.prepare(SQL_ASSOCIADO_POR_ID).get(idValido));
}

/**
 * Detalhe cadastral pelo identificador da planilha, por igualdade exata de
 * texto. Nao ha parseInt, CAST nem remocao de zeros a esquerda.
 */
function obterAssociadoPorLegacyId(db, legacyId) {
  const legacyIdFiltro = normalizarTexto(legacyId);
  if (legacyIdFiltro === null) return null;
  return mapearAssociado(db.prepare(SQL_ASSOCIADO_POR_LEGACY_ID).get(legacyIdFiltro));
}

module.exports = {
  LIMITE_PADRAO,
  listarAssociados,
  obterAssociado,
  obterAssociadoPorLegacyId,
};
