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
 * SOMENTE LEITURA
 * ---------------------------------------------------------------------------
 * Nao ha INSERT, UPDATE, DELETE, BEGIN, COMMIT, ROLLBACK nem escrita em
 * `audit_log`. A gravacao transacional de comprovante (T-07 / F-11) e a PG-2B2 e
 * nao foi antecipada aqui. Nenhuma consulta usa lock explicito.
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

module.exports = {
  COLUNAS_COMPROVANTE,
  buscarComprovantePorMovimento,
  buscarMovimentoPorId,
  buscarComprovantesDeMovimentos,
  contarPendencias,
  buscarPendencias,
};
