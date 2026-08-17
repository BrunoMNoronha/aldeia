'use strict';

// Leitura cadastral de associados (F-01 / F-02).
//
// Este servico e SOMENTE LEITURA: nao ha INSERT, UPDATE, DELETE nem
// withTransaction. Ele existe para alimentar a superficie HTML operacional.
//
// O que este servico NAO faz:
//   * interpretar `legacy_status_code` ('a', 'i', 'DESLIGADO', ...) — C-01 segue
//     TO CONFIRM e o codigo bruto e devolvido verbatim;
//   * derivar situacao financeira, adimplencia, saldo ou "em dia" (M-06:
//     status cadastral != situacao financeira);
//   * corrigir acentuacao, caixa, grafia ou zeros a esquerda do legado;
//   * tratar `legacy_id` como numero (a planilha pode ter '007' e '7' como
//     identidades DIFERENTES).

/** Teto padrao de linhas por consulta. A UI avisa quando ha mais. */
const LIMITE_PADRAO = 500;

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

// --- normalizacao de entrada -------------------------------------------------

/**
 * Texto de filtro vindo de query string ou chamada direta.
 * Nao-string (undefined, null, array de query duplicada) nao vira filtro:
 * um filtro que o servico nao entende deve ser IGNORADO, nunca adivinhado.
 */
function normalizarTexto(valor) {
  if (typeof valor !== 'string') return null;
  const limpo = valor.trim();
  return limpo === '' ? null : limpo;
}

/**
 * `%`, `_` e `\` digitados pelo usuario sao caracteres LITERAIS do nome, nao
 * curingas. Escapamos antes de montar o padrao; o SQL usa ESCAPE '\'.
 */
function escaparLike(texto) {
  return texto.replace(/[\\%_]/g, (caractere) => `\\${caractere}`);
}

/** Aceita apenas inteiro positivo (numero ou string de digitos). */
function idInteiroPositivo(valor) {
  if (typeof valor === 'number') {
    return Number.isInteger(valor) && valor > 0 ? valor : null;
  }
  if (typeof valor === 'string' && /^\d+$/.test(valor)) {
    const numero = Number(valor);
    return numero > 0 ? numero : null;
  }
  return null;
}

function limiteValido(valor) {
  return Number.isInteger(valor) && valor > 0 ? valor : LIMITE_PADRAO;
}

// --- mapeamento linha -> objeto de dominio -----------------------------------

/**
 * Espelha a linha do banco, nada mais.
 *
 * Deliberadamente NAO existem campos como `situacao`, `situacaoFinanceira`,
 * `adimplente`, `inadimplente`, `saldo`, `emDia` ou `devedor`: nenhum deles
 * pode ser derivado do cadastro (M-06) e inventa-los aqui contaminaria toda a
 * UI com uma interpretacao que a baseline ainda nao autorizou.
 */
function mapearAssociado(row) {
  if (row === undefined || row === null) return null;
  return {
    id: row.id,
    legacyId: row.legacy_id,
    nome: row.nome,
    statusCadastral: row.status_cadastral,
    legacyStatusCode: row.legacy_status_code,
    observacoes: row.observacoes,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

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
    parametros.push(`%${escaparLike(nomeFiltro)}%`);
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
  const truncado = linhas.length > teto;
  const itens = (truncado ? linhas.slice(0, teto) : linhas).map(mapearAssociado);

  return {
    itens,
    total: itens.length,
    truncado,
    filtros: { nome: nomeFiltro, legacyId: legacyIdFiltro },
  };
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
