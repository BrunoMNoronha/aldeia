'use strict';

// Contrato de leitura cadastral de associados, INDEPENDENTE de banco (F-01/F-02).
//
// Por que este arquivo existe (ADR-003 / PG-2):
//   durante a migracao SQLite -> PostgreSQL as duas implementacoes de leitura
//   convivem. Se cada uma carregasse sua propria copia da normalizacao de
//   entrada e do mapeamento de saida, elas poderiam divergir em silencio — e a
//   divergencia so apareceria no cutover (PG-6), ja em producao. Aqui o contrato
//   e UNICO: `associados.js` (SQLite) e `associados-postgresql.js` consomem
//   exatamente as mesmas regras, e a diferenca entre os dois fica restrita ao
//   SQL e ao driver.
//
// Nada aqui conhece `better-sqlite3` ou `pg`. Nada aqui emite SQL.
//
// O que este modulo NAO faz (as mesmas proibicoes de sempre):
//   * interpretar `legacy_status_code` ('a', 'i', 'DESLIGADO', ...) — C-01 segue
//     TO CONFIRM e o codigo bruto e devolvido verbatim;
//   * derivar situacao financeira, adimplencia, saldo ou "em dia" (M-06);
//   * corrigir acentuacao, caixa, grafia ou zeros a esquerda do legado;
//   * tratar `legacy_id` como numero ('007' e '7' sao identidades DIFERENTES).

/** Teto padrao de linhas por consulta. A UI avisa quando ha mais. */
const LIMITE_PADRAO = 500;

// Nao ha lista de colunas nem SQL aqui: nome de coluna e conhecimento de schema,
// portanto de persistencia (T-08). Cada trilha declara a sua — a PostgreSQL em
// `src/db/postgresql/associados.js`, a SQLite em `associados.js` enquanto ela
// existir (o SQLite sai em PG-7).

// --- normalizacao de entrada -------------------------------------------------

/**
 * Texto de filtro vindo de query string ou chamada direta.
 * Nao-string (undefined, null, array de query duplicada) nao vira filtro:
 * um filtro que o servico nao entende deve ser IGNORADO, nunca adivinhado.
 *
 * @param {unknown} valor
 * @returns {string | null}
 */
function normalizarTexto(valor) {
  if (typeof valor !== 'string') return null;
  const limpo = valor.trim();
  return limpo === '' ? null : limpo;
}

/**
 * `%`, `_` e `\` digitados pelo usuario sao caracteres LITERAIS do nome, nao
 * curingas. Escapamos antes de montar o padrao; o SQL usa ESCAPE '\'.
 *
 * @param {string} texto
 * @returns {string}
 */
function escaparLike(texto) {
  return texto.replace(/[\\%_]/g, (caractere) => `\\${caractere}`);
}

/**
 * Padrao LIKE de busca parcial, ja escapado.
 *
 * @param {string} texto
 * @returns {string}
 */
function padraoContem(texto) {
  return `%${escaparLike(texto)}%`;
}

/**
 * Aceita apenas inteiro positivo (numero ou string de digitos).
 *
 * @param {unknown} valor
 * @returns {number | null}
 */
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

/**
 * @param {unknown} valor
 * @returns {number}
 */
function limiteValido(valor) {
  return Number.isInteger(valor) && valor > 0 ? valor : LIMITE_PADRAO;
}

// --- mapeamento linha -> objeto de dominio -----------------------------------

/**
 * Instante de auditoria como texto UTC, com precisao de SEGUNDO.
 *
 * As duas trilhas guardam o mesmo FATO em tipos diferentes: o SQLite guarda
 * TEXT ISO-8601 e o PostgreSQL guarda TIMESTAMPTZ, que o driver `pg` entrega
 * como `Date`. O contrato observavel do servico e string (ha teste explicito:
 * `typeof associado.criadoEm === 'string'`), entao a normalizacao acontece aqui,
 * uma vez, em vez de vazar um tipo diferente para a UI depois do cutover.
 *
 * `toISOString()` sozinho NAO resolve: ele produz `.000Z` (milissegundos), e o
 * contrato observavel hoje — verificado nos testes do SQLite e espelhado em
 * PG-2B1 (`comprovantes-contrato.js`) — e `YYYY-MM-DDTHH:MM:SSZ`, sem fracao.
 * Truncamos a fracao para que as duas trilhas devolvam a MESMA string.
 *
 * Isto e conversao de TRANSPORTE, nao regra de dominio: nenhum valor e
 * reinterpretado, apenas serializado. A precisao completa continua no banco.
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
 * Espelha a linha do banco, nada mais.
 *
 * Deliberadamente NAO existem campos como `situacao`, `situacaoFinanceira`,
 * `adimplente`, `inadimplente`, `saldo`, `emDia` ou `devedor`: nenhum deles
 * pode ser derivado do cadastro (M-06) e inventa-los aqui contaminaria toda a
 * UI com uma interpretacao que a baseline ainda nao autorizou.
 *
 * @param {Record<string, unknown> | null | undefined} row
 * @returns {object | null}
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
    criadoEm: normalizarInstante(row.criado_em),
    atualizadoEm: normalizarInstante(row.atualizado_em),
  };
}

// --- resposta da listagem -----------------------------------------------------

/**
 * Aplica o corte por limite e monta a resposta de `listarAssociados`.
 *
 * A consulta pede `limite + 1` linhas: e assim que se sabe que houve corte sem
 * contar o universo inteiro. `total` e a quantidade de itens DESTA resposta;
 * quando `truncado` e true existem mais registros que nao foram contados — a UI
 * precisa dizer isso em vez de apresentar um recorte como se fosse o universo.
 *
 * @param {object[]} linhas linhas cruas, ja limitadas a `teto + 1`
 * @param {number} teto
 * @param {{nome: string|null, legacyId: string|null}} filtros
 * @returns {{itens: object[], total: number, truncado: boolean,
 *            filtros: {nome: string|null, legacyId: string|null}}}
 */
function montarListagem(linhas, teto, filtros) {
  const truncado = linhas.length > teto;
  const itens = (truncado ? linhas.slice(0, teto) : linhas).map(mapearAssociado);

  return {
    itens,
    total: itens.length,
    truncado,
    filtros,
  };
}

module.exports = {
  LIMITE_PADRAO,
  normalizarTexto,
  escaparLike,
  padraoContem,
  idInteiroPositivo,
  limiteValido,
  normalizarInstante,
  mapearAssociado,
  montarListagem,
};
