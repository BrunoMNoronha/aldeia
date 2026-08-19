'use strict';

// Estado de comprovante por movimento financeiro (Fase 4A).
//
// Requisitos do baseline atendidos aqui:
//   M-04 : comprovante e um ESTADO/EVIDENCIA independente do pagamento, com os
//          quatro estados previstos e observacao opcional.
//   M-07 : proveniencia do legado nao e tocada por este servico.
//   M-09 : nenhum registro financeiro e apagado, editado ou reativado aqui.
//   F-05 : controlar existencia/ausencia de comprovante e listar os movimentos
//          pendentes de evidencia.
//   F-10 : visao de pendencia de comprovante (SOMENTE ela — ver abaixo).
//   F-11 : toda mudanca de estado deixa trilha em `audit_log`.
//   T-07 : leitura, gravacao e auditoria acontecem na MESMA transacao.
//
// Duas regras estruturam tudo o que segue:
//
//   1. A SITUACAO OFICIAL DO COMPROVANTE E O CAMPO `estado`, NUNCA O TEXTO.
//      `observacao` existe para contexto humano ("Comprovante solicitado ao
//      associado.") e e preservada verbatim, mas nada neste modulo le, procura
//      palavra-chave ou deduz estado a partir dela.
//
//   2. AUSENCIA DE REGISTRO NAO E 'ausente'.
//      "Ninguem ainda disse nada sobre o comprovante deste movimento" e
//      "alguem verificou e declarou que o comprovante NAO existe" sao fatos
//      diferentes. O primeiro e o estado TECNICO `sem_registro` (nao existe
//      linha em `comprovante`); o segundo e o estado de dominio 'ausente'.
//      Somente o segundo entra na fila de pendencia.
//
// O que este servico NAO faz — e nao deve passar a fazer sem decisao humana:
//   * armazenar arquivo, blob, upload, PDF, imagem, link obrigatorio para
//     provedor externo ou qualquer integracao (C-06 segue TO CONFIRM);
//     `comprovante.referencia_externa` e `comprovante.data` permanecem
//     RESERVADAS e intocadas nesta fase;
//   * alterar valor, data, tipo, origem, associado, alocacoes, identificacao ou
//     `ativo` de qualquer movimento — comprovante e evidencia, nao dinheiro;
//   * reativar movimento inativado, nem impedir que um movimento inativado
//     receba/mantenha evidencia;
//   * misturar na fila de comprovante outras pendencias (deposito nao
//     identificado, insuficiencia de pagamento, ambiguidade do legado). Elas
//     tem origem propria e uma eventual visao consolidada de F-10 e outra fase;
//   * autenticar: o ator gravado e uma representacao tecnica, nunca um usuario
//     inventado (C-07 segue TO CONFIRM).

const { withTransaction } = require('../db/connection');

// O contrato independente de banco (vocabulario, validacao, forma da evidencia,
// mapeamento publico) vive em `comprovantes-contrato.js` e e COMPARTILHADO com a
// implementacao PostgreSQL (`comprovantes-postgresql.js`, ADR-003 / PG-2B1).
// Aqui fica apenas o que e especifico do SQLite: o SQL e a chamada sincrona do
// `better-sqlite3`.
//
// Este arquivo e TRANSITORIO: o SQLite continua sendo o runtime ate PG-6 e sai
// em PG-7; nesse momento este modulo desaparece e o contrato permanece.
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
  mapearComprovante,
  evidenciaRegistrada,
  evidenciaSemRegistro,
  evidenciaDaLinha,
  mapearItemDaFila,
} = require('./comprovantes-contrato');

const COLUNAS_COMPROVANTE = `
         id, movimento_id, estado, observacao, referencia_externa, data,
         criado_em, atualizado_em`;

const SQL_COMPROVANTE_POR_ID = `
  SELECT ${COLUNAS_COMPROVANTE}
    FROM comprovante
   WHERE id = ?
`;

const SQL_COMPROVANTE_POR_MOVIMENTO = `
  SELECT ${COLUNAS_COMPROVANTE}
    FROM comprovante
   WHERE movimento_id = ?
`;

/**
 * `referencia_externa` e `data` ficam FORA do INSERT de proposito: nenhuma das
 * duas e preenchida pela Fase 4A. Elas nascem NULL, e NULL aqui significa
 * exatamente "nao informado", nunca "nao existe arquivo".
 */
const SQL_INSERT_COMPROVANTE = `
  INSERT INTO comprovante (movimento_id, estado, observacao)
  VALUES (?, ?, ?)
`;

/**
 * A alteracao toca SOMENTE `estado`, `observacao` e `atualizado_em`.
 * `movimento_id`, `referencia_externa`, `data` e `criado_em` permanecem como
 * estavam: mudar a evidencia de um movimento nunca a transfere para outro.
 */
const SQL_ATUALIZAR_COMPROVANTE = `
  UPDATE comprovante
     SET estado = ?,
         observacao = ?,
         atualizado_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
   WHERE id = ?
`;

const SQL_MOVIMENTO_POR_ID = `
  SELECT id, data, valor_centavos, associado_id, estado_identificacao, ativo
    FROM movimento_financeiro
   WHERE id = ?
`;

const SQL_INSERT_AUDIT = `
  INSERT INTO audit_log
    (ator, acao, entidade_tipo, entidade_id, estado_anterior, estado_posterior, metadados)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Fila de pendencia de EVIDENCIA (F-05 / F-10).
 *
 * O JOIN com `movimento_financeiro` e obrigatorio, e nao um detalhe de
 * conveniencia: esta fila responde "quais MOVIMENTOS precisam de acompanhamento
 * de comprovante". Comprovante independente (sem movimento, M-04) existe e
 * continua valido, mas nao e um movimento e por isso nao aparece aqui.
 *
 * O filtro e apenas `c.estado IN (...)`: sao os estados EXPLICITAMENTE
 * declarados. Movimento sem linha em `comprovante` nao entra — ausencia de
 * registro nao e pendencia declarada, e transforma-la em uma seria inventar
 * regra de negocio.
 *
 * `m.ativo` NAO e filtrado: esconder um movimento inativado seria decidir, sem
 * requisito, que evidencia deixa de importar depois da correcao. O estado real
 * vai no retorno (`movimento.ativo`) e quem exibe decide o que fazer com ele.
 */
function sqlFiltroPendencias(placeholders) {
  return `
    FROM comprovante c
    JOIN movimento_financeiro m ON m.id = c.movimento_id
   WHERE c.estado IN (${placeholders})`;
}

/** `total` e contado ANTES de LIMIT/OFFSET: pagina e recorte, nao universo. */
function sqlContarPendencias(placeholders) {
  return `SELECT COUNT(*) AS total${sqlFiltroPendencias(placeholders)}`;
}

/** Ordenacao deterministica: backlog cronologico, desempate estavel pelo id. */
function sqlListarPendencias(placeholders) {
  return `
  SELECT c.id AS comprovante_id, c.movimento_id, c.estado, c.observacao,
         c.criado_em, c.atualizado_em,
         m.data AS movimento_data, m.valor_centavos AS movimento_valor_centavos,
         m.associado_id AS movimento_associado_id,
         m.estado_identificacao AS movimento_estado_identificacao,
         m.ativo AS movimento_ativo${sqlFiltroPendencias(placeholders)}
   ORDER BY m.data ASC, m.id ASC
   LIMIT ? OFFSET ?
`;
}

// --- auditoria (F-11) -------------------------------------------------------

/**
 * Mesma infraestrutura de auditoria do resto do sistema: a MESMA tabela
 * `audit_log`, as mesmas colunas, o mesmo ator tecnico padrao e o mesmo formato
 * JSON de estado anterior/posterior. Nao existe segundo mecanismo de trilha.
 */
function registrarAuditoria(
  db,
  { ator, acao, entidadeTipo, entidadeId, estadoAnterior = null, estadoPosterior = null, metadados = null }
) {
  db.prepare(SQL_INSERT_AUDIT).run(
    ator,
    acao,
    entidadeTipo,
    String(entidadeId),
    estadoAnterior === null ? null : JSON.stringify(estadoAnterior),
    estadoPosterior === null ? null : JSON.stringify(estadoPosterior),
    metadados === null ? null : JSON.stringify(metadados)
  );
}

// --- leitura ----------------------------------------------------------------

function exigirMovimento(db, movimentoId) {
  const row = db.prepare(SQL_MOVIMENTO_POR_ID).get(movimentoId);
  if (row === undefined) {
    throw new ComprovanteError(`movimento ${movimentoId} nao existe`, 'movimento_inexistente');
  }
  return row;
}

/**
 * Estado do comprovante de UM movimento (F-05).
 *
 * Leitura pura: nao grava, nao cria registro "sob demanda" e nao gera
 * `audit_log`. Movimento inexistente e erro (`movimento_inexistente`), nao um
 * "sem registro": nao existe evidencia de algo que nao existe.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} movimentoId
 * @returns {object} evidencia do movimento (ver `evidenciaRegistrada` /
 *          `evidenciaSemRegistro`).
 * @throws {ComprovanteError} `id_invalido`, `movimento_inexistente`.
 */
function obterComprovanteDoMovimento(db, movimentoId) {
  const id = exigirId(movimentoId, 'movimentoId');
  exigirMovimento(db, id);
  return evidenciaDaLinha(id, db.prepare(SQL_COMPROVANTE_POR_MOVIMENTO).get(id));
}

/**
 * Evidencia de VARIOS movimentos em uma consulta — usada pela tela de detalhe,
 * para nao fazer uma ida ao banco por movimento.
 *
 * O mapa tem uma entrada para CADA id pedido, inclusive os que nao possuem
 * linha em `comprovante`: quem exibe recebe `sem_registro` explicitamente, em
 * vez de uma chave faltando que poderia ser lida como 'ausente'.
 *
 * Os ids nao passam por `exigirId` porque vem do proprio banco (sao ids de
 * movimentos ja lidos); ainda assim nenhum valor e concatenado na SQL — os `?`
 * sao gerados a partir da QUANTIDADE de ids.
 *
 * @returns {Map<number, object>} movimentoId -> evidencia
 */
function obterComprovantesDeMovimentos(db, movimentoIds) {
  const mapa = new Map(movimentoIds.map((id) => [id, evidenciaSemRegistro(id)]));
  if (movimentoIds.length === 0) return mapa;

  const placeholders = movimentoIds.map(() => '?').join(', ');
  const linhas = db
    .prepare(
      `SELECT ${COLUNAS_COMPROVANTE}
         FROM comprovante
        WHERE movimento_id IN (${placeholders})`
    )
    .all(...movimentoIds);

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
 * Esta fila e SO de comprovante. Deposito nao identificado, insuficiencia de
 * pagamento e ambiguidade do legado tem cada um sua origem e NAO sao misturados
 * aqui — uma visao consolidada de F-10 e outra fase.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opcoes]
 * @param {string} [opcoes.estado] 'pendente' | 'ausente' (ausente = os dois)
 * @param {number} [opcoes.limite] 1..200 (padrao 50)
 * @param {number} [opcoes.offset] >= 0 (padrao 0)
 * @returns {{itens: object[], paginacao: {limite: number, offset: number, total: number},
 *           estados: string[]}}
 */
function listarPendenciasDeComprovante(db, opcoes = {}) {
  const estados = exigirEstadoPendente(opcoes.estado);
  const { limite, offset } = exigirPaginacao(opcoes);

  const placeholders = estados.map(() => '?').join(', ');
  const { total } = db.prepare(sqlContarPendencias(placeholders)).get(...estados);
  const itens = db
    .prepare(sqlListarPendencias(placeholders))
    .all(...estados, limite, offset)
    .map(mapearItemDaFila);

  return { itens, paginacao: { limite, offset, total }, estados };
}

// --- escrita (sempre dentro de transacao) -----------------------------------

/**
 * Registra ou altera o estado do comprovante de um movimento (M-04 / F-05 / F-11).
 *
 * E a UNICA operacao de escrita desta fase, e ela e estreita de proposito: grava
 * `estado` e `observacao` na linha de `comprovante` daquele movimento, e mais
 * nada. Todas as transicoes entre os quatro estados sao permitidas
 * ('pendente' -> 'presente', 'ausente' -> 'presente', 'pendente' ->
 * 'nao_aplicavel', ...): nao ha maquina de estados aprovada no baseline, e
 * inventar uma seria criar regra de negocio.
 *
 * NADA de financeiro e tocado: valor, data, tipo, origem, associado,
 * identificacao, `ativo` e as alocacoes do movimento permanecem exatamente como
 * estavam. Movimento INATIVADO tambem aceita evidencia e NAO e reativado por
 * isso — a evidencia continua valendo para o historico (M-09).
 *
 * Unicidade: um movimento tem no maximo um comprovante (indice
 * `ux_comprovante_movimento`, migration 003). A alteracao acontece na propria
 * linha e o historico completo — estado anterior, estado novo, observacao,
 * ator e timestamp — fica em `audit_log`.
 *
 * IDEMPOTENCIA: reenviar exatamente o mesmo `estado` E a mesma `observacao` e
 * reconhecido como operacao SEM MUDANCA — nao ha UPDATE, `atualizado_em` nao se
 * move e nenhuma segunda linha de auditoria e criada. Isso preserva o
 * significado da trilha: cada registro em `audit_log` corresponde a uma mudanca
 * real. Mudou o estado OU a observacao, e alteracao, e e auditada.
 *
 * T-07: leitura, INSERT/UPDATE e `audit_log` na MESMA transacao. Se a auditoria
 * falhar, o ROLLBACK nao deixa comprovante para tras — nao existe mudanca de
 * evidencia sem trilha.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} entrada
 * @param {number} entrada.movimentoId
 * @param {string} entrada.estado             'presente'|'ausente'|'pendente'|'nao_aplicavel'
 * @param {string|null} [entrada.observacao]  contexto humano, OPCIONAL; nunca e
 *        lida para deduzir estado. Vazio/espacos viram `null`.
 * @param {string} [entrada.ator]             ator tecnico gravado na auditoria
 * @returns {object} a evidencia resultante, com `alteracao` ('registrado' |
 *          'alterado' | 'sem_mudanca').
 * @throws {ComprovanteError} `id_invalido`, `estado_comprovante_invalido`,
 *         `campo_invalido`, `movimento_inexistente`.
 */
function definirComprovanteDoMovimento(db, entrada = {}) {
  const movimentoId = exigirId(entrada.movimentoId, 'movimentoId');
  const estado = exigirEstado(entrada.estado);
  const observacao = textoOpcional(entrada.observacao, 'observacao');
  const ator = exigirAtor(entrada.ator);

  return withTransaction(db, (conexao) => {
    // O movimento precisa existir: evidencia so existe sobre algo que existe.
    // A linha e lida mas NAO e escrita em nenhum caminho desta funcao.
    exigirMovimento(conexao, movimentoId);

    const anteriorRow = conexao.prepare(SQL_COMPROVANTE_POR_MOVIMENTO).get(movimentoId);

    if (anteriorRow === undefined) {
      const info = conexao.prepare(SQL_INSERT_COMPROVANTE).run(movimentoId, estado, observacao);
      // Relido do banco: `criado_em`/`atualizado_em` vem dos defaults do schema,
      // entao o objeto devolvido e auditado e o que EXISTE, nao o que foi enviado.
      const registro = mapearComprovante(
        conexao.prepare(SQL_COMPROVANTE_POR_ID).get(Number(info.lastInsertRowid))
      );

      registrarAuditoria(conexao, {
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

    const info = conexao.prepare(SQL_ATUALIZAR_COMPROVANTE).run(estado, observacao, anteriorRow.id);
    if (info.changes !== 1) {
      // Defensivo: a linha foi lida sob o mesmo lock de escrita desta transacao.
      throw new ComprovanteError(
        `comprovante do movimento ${movimentoId} nao foi atualizado`,
        'comprovante_nao_atualizado'
      );
    }

    const estadoPosterior = mapearComprovante(
      conexao.prepare(SQL_COMPROVANTE_POR_ID).get(anteriorRow.id)
    );

    registrarAuditoria(conexao, {
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
