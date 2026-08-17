'use strict';

// Leitura cadastral de associados no PostgreSQL (F-01 / F-02) — ADR-003, PG-2A.
//
// ---------------------------------------------------------------------------
// ESTA IMPLEMENTACAO NAO ESTA NO RUNTIME
// ---------------------------------------------------------------------------
// Nenhuma rota, pagina, view ou script consome este modulo. O runtime continua
// no SQLite (`associados.js`) ate PG-6, que e o ponto formal do cutover. Este
// arquivo existe para que a equivalencia seja PROVADA por teste antes do
// cutover, e nao descoberta depois dele.
//
// Nao ha dual-write nem sincronizacao: o modulo e somente leitura e so enxerga o
// que ja estiver no PostgreSQL.
//
// ---------------------------------------------------------------------------
// O que muda em relacao ao SQLite, e o que NAO muda
// ---------------------------------------------------------------------------
// MUDA (inevitavelmente):
//   * a API e assincrona — `better-sqlite3` e sincrono e `pg` nao e (ADR-003);
//   * o primeiro parametro e um `Pool`/`PoolClient` do `pg`, nao um `Database`;
//   * os parametros sao posicionais `$1..$n`, nao `?`.
//
// NAO MUDA (e ha teste para cada item):
//   * `legacy_id` e TEXTO comparado por igualdade exata — sem CAST, sem
//     parseInt, sem perder zeros a esquerda ('007' != '7');
//   * `%`, `_` e `\` digitados sao literais do nome, nunca curingas;
//   * busca por nome e parcial e insensivel a caixa em ASCII;
//   * ordenacao deterministica por nome (sem caixa) com desempate por id;
//   * `LIMITE_PADRAO`, consulta de `limite + 1`, deteccao de `truncado` e
//     `total` contando apenas os itens desta resposta;
//   * `legacy_status_code` volta verbatim (C-01 segue TO CONFIRM) e nenhum campo
//     de situacao financeira e derivado (M-06).
//
// O contrato comum vive em `associados-contrato.js`: as duas trilhas usam a
// MESMA normalizacao de entrada e o MESMO mapeamento de saida, entao a unica
// coisa que este arquivo pode fazer divergir e o SQL — que e o que os testes de
// equivalencia atacam.

const {
  LIMITE_PADRAO,
  COLUNAS_ASSOCIADO,
  normalizarTexto,
  idInteiroPositivo,
  limiteValido,
  padraoContem,
  mapearAssociado,
  montarListagem,
} = require('./associados-contrato');

// ---------------------------------------------------------------------------
// Ordenacao — reproduzindo `COLLATE NOCASE` do SQLite
// ---------------------------------------------------------------------------
//
// `COLLATE NOCASE` do SQLite faz duas coisas: dobra APENAS as letras ASCII A-Z e
// depois compara BYTE a byte. Nao existe collation com esse nome no PostgreSQL,
// e as alternativas obvias erram de lados opostos:
//
//   * `lower(nome)` com a collation padrao do banco dobra tambem os acentuados
//     ('A' e 'a' juntos, mas tambem 'A' com acento) e ordena por regra de locale
//     — o resultado passaria a depender de com qual locale o servidor foi
//     inicializado, o que e o oposto de deterministico;
//   * `ORDER BY nome` puro seria sensivel a caixa e mudaria a listagem.
//
// `lower(nome COLLATE "C")` resolve os dois: sob a collation "C" a funcao
// `lower` dobra somente ASCII, e o resultado herda "C", entao a comparacao e
// byte a byte. E a mesma semantica do NOCASE, e nao depende do locale do
// servidor nem de extensao alguma — "C" e nativa do PostgreSQL.
//
// Diferenca residual, deliberada e sem impacto na ordem observada: sob NOCASE o
// SQLite compara os bytes ORIGINAIS de caracteres nao-ASCII e aqui comparamos os
// bytes apos `lower`, que nao altera nao-ASCII sob "C". As duas ordens
// coincidem; o desempate por `id` garante estabilidade em qualquer caso.
const ORDENACAO = 'ORDER BY lower(nome COLLATE "C") ASC, id ASC';

// ---------------------------------------------------------------------------
// Busca por nome — reproduzindo o LIKE insensivel a caixa do SQLite
// ---------------------------------------------------------------------------
//
// O `LIKE` do SQLite ja e insensivel a caixa em ASCII; o do PostgreSQL e
// sensivel. `ILIKE` seria o atalho, mas ele dobra caixa segundo o locale
// (incluindo acentuados), o que AMPLIARIA o conjunto de resultados em relacao ao
// comportamento atual — mudanca de comportamento disfarcada de conversao.
//
// Dobrar os dois lados sob "C" da exatamente o alcance de hoje. `%`, `_` e `\`
// nao sao afetados por `lower`, entao o escape aplicado em `padraoContem`
// continua valendo, com `ESCAPE '\'` explicito nos dois bancos.
function filtroNome(placeholder) {
  return `lower(nome COLLATE "C") LIKE lower(${placeholder}::text COLLATE "C") ESCAPE '\\'`;
}

// `associado.id` e `INTEGER` (int4) no schema PostgreSQL. Um id acima do teto do
// int4 nao pode existir na coluna, e mandar esse valor ao banco produziria um
// erro de conversao onde o SQLite simplesmente nao acharia a linha. Recusar
// antes preserva a resposta: id que nao pode existir devolve `null`, igual a id
// inexistente. Este teto pertence a ESTA trilha (e o tipo da coluna), por isso
// nao esta no contrato compartilhado.
const ID_MAXIMO_INT4 = 2_147_483_647;

const SQL_ASSOCIADO_POR_ID = `SELECT ${COLUNAS_ASSOCIADO} FROM associado WHERE id = $1`;

const SQL_ASSOCIADO_POR_LEGACY_ID = `SELECT ${COLUNAS_ASSOCIADO} FROM associado WHERE legacy_id = $1`;

/**
 * Lista associados com filtros opcionais.
 *
 * Os dois filtros combinam com AND: pedir nome E legacy_id significa "este
 * associado", nunca "qualquer um dos dois".
 *
 * @param {import('pg').Pool | import('pg').PoolClient} pool
 * @param {object} [filtros]
 * @param {string|null} [filtros.nome] busca parcial, case-insensitive (ASCII).
 * @param {string|null} [filtros.legacyId] igualdade EXATA como texto.
 * @param {number} [filtros.limite]
 * @returns {Promise<{itens: object[], total: number, truncado: boolean,
 *            filtros: {nome: string|null, legacyId: string|null}}>}
 */
async function listarAssociados(pool, { nome = null, legacyId = null, limite = LIMITE_PADRAO } = {}) {
  const nomeFiltro = normalizarTexto(nome);
  const legacyIdFiltro = normalizarTexto(legacyId);
  const teto = limiteValido(limite);

  const clausulas = [];
  const parametros = [];

  // A numeracao dos placeholders acompanha `parametros.length`: com filtros
  // OPCIONAIS, numero fixo escrito a mao e o erro classico — omitir o filtro de
  // nome deslocaria todos os seguintes e o `LIMIT` leria o parametro errado.
  const proximoPlaceholder = () => `$${parametros.length + 1}`;

  if (nomeFiltro !== null) {
    clausulas.push(filtroNome(proximoPlaceholder()));
    parametros.push(padraoContem(nomeFiltro));
  }
  if (legacyIdFiltro !== null) {
    // Comparacao de TEXTO: '007' e '7' sao identidades diferentes.
    clausulas.push(`legacy_id = ${proximoPlaceholder()}`);
    parametros.push(legacyIdFiltro);
  }

  const where = clausulas.length === 0 ? '' : `WHERE ${clausulas.join(' AND ')} `;
  const placeholderLimite = proximoPlaceholder();
  const sql = `SELECT ${COLUNAS_ASSOCIADO} FROM associado ${where}${ORDENACAO} LIMIT ${placeholderLimite}`;

  // Uma linha a mais que o teto: e assim que se sabe que houve corte sem
  // contar o universo inteiro.
  parametros.push(teto + 1);

  const { rows } = await pool.query(sql, parametros);

  return montarListagem(rows, teto, { nome: nomeFiltro, legacyId: legacyIdFiltro });
}

/**
 * Detalhe cadastral por id interno.
 *
 * Id invalido e id inexistente sao a MESMA resposta: `null`. Nao existir nao e
 * excecao de dominio — e o caso normal de uma URL digitada a mao.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} pool
 * @param {unknown} id
 * @returns {Promise<object | null>}
 */
async function obterAssociado(pool, id) {
  const idValido = idInteiroPositivo(id);
  if (idValido === null || idValido > ID_MAXIMO_INT4) return null;

  const { rows } = await pool.query(SQL_ASSOCIADO_POR_ID, [idValido]);
  return mapearAssociado(rows[0]);
}

/**
 * Detalhe cadastral pelo identificador da planilha, por igualdade exata de
 * texto. Nao ha parseInt, CAST nem remocao de zeros a esquerda.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} pool
 * @param {unknown} legacyId
 * @returns {Promise<object | null>}
 */
async function obterAssociadoPorLegacyId(pool, legacyId) {
  const legacyIdFiltro = normalizarTexto(legacyId);
  if (legacyIdFiltro === null) return null;

  const { rows } = await pool.query(SQL_ASSOCIADO_POR_LEGACY_ID, [legacyIdFiltro]);
  return mapearAssociado(rows[0]);
}

module.exports = {
  LIMITE_PADRAO,
  ID_MAXIMO_INT4,
  listarAssociados,
  obterAssociado,
  obterAssociadoPorLegacyId,
};
