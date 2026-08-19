'use strict';

/**
 * Persistencia PostgreSQL de comprovante — LEITURA (ADR-003, PG-2B1).
 *
 * T-08 separa dominio, PERSISTENCIA, importacao e transporte web. Este modulo e
 * a camada de persistencia: aqui, e somente aqui, moram o SQL PostgreSQL, os
 * placeholders `$n`, o JOIN, o `IN (...)`, o `COUNT(*)` e a chamada ao driver.
 * Quem consome recebe LINHAS do banco e nada mais.
 *
 * O que este modulo deliberadamente NAO faz:
 *   * validar entrada ou decidir codigo de erro;
 *   * conhecer `sem_registro` — ausencia de linha e ausencia de linha, e o
 *     significado disso e decisao de caso de uso;
 *   * decidir quais estados sao "pendentes";
 *   * aplicar limite padrao;
 *   * mapear linha para o contrato publico.
 *
 * Tudo isso vive em `src/services/`. A direcao da dependencia e SEMPRE
 * service -> db; este arquivo nao conhece `src/services/`.
 *
 * ---------------------------------------------------------------------------
 * LEITURA (PG-2B1) + ESCRITA (PG-2B2)
 * ---------------------------------------------------------------------------
 * As primitivas de escrita sao INSERT e UPDATE de UMA linha, mais o INSERT em
 * `audit_log`. Nao existe DELETE em lugar nenhum: correcao de entidade
 * financeira e inativacao com motivo, nunca remocao (M-09).
 *
 * Este modulo NAO abre transacao: `BEGIN`/`COMMIT`/`ROLLBACK` sao decisao do
 * caso de uso, que os obtem de `withTransaction`. Toda funcao de escrita recebe
 * o `client` da transacao em curso — passar o `pool` aqui pegaria OUTRA conexao
 * e a operacao ficaria fora da transacao, que e exatamente o que T-07 proibe.
 */

const { cabeNoInt4 } = require('./tipos');

/** Colunas de `comprovante`. Nomes vindos do schema PostgreSQL (migration 001). */
const COLUNAS_COMPROVANTE = `
         id, movimento_id, estado, observacao, referencia_externa, data,
         criado_em, atualizado_em`;

const SQL_COMPROVANTE_POR_MOVIMENTO = `
  SELECT ${COLUNAS_COMPROVANTE}
    FROM comprovante
   WHERE movimento_id = $1
`;

const SQL_MOVIMENTO_POR_ID = `
  SELECT id, data, valor_centavos, associado_id, estado_identificacao, ativo
    FROM movimento_financeiro
   WHERE id = $1
`;

/**
 * Mesma leitura, com LOCK DE LINHA (PG-2B2).
 *
 * `FOR UPDATE` e o que serializa dois writers do MESMO movimento. Sem ele, duas
 * transacoes concorrentes leem "nao ha comprovante" no mesmo instante, as duas
 * tentam INSERT e a segunda morre no indice unico `ux_comprovante_movimento` —
 * concorrencia normal viraria erro 23505 na cara do operador.
 *
 * O lock e na linha do MOVIMENTO, nao numa tabela inteira nem num lock global:
 * escritas em movimentos diferentes seguem em paralelo. A linha e apenas lida e
 * travada; NENHUM caminho desta fase escreve em `movimento_financeiro`.
 *
 * `NOWAIT` seria errado aqui: queremos que o segundo writer ESPERE e enxergue o
 * resultado do primeiro (virando `sem_mudanca`), nao que ele falhe.
 */
const SQL_MOVIMENTO_POR_ID_PARA_ATUALIZACAO = `${SQL_MOVIMENTO_POR_ID} FOR UPDATE`;

/**
 * `referencia_externa` e `data` ficam FORA do INSERT de proposito: nenhuma das
 * duas e preenchida por esta fase. Elas nascem NULL, e NULL aqui significa
 * exatamente "nao informado", nunca "nao existe arquivo" (C-06 TO CONFIRM).
 *
 * `RETURNING` devolve a linha COMO O BANCO A GRAVOU — com `criado_em` e
 * `atualizado_em` vindos do DEFAULT — em vez de devolver o que foi enviado.
 */
const SQL_INSERT_COMPROVANTE = `
  INSERT INTO comprovante (movimento_id, estado, observacao)
  VALUES ($1, $2, $3)
  RETURNING ${COLUNAS_COMPROVANTE}
`;

/**
 * A alteracao toca SOMENTE `estado`, `observacao` e `atualizado_em`.
 * `movimento_id`, `referencia_externa`, `data` e `criado_em` permanecem como
 * estavam: mudar a evidencia de um movimento nunca a transfere para outro, e
 * nunca apaga uma referencia que outra fase venha a preencher.
 */
const SQL_ATUALIZAR_COMPROVANTE = `
  UPDATE comprovante
     SET estado = $1,
         observacao = $2,
         atualizado_em = now()
   WHERE id = $3
  RETURNING ${COLUNAS_COMPROVANTE}
`;

/** Mesma tabela, mesmas colunas e mesma semantica da trilha SQLite (F-11). */
const SQL_INSERT_AUDIT = `
  INSERT INTO audit_log
    (ator, acao, entidade_tipo, entidade_id, estado_anterior, estado_posterior, metadados)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
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
 * declarados. Movimento sem linha em `comprovante` nao entra — o JOIN ja o
 * exclui, e transformar ausencia de registro em pendencia seria inventar regra.
 *
 * `m.ativo` NAO e filtrado: esconder um movimento inativado seria decidir, sem
 * requisito, que evidencia deixa de importar depois da correcao. O estado real
 * vai no retorno e quem exibe decide o que fazer com ele.
 */
function sqlFiltroPendencias(placeholders) {
  return `
    FROM comprovante c
    JOIN movimento_financeiro m ON m.id = c.movimento_id
   WHERE c.estado IN (${placeholders})`;
}

/**
 * Monta `$1, $2, ...` a partir da QUANTIDADE de valores, comecando em `inicio`.
 * Nenhum valor fornecido pelo chamador entra no texto do SQL.
 */
function placeholders(quantidade, inicio = 1) {
  return Array.from({ length: quantidade }, (_, i) => `$${inicio + i}`).join(', ');
}

/**
 * Linha de comprovante de UM movimento.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} pool
 * @param {number} movimentoId
 * @returns {Promise<object | undefined>} `undefined` quando nao ha linha — o que
 *   isso SIGNIFICA e decidido pelo caso de uso, nao aqui.
 */
async function buscarComprovantePorMovimento(pool, movimentoId) {
  // Id acima do teto do int4 nao pode ter linha: a coluna nao o representa.
  // Mandar assim mesmo faria o servidor recusar com 22003, enquanto o SQLite
  // apenas nao acharia nada — o contrato observavel tem de ser o mesmo.
  if (!cabeNoInt4(movimentoId)) return undefined;

  const { rows } = await pool.query(SQL_COMPROVANTE_POR_MOVIMENTO, [movimentoId]);
  return rows[0];
}

/**
 * Linha do movimento financeiro, usada para saber se ele existe.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} pool
 * @param {number} movimentoId
 * @returns {Promise<object | undefined>}
 */
async function buscarMovimentoPorId(pool, movimentoId) {
  // Igual ao anterior: id que nao cabe na coluna e indistinguivel de id que nao
  // existe. Quem chama transforma o `undefined` em `movimento_inexistente`.
  if (!cabeNoInt4(movimentoId)) return undefined;

  const { rows } = await pool.query(SQL_MOVIMENTO_POR_ID, [movimentoId]);
  return rows[0];
}

/**
 * Linhas de comprovante de VARIOS movimentos, em uma consulta.
 *
 * Os placeholders sao gerados pela QUANTIDADE de ids: nenhum id e concatenado no
 * texto do SQL. Lista vazia nao consulta o banco — `IN ()` seria erro de sintaxe
 * e a ida seria inutil de qualquer forma.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} pool
 * @param {number[]} movimentoIds
 * @returns {Promise<object[]>}
 */
async function buscarComprovantesDeMovimentos(pool, movimentoIds) {
  if (movimentoIds.length === 0) return [];

  // Ids fora da faixa do int4 sao descartados ANTES da consulta: um unico deles
  // faria o PostgreSQL recusar o lote INTEIRO com 22003, e ids perfeitamente
  // validos deixariam de ser lidos por causa do vizinho. Descartados aqui, eles
  // simplesmente nao trazem linha — que e exatamente o que o SQLite faz.
  const consultaveis = movimentoIds.filter(cabeNoInt4);
  if (consultaveis.length === 0) return [];

  const { rows } = await pool.query(
    `SELECT ${COLUNAS_COMPROVANTE}
       FROM comprovante
      WHERE movimento_id IN (${placeholders(consultaveis.length)})`,
    consultaveis
  );
  return rows;
}

/**
 * Quantidade de itens da fila ANTES de LIMIT/OFFSET: pagina e recorte, nao
 * universo.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} pool
 * @param {string[]} estados
 * @returns {Promise<number>}
 */
async function contarPendencias(pool, estados) {
  const sql = `SELECT COUNT(*) AS total${sqlFiltroPendencias(placeholders(estados.length))}`;
  const { rows } = await pool.query(sql, estados);
  // `COUNT(*)` e int8. O parser seguro da PG-1 ja o entrega como Number dentro
  // da faixa segura, mas `Number()` aqui mantem o contrato explicito.
  return Number(rows[0].total);
}

/**
 * Pagina da fila de pendencia.
 *
 * Ordenacao deterministica: backlog cronologico (`m.data`), desempate estavel
 * pelo id do movimento. Sem o desempate, dois movimentos na mesma data poderiam
 * trocar de lugar entre paginas e um deles sumiria da fila.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} pool
 * @param {string[]} estados
 * @param {{limite: number, offset: number}} pagina
 * @returns {Promise<object[]>}
 */
async function buscarPendencias(pool, estados, { limite, offset }) {
  // A numeracao acompanha a quantidade de estados: com 1 ou 2 estados o LIMIT
  // muda de posicao, e numero fixo escrito a mao leria o parametro errado.
  const placeholdersEstados = placeholders(estados.length);
  const placeholderLimite = `$${estados.length + 1}`;
  const placeholderOffset = `$${estados.length + 2}`;

  const sql = `
  SELECT c.id AS comprovante_id, c.movimento_id, c.estado, c.observacao,
         c.criado_em, c.atualizado_em,
         m.data AS movimento_data, m.valor_centavos AS movimento_valor_centavos,
         m.associado_id AS movimento_associado_id,
         m.estado_identificacao AS movimento_estado_identificacao,
         m.ativo AS movimento_ativo${sqlFiltroPendencias(placeholdersEstados)}
   ORDER BY m.data ASC, m.id ASC
   LIMIT ${placeholderLimite} OFFSET ${placeholderOffset}
`;

  const { rows } = await pool.query(sql, [...estados, limite, offset]);
  return rows;
}

// --- escrita (PG-2B2) — sempre com o `client` da transacao em curso ---------

/**
 * Linha do movimento COM lock de escrita, para serializar writers do mesmo
 * movimento (ver `SQL_MOVIMENTO_POR_ID_PARA_ATUALIZACAO`).
 *
 * @param {import('pg').PoolClient} client client da transacao — nunca o pool.
 * @param {number} movimentoId
 * @returns {Promise<object | undefined>}
 */
async function buscarMovimentoPorIdParaAtualizacao(client, movimentoId) {
  // Id fora da faixa do int4 e indistinguivel de id inexistente; mandar assim
  // mesmo faria o servidor recusar com 22003 e vazaria erro de driver como se
  // fosse contrato publico.
  if (!cabeNoInt4(movimentoId)) return undefined;

  const { rows } = await client.query(SQL_MOVIMENTO_POR_ID_PARA_ATUALIZACAO, [movimentoId]);
  return rows[0];
}

/**
 * Cria a linha de comprovante do movimento.
 *
 * @param {import('pg').PoolClient} client
 * @param {{movimentoId: number, estado: string, observacao: string | null}} dados
 * @returns {Promise<object>} a linha gravada, lida do proprio banco.
 */
async function inserirComprovante(client, { movimentoId, estado, observacao }) {
  const { rows } = await client.query(SQL_INSERT_COMPROVANTE, [movimentoId, estado, observacao]);
  return rows[0];
}

/**
 * Atualiza estado/observacao da linha existente.
 *
 * @param {import('pg').PoolClient} client
 * @param {{id: number, estado: string, observacao: string | null}} dados
 * @returns {Promise<object | undefined>} a linha resultante, ou `undefined` se
 *   nenhuma linha foi atingida — o que o caso de uso trata como erro.
 */
async function atualizarComprovante(client, { id, estado, observacao }) {
  const { rows, rowCount } = await client.query(SQL_ATUALIZAR_COMPROVANTE, [estado, observacao, id]);
  return rowCount === 1 ? rows[0] : undefined;
}

/**
 * Uma entrada de trilha (F-11), na MESMA transacao da mudanca que a produziu.
 *
 * `entidade_id` e TEXT no schema: gravamos `String(id)`, igual a trilha SQLite,
 * para que a mesma consulta encontre a mesma entrada nos dois bancos. Os campos
 * de estado e metadados vao como JSON serializado, tambem como no SQLite.
 *
 * @param {import('pg').PoolClient} client
 */
async function registrarAuditoria(
  client,
  { ator, acao, entidadeTipo, entidadeId, estadoAnterior = null, estadoPosterior = null, metadados = null }
) {
  await client.query(SQL_INSERT_AUDIT, [
    ator,
    acao,
    entidadeTipo,
    String(entidadeId),
    estadoAnterior === null ? null : JSON.stringify(estadoAnterior),
    estadoPosterior === null ? null : JSON.stringify(estadoPosterior),
    metadados === null ? null : JSON.stringify(metadados),
  ]);
}

module.exports = {
  COLUNAS_COMPROVANTE,
  buscarComprovantePorMovimento,
  buscarMovimentoPorId,
  buscarMovimentoPorIdParaAtualizacao,
  buscarComprovantesDeMovimentos,
  contarPendencias,
  buscarPendencias,
  inserirComprovante,
  atualizarComprovante,
  registrarAuditoria,
};
