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
// LEITURA (PG-2B1) + ESCRITA (PG-2B2)
// ---------------------------------------------------------------------------
// `definirComprovanteDoMovimento` esta convertida: INSERT/UPDATE e `audit_log`
// na MESMA transacao (T-07 / F-11), com idempotencia e rollback provados por
// teste. As leituras continuam puras — nenhuma delas abre transacao ou grava.
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
  ALTERACAO,
  ORIGEM_REGISTRO,
  ACAO_COMPROVANTE_REGISTRADO,
  ACAO_COMPROVANTE_ALTERADO,
  CRITERIO_ESTADO_EXPLICITO,
  ComprovanteError,
  exigirId,
  textoOpcional,
  exigirAtor,
  exigirEstado,
  exigirEstadoPendente,
  exigirPaginacao,
  evidenciaSemRegistro,
  evidenciaRegistrada,
  evidenciaDaLinha,
  mapearComprovante,
  mapearItemDaFila,
} = require('./comprovantes-contrato');

const { withTransaction } = require('../db/postgresql/connection');
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

// --- escrita (sempre dentro de transacao) -----------------------------------

/**
 * Registra ou altera o estado do comprovante de um movimento
 * (M-04 / F-05 / F-11 / T-07) — trilha PostgreSQL da PG-2B2.
 *
 * Mesmo contrato publico da trilha SQLite, incluindo os codigos de erro e os
 * tres resultados possiveis em `alteracao` ('registrado' | 'alterado' |
 * 'sem_mudanca'). Todas as transicoes entre os quatro estados sao permitidas:
 * nao ha maquina de estados aprovada no baseline, e inventar uma seria criar
 * regra de negocio. Movimento INATIVADO tambem aceita evidencia e NAO e
 * reativado por isso (M-09).
 *
 * NADA de financeiro e tocado: valor, data, tipo, origem, associado,
 * identificacao, `ativo` e alocacoes permanecem exatamente como estavam. A
 * linha do movimento e lida (e travada), nunca escrita.
 *
 * FRONTEIRA DA TRANSACAO (T-07). A transacao e aberta AQUI, no caso de uso, e
 * todas as consultas usam o `client` que ela entrega — nenhuma volta ao `pool`,
 * porque isso pegaria outra conexao, ficaria fora da transacao e sobreviveria ao
 * ROLLBACK. Dentro dela, nesta ordem:
 *
 *   SELECT movimento ... FOR UPDATE   <- serializa writers do MESMO movimento
 *   SELECT comprovante do movimento
 *   INSERT ou UPDATE (quando ha mudanca real)
 *   INSERT audit_log
 *   COMMIT
 *
 * O lock da linha do movimento e o que impede que duas chamadas concorrentes
 * leiam "nao ha comprovante" ao mesmo tempo e disputem o indice unico. O segundo
 * writer espera, enxerga a linha ja criada e responde `sem_mudanca` — nenhuma
 * violacao de unicidade vira comportamento normal. Escritas em movimentos
 * DIFERENTES nao se bloqueiam: o lock e por linha, nao global.
 *
 * IDEMPOTENCIA: reenviar o mesmo `estado` E a mesma `observacao` (ja
 * normalizados) e reconhecido como operacao SEM MUDANCA — nao ha UPDATE,
 * `atualizado_em` nao se move e nenhuma segunda linha de auditoria e criada.
 * Cada entrada de `audit_log` corresponde a uma mudanca real.
 *
 * @param {import('pg').Pool} pool pool PostgreSQL; a transacao e aberta aqui.
 * @param {object} entrada
 * @param {number} entrada.movimentoId
 * @param {string} entrada.estado             'presente'|'ausente'|'pendente'|'nao_aplicavel'
 * @param {string|null} [entrada.observacao]  contexto humano, OPCIONAL; nunca e
 *        lida para deduzir estado. Vazio/espacos viram `null`.
 * @param {string} [entrada.ator]             ator tecnico gravado na auditoria
 * @returns {Promise<object>} a evidencia resultante, com `alteracao`.
 * @throws {ComprovanteError} `id_invalido`, `estado_comprovante_invalido`,
 *         `campo_invalido`, `movimento_inexistente`, `comprovante_nao_atualizado`.
 */
async function definirComprovanteDoMovimento(pool, entrada = {}) {
  // Validacao ANTES da transacao, na mesma ordem da trilha SQLite: entrada
  // invalida nao abre transacao, nao trava linha e nao escreve nada.
  const movimentoId = exigirId(entrada.movimentoId, 'movimentoId');
  const estado = exigirEstado(entrada.estado);
  const observacao = textoOpcional(entrada.observacao, 'observacao');
  const ator = exigirAtor(entrada.ator);

  return withTransaction(pool, async (client) => {
    // O movimento precisa existir: evidencia so existe sobre algo que existe.
    // `FOR UPDATE` trava esta linha ate o fim da transacao.
    const movimento = await repositorio.buscarMovimentoPorIdParaAtualizacao(client, movimentoId);
    if (movimento === undefined) {
      throw new ComprovanteError(`movimento ${movimentoId} nao existe`, 'movimento_inexistente');
    }

    const anteriorRow = await repositorio.buscarComprovantePorMovimento(client, movimentoId);

    if (anteriorRow === undefined) {
      const registro = mapearComprovante(
        await repositorio.inserirComprovante(client, { movimentoId, estado, observacao })
      );

      await repositorio.registrarAuditoria(client, {
        ator,
        acao: ACAO_COMPROVANTE_REGISTRADO,
        entidadeTipo: 'comprovante',
        entidadeId: registro.id,
        // Nao havia linha antes: o estado anterior e a AUSENCIA DE REGISTRO,
        // declarada nos metadados como `sem_registro` — nunca como 'ausente'.
        estadoAnterior: null,
        estadoPosterior: registro,
        metadados: {
          origemRegistro: ORIGEM_REGISTRO,
          movimentoId,
          estadoAnterior: SEM_REGISTRO,
          estadoNovo: estado,
          observacao,
        },
      });

      return { ...evidenciaRegistrada(movimentoId, registro), alteracao: ALTERACAO.registrado };
    }

    if (anteriorRow.estado === estado && anteriorRow.observacao === observacao) {
      return {
        ...evidenciaRegistrada(movimentoId, mapearComprovante(anteriorRow)),
        alteracao: ALTERACAO.semMudanca,
      };
    }

    const estadoAnterior = mapearComprovante(anteriorRow);

    const atualizadaRow = await repositorio.atualizarComprovante(client, {
      id: anteriorRow.id,
      estado,
      observacao,
    });
    if (atualizadaRow === undefined) {
      // Defensivo: a linha foi lida sob o lock do movimento nesta transacao.
      throw new ComprovanteError(
        `comprovante do movimento ${movimentoId} nao foi atualizado`,
        'comprovante_nao_atualizado'
      );
    }
    const estadoPosterior = mapearComprovante(atualizadaRow);

    await repositorio.registrarAuditoria(client, {
      ator,
      acao: ACAO_COMPROVANTE_ALTERADO,
      entidadeTipo: 'comprovante',
      entidadeId: anteriorRow.id,
      estadoAnterior,
      estadoPosterior,
      metadados: {
        origemRegistro: ORIGEM_REGISTRO,
        movimentoId,
        estadoAnterior: estadoAnterior.estado,
        estadoNovo: estado,
        observacao,
        // Prova, na propria trilha, que a observacao nao decidiu nada.
        criterio: CRITERIO_ESTADO_EXPLICITO,
      },
    });

    return { ...evidenciaRegistrada(movimentoId, estadoPosterior), alteracao: ALTERACAO.alterado };
  });
}

module.exports = {
  obterComprovanteDoMovimento,
  obterComprovantesDeMovimentos,
  definirComprovanteDoMovimento,
  listarPendenciasDeComprovante,
  ComprovanteError,
  ESTADOS,
  ESTADOS_PENDENTES,
  SEM_REGISTRO,
  ALTERACAO,
  ACAO_COMPROVANTE_REGISTRADO,
  ACAO_COMPROVANTE_ALTERADO,
};
