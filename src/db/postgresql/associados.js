'use strict';

/**
 * Persistencia PostgreSQL de associado — leitura (ADR-003, PG-2A).
 *
 * T-08 separa dominio, PERSISTENCIA, importacao e transporte web. Este modulo e
 * a camada de persistencia: aqui, e somente aqui, moram o SQL PostgreSQL, os
 * placeholders `$n`, o `COLLATE "C"`, o teto do `int4` e a chamada ao driver.
 * Quem consome recebe LINHAS do banco e nada mais.
 *
 * O que este modulo deliberadamente NAO faz:
 *   * normalizar filtro de entrada (trim, string vazia, tipo errado);
 *   * validar id;
 *   * escapar o padrao de busca — recebe o padrao LIKE ja pronto;
 *   * decidir limite padrao ou detectar truncamento;
 *   * mapear linha para o contrato publico (`legacyId`, `criadoEm`, ...).
 *
 * Tudo isso e regra de caso de uso e vive em `src/services/`. A direcao da
 * dependencia e SEMPRE service -> db; este arquivo nao conhece `src/services/`,
 * e adicionar um `require` para la inverteria a camada.
 *
 * Somente leitura: nao ha INSERT, UPDATE, DELETE nem transacao.
 */

/**
 * Colunas lidas. E conhecimento de SCHEMA, portanto de persistencia: os nomes
 * vem de `migrations/postgresql/001_initial_schema.sql`.
 */
const COLUNAS_ASSOCIADO = `
    id,
    legacy_id,
    nome,
    status_cadastral,
    legacy_status_code,
    observacoes,
    criado_em,
    atualizado_em`;

// ---------------------------------------------------------------------------
// Ordenacao — reproduzindo `COLLATE NOCASE` do SQLite
// ---------------------------------------------------------------------------
//
// `COLLATE NOCASE` do SQLite faz duas coisas: dobra APENAS as letras ASCII A-Z e
// depois compara BYTE a byte. Nao existe collation com esse nome no PostgreSQL,
// e as alternativas obvias erram de lados opostos:
//
//   * `lower(nome)` com a collation padrao do banco dobra tambem os acentuados
//     e ordena por regra de locale — o resultado passaria a depender de com qual
//     locale o servidor foi inicializado, o oposto de deterministico;
//   * `ORDER BY nome` puro seria sensivel a caixa e mudaria a listagem.
//
// `lower(nome COLLATE "C")` resolve os dois: sob a collation "C" a funcao
// `lower` dobra somente ASCII, e o resultado herda "C", entao a comparacao e
// byte a byte. E a mesma semantica do NOCASE, sem depender do locale do servidor
// e sem extensao alguma — "C" e nativa do PostgreSQL.
//
// O desempate por `id` e o que impede duas chamadas iguais de devolverem ordens
// diferentes quando os nomes empatam.
//
// A equivalencia com o SQLite e verificada por teste diferencial
// (`tests/postgresql-associados-diferencial.test.js`), executando as duas
// implementacoes sobre o mesmo dataset e comparando a sequencia resultante.
const ORDENACAO = 'ORDER BY lower(nome COLLATE "C") ASC, id ASC';

// ---------------------------------------------------------------------------
// Busca por nome — reproduzindo o LIKE insensivel a caixa do SQLite
// ---------------------------------------------------------------------------
//
// O `LIKE` do SQLite ja e insensivel a caixa em ASCII; o do PostgreSQL e
// sensivel. `ILIKE` seria o atalho, mas dobra caixa segundo o locale (incluindo
// acentuados), o que AMPLIARIA o conjunto de resultados em relacao ao
// comportamento atual — mudanca de comportamento disfarcada de conversao.
//
// Dobrar os dois lados sob "C" da exatamente o alcance de hoje. `%`, `_` e `\`
// nao sao afetados por `lower`, entao o escape aplicado pelo caso de uso
// continua valendo, com `ESCAPE '\'` explicito.
function filtroNome(placeholder) {
  return `lower(nome COLLATE "C") LIKE lower(${placeholder}::text COLLATE "C") ESCAPE '\\'`;
}

/**
 * `associado.id` e `INTEGER` (int4) no schema PostgreSQL. Um id acima deste teto
 * nao pode existir na coluna, e envia-lo ao banco produziria erro de conversao
 * onde o SQLite simplesmente nao acharia a linha.
 *
 * O teto e conhecimento do TIPO DA COLUNA, por isso mora aqui e nao no contrato
 * compartilhado: no SQLite a mesma coluna e de 64 bits e um id acima de 2^31 e
 * legitimo.
 */
const ID_MAXIMO_INT4 = 2_147_483_647;

const SQL_POR_ID = `SELECT ${COLUNAS_ASSOCIADO} FROM associado WHERE id = $1`;

const SQL_POR_LEGACY_ID = `SELECT ${COLUNAS_ASSOCIADO} FROM associado WHERE legacy_id = $1`;

/**
 * Busca linhas de associado, com filtros opcionais ja normalizados.
 *
 * Os filtros combinam com AND: receber nome E legacy_id significa "este
 * associado", nunca "qualquer um dos dois".
 *
 * @param {import('pg').Pool | import('pg').PoolClient} pool
 * @param {object} [criterios]
 * @param {string|null} [criterios.nomePadraoLike] padrao LIKE JA ESCAPADO pelo
 *   caso de uso (os metacaracteres digitados pelo usuario ja viraram literais).
 *   Este modulo nao escapa nada: escapar de novo duplicaria as barras.
 * @param {string|null} [criterios.legacyId] igualdade EXATA de texto.
 * @param {number} criterios.limite quantas linhas no maximo. Quem chama decide
 *   se pede uma linha a mais para detectar truncamento — isso e regra de
 *   apresentacao, nao de persistencia.
 * @returns {Promise<object[]>} linhas cruas, com os nomes de coluna do schema.
 */
async function buscarAssociados(pool, { nomePadraoLike = null, legacyId = null, limite } = {}) {
  const clausulas = [];
  const parametros = [];

  // A numeracao dos placeholders acompanha `parametros.length`: com filtros
  // OPCIONAIS, numero fixo escrito a mao e o erro classico — omitir o filtro de
  // nome deslocaria todos os seguintes e o `LIMIT` leria o parametro errado.
  const proximoPlaceholder = () => `$${parametros.length + 1}`;

  if (nomePadraoLike !== null) {
    clausulas.push(filtroNome(proximoPlaceholder()));
    parametros.push(nomePadraoLike);
  }
  if (legacyId !== null) {
    // Comparacao de TEXTO: '007' e '7' sao identidades diferentes.
    clausulas.push(`legacy_id = ${proximoPlaceholder()}`);
    parametros.push(legacyId);
  }

  const where = clausulas.length === 0 ? '' : `WHERE ${clausulas.join(' AND ')} `;
  const sql = `SELECT ${COLUNAS_ASSOCIADO} FROM associado ${where}${ORDENACAO} LIMIT ${proximoPlaceholder()}`;
  parametros.push(limite);

  const { rows } = await pool.query(sql, parametros);
  return rows;
}

/**
 * Busca uma linha pelo id interno.
 *
 * Id fora da faixa do `int4` devolve `undefined` em vez de deixar o banco
 * levantar erro de conversao: uma linha que nao pode existir e indistinguivel de
 * uma linha que nao existe.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} pool
 * @param {number} id inteiro positivo, ja validado pelo caso de uso.
 * @returns {Promise<object | undefined>}
 */
async function buscarAssociadoPorId(pool, id) {
  if (id > ID_MAXIMO_INT4) return undefined;

  const { rows } = await pool.query(SQL_POR_ID, [id]);
  return rows[0];
}

/**
 * Busca uma linha pelo identificador da planilha, por igualdade exata de texto.
 * Nao ha CAST, parseInt nem remocao de zeros a esquerda em nenhum ponto.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} pool
 * @param {string} legacyId ja normalizado pelo caso de uso.
 * @returns {Promise<object | undefined>}
 */
async function buscarAssociadoPorLegacyId(pool, legacyId) {
  const { rows } = await pool.query(SQL_POR_LEGACY_ID, [legacyId]);
  return rows[0];
}

module.exports = {
  COLUNAS_ASSOCIADO,
  ORDENACAO,
  ID_MAXIMO_INT4,
  buscarAssociados,
  buscarAssociadoPorId,
  buscarAssociadoPorLegacyId,
};
