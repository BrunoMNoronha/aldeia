'use strict';

// Leitura cadastral de associados sobre PostgreSQL (F-01 / F-02) — ADR-003, PG-2A.
//
// ---------------------------------------------------------------------------
// ESTA IMPLEMENTACAO NAO ESTA NO RUNTIME
// ---------------------------------------------------------------------------
// Nenhuma rota, pagina, view ou script consome este modulo. O runtime continua
// no SQLite (`associados.js`) ate PG-6, que e o ponto formal do cutover. Este
// arquivo existe para que a equivalencia seja PROVADA por teste antes do
// cutover, e nao descoberta depois dele.
//
// Nao ha dual-write nem sincronizacao: e somente leitura e so enxerga o que ja
// estiver no PostgreSQL.
//
// ---------------------------------------------------------------------------
// Camadas (T-08)
// ---------------------------------------------------------------------------
// Este modulo e CASO DE USO. Ele nao contem SQL, `$n`, `COLLATE`, tipos do
// driver nem chamada de `query`: tudo isso e persistencia e vive em
// `src/db/postgresql/associados.js`.
//
// Aqui ficam as decisoes que sobrevivem a troca de banco:
//   * normalizar filtro (trim, string vazia, tipo errado -> filtro ausente);
//   * validar id;
//   * escapar o termo de busca para que `%`, `_` e `\` digitados sejam LITERAIS;
//   * limite padrao, sonda de truncamento e o significado de `total`;
//   * mapear a linha para o contrato publico, sem derivar situacao financeira.
//
// A conexao chega pronta de fora e apenas ATRAVESSA este modulo rumo a camada
// de persistencia — do mesmo jeito que o `db` do SQLite atravessa
// `associados.js`. Nenhum metodo dela e chamado aqui.
//
// ---------------------------------------------------------------------------
// O que muda e o que NAO muda em relacao ao SQLite
// ---------------------------------------------------------------------------
// MUDA: a API e assincrona — `better-sqlite3` e sincrono e `pg` nao (ADR-003).
//
// NAO MUDA (ha teste para cada item, inclusive um teste DIFERENCIAL que roda as
// duas implementacoes lado a lado):
//   * `legacy_id` e TEXTO comparado por igualdade exata ('007' != '7');
//   * `%`, `_` e `\` digitados sao literais, nunca curingas;
//   * busca por nome parcial e insensivel a caixa em ASCII;
//   * ordenacao deterministica por nome (sem caixa) com desempate por id;
//   * `LIMITE_PADRAO`, sonda de `limite + 1`, `truncado` e `total` contando
//     apenas os itens desta resposta;
//   * `legacy_status_code` verbatim (C-01 segue TO CONFIRM) e nenhum campo de
//     situacao financeira derivado (M-06).

const {
  LIMITE_PADRAO,
  normalizarTexto,
  idInteiroPositivo,
  limiteValido,
  padraoContem,
  mapearAssociado,
  montarListagem,
} = require('./associados-contrato');

const repositorio = require('../db/postgresql/associados');

/**
 * Lista associados com filtros opcionais.
 *
 * Os dois filtros combinam com AND: pedir nome E legacy_id significa "este
 * associado", nunca "qualquer um dos dois".
 *
 * @param {object} conexao conexao PostgreSQL gerenciada pela camada de
 *   persistencia. Atravessa este modulo sem ser usada diretamente.
 * @param {object} [filtros]
 * @param {string|null} [filtros.nome] busca parcial, case-insensitive (ASCII).
 * @param {string|null} [filtros.legacyId] igualdade EXATA como texto.
 * @param {number} [filtros.limite]
 * @returns {Promise<{itens: object[], total: number, truncado: boolean,
 *            filtros: {nome: string|null, legacyId: string|null}}>}
 *          `total` e a quantidade de itens DESTA resposta. Quando `truncado` e
 *          true existem mais registros que nao foram contados — a UI precisa
 *          dizer isso em vez de apresentar um recorte como se fosse o universo.
 */
async function listarAssociados(conexao, { nome = null, legacyId = null, limite = LIMITE_PADRAO } = {}) {
  const nomeFiltro = normalizarTexto(nome);
  const legacyIdFiltro = normalizarTexto(legacyId);
  const teto = limiteValido(limite);

  // Uma linha a mais que o teto: e assim que se sabe que houve corte sem contar
  // o universo inteiro. A sonda e decisao de apresentacao, por isso ela e o `+1`
  // ficam aqui e nao no repositorio.
  const linhas = await repositorio.buscarAssociados(conexao, {
    nomePadraoLike: nomeFiltro === null ? null : padraoContem(nomeFiltro),
    legacyId: legacyIdFiltro,
    limite: teto + 1,
  });

  return montarListagem(linhas, teto, { nome: nomeFiltro, legacyId: legacyIdFiltro });
}

/**
 * Detalhe cadastral por id interno.
 *
 * Id invalido e id inexistente sao a MESMA resposta: `null`. Nao existir nao e
 * excecao de dominio — e o caso normal de uma URL digitada a mao.
 *
 * @param {object} conexao
 * @param {unknown} id
 * @returns {Promise<object | null>}
 */
async function obterAssociado(conexao, id) {
  const idValido = idInteiroPositivo(id);
  if (idValido === null) return null;

  return mapearAssociado(await repositorio.buscarAssociadoPorId(conexao, idValido));
}

/**
 * Detalhe cadastral pelo identificador da planilha, por igualdade exata de
 * texto. Nao ha parseInt, CAST nem remocao de zeros a esquerda.
 *
 * @param {object} conexao
 * @param {unknown} legacyId
 * @returns {Promise<object | null>}
 */
async function obterAssociadoPorLegacyId(conexao, legacyId) {
  const legacyIdFiltro = normalizarTexto(legacyId);
  if (legacyIdFiltro === null) return null;

  return mapearAssociado(await repositorio.buscarAssociadoPorLegacyId(conexao, legacyIdFiltro));
}

module.exports = {
  LIMITE_PADRAO,
  listarAssociados,
  obterAssociado,
  obterAssociadoPorLegacyId,
};
