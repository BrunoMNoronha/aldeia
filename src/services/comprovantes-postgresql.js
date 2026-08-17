'use strict';

// Leitura de comprovante sobre PostgreSQL (M-04 / F-05 / F-10) — ADR-003, PG-2B1.
//
// ---------------------------------------------------------------------------
// ESTA IMPLEMENTACAO NAO ESTA NO RUNTIME
// ---------------------------------------------------------------------------
// Nenhuma rota, pagina, view ou script consome este modulo. O runtime continua
// no SQLite (`comprovantes.js`) ate PG-6. Este arquivo existe para que a
// equivalencia seja PROVADA por teste antes do cutover, e nao descoberta depois.
//
// Sem dual-write e sem sincronizacao: so enxerga o que ja estiver no PostgreSQL.
//
// ---------------------------------------------------------------------------
// SOMENTE LEITURA — a escrita e a PG-2B2
// ---------------------------------------------------------------------------
// `definirComprovanteDoMovimento` NAO foi convertida. Ela envolve INSERT/UPDATE,
// `audit_log`, idempotencia e rollback atomico (T-07 / F-11), e converter isso
// junto com as leituras misturaria riscos muito diferentes na mesma revisao.
// Nada aqui abre transacao, grava ou audita.
//
// ---------------------------------------------------------------------------
// Camadas (T-08)
// ---------------------------------------------------------------------------
// Este modulo e CASO DE USO. Nao contem SQL, `$n`, JOIN, tipos do driver nem
// chamada de `query`: isso e persistencia e vive em
// `src/db/postgresql/comprovantes.js`.
//
// Aqui ficam as decisoes que sobrevivem a troca de banco: validacao e codigos de
// erro, o significado de ausencia de linha, quais estados sao pendentes,
// paginacao e o mapeamento publico. O contrato comum esta em
// `comprovantes-contrato.js`, compartilhado com a trilha SQLite — as duas usam
// as MESMAS regras, entao a unica coisa que este arquivo pode fazer divergir e
// como o SQL foi escrito.
//
// A conexao chega pronta de fora e apenas ATRAVESSA este modulo rumo a
// persistencia, do mesmo jeito que o `db` do SQLite atravessa `comprovantes.js`.

const {
  ESTADOS,
  ESTADOS_PENDENTES,
  SEM_REGISTRO,
  ComprovanteError,
  exigirId,
  exigirEstadoPendente,
  exigirPaginacao,
  evidenciaSemRegistro,
  evidenciaRegistrada,
  evidenciaDaLinha,
  mapearComprovante,
  mapearItemDaFila,
} = require('./comprovantes-contrato');

const repositorio = require('../db/postgresql/comprovantes');

/**
 * Movimento inexistente e ERRO, nao `sem_registro`: nao existe evidencia sobre
 * algo que nao existe.
 */
async function exigirMovimento(conexao, movimentoId) {
  const row = await repositorio.buscarMovimentoPorId(conexao, movimentoId);
  if (row === undefined) {
    throw new ComprovanteError(`movimento ${movimentoId} nao existe`, 'movimento_inexistente');
  }
  return row;
}

/**
 * Estado do comprovante de UM movimento (F-05).
 *
 * Leitura pura: nao grava, nao cria registro "sob demanda" e nao gera
 * `audit_log`.
 *
 * @param {object} conexao conexao PostgreSQL gerenciada pela persistencia.
 * @param {number} movimentoId
 * @returns {Promise<object>} evidencia do movimento.
 * @throws {ComprovanteError} `id_invalido`, `movimento_inexistente`.
 */
async function obterComprovanteDoMovimento(conexao, movimentoId) {
  const id = exigirId(movimentoId, 'movimentoId');
  await exigirMovimento(conexao, id);

  return evidenciaDaLinha(id, await repositorio.buscarComprovantePorMovimento(conexao, id));
}

/**
 * Evidencia de VARIOS movimentos em uma consulta — usada pela tela de detalhe,
 * para nao fazer uma ida ao banco por movimento.
 *
 * O mapa tem uma entrada para CADA id pedido, inclusive os que nao possuem linha
 * em `comprovante`: quem exibe recebe `sem_registro` explicitamente, em vez de
 * uma chave faltando que poderia ser lida como 'ausente'.
 *
 * Os ids nao passam por `exigirId` porque vem do proprio banco (sao ids de
 * movimentos ja lidos) — mesma decisao da trilha SQLite. Ainda assim nenhum
 * valor e concatenado na SQL: os `$n` sao gerados pela QUANTIDADE de ids.
 *
 * @param {object} conexao
 * @param {number[]} movimentoIds
 * @returns {Promise<Map<number, object>>} movimentoId -> evidencia
 */
async function obterComprovantesDeMovimentos(conexao, movimentoIds) {
  const mapa = new Map(movimentoIds.map((id) => [id, evidenciaSemRegistro(id)]));
  if (movimentoIds.length === 0) return mapa;

  const linhas = await repositorio.buscarComprovantesDeMovimentos(conexao, movimentoIds);

  for (const row of linhas) {
    mapa.set(row.movimento_id, evidenciaRegistrada(row.movimento_id, mapearComprovante(row)));
  }

  return mapa;
}

/**
 * Fila paginada de movimentos com pendencia DECLARADA de comprovante
 * (F-05 / F-10).
 *
 * Consulta pura: nao grava, nao corrige estado e nao produz `audit_log`.
 *
 * Entra na fila quem tem registro de comprovante em 'pendente' ou 'ausente'.
 * NAO entram, por decisao explicita: 'presente' e 'nao_aplicavel' (resolvidos),
 * movimento sem registro de comprovante (nada foi declarado) e comprovante sem
 * movimento (M-04, nao e um movimento).
 *
 * Movimento INATIVADO continua elegivel: evidencia nao deixa de importar depois
 * da correcao (M-09). O estado real vai em `movimento.ativo`.
 *
 * `total` e o universo filtrado ANTES de LIMIT/OFFSET — nunca `itens.length`.
 *
 * @param {object} conexao
 * @param {object} [opcoes]
 * @param {string} [opcoes.estado] 'pendente' | 'ausente' (ausente = os dois)
 * @param {number} [opcoes.limite] 1..200 (padrao 50)
 * @param {number} [opcoes.offset] >= 0 (padrao 0)
 * @returns {Promise<{itens: object[], paginacao: {limite: number, offset: number,
 *           total: number}, estados: string[]}>}
 */
async function listarPendenciasDeComprovante(conexao, opcoes = {}) {
  const estados = exigirEstadoPendente(opcoes.estado);
  const { limite, offset } = exigirPaginacao(opcoes);

  const total = await repositorio.contarPendencias(conexao, estados);
  const linhas = await repositorio.buscarPendencias(conexao, estados, { limite, offset });

  return { itens: linhas.map(mapearItemDaFila), paginacao: { limite, offset, total }, estados };
}

module.exports = {
  obterComprovanteDoMovimento,
  obterComprovantesDeMovimentos,
  listarPendenciasDeComprovante,
  ComprovanteError,
  ESTADOS,
  ESTADOS_PENDENTES,
  SEM_REGISTRO,
};
