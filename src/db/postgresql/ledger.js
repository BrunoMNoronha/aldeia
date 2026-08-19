'use strict';

/**
 * Persistencia PostgreSQL do ledger — LEITURA (ADR-003, PG-2C1).
 *
 * T-08 separa dominio, PERSISTENCIA, importacao e transporte web. Este modulo e
 * a camada de persistencia: aqui, e somente aqui, moram o SQL PostgreSQL, os
 * placeholders `$n`, o JOIN, o `IN (...)`, as agregacoes e a chamada ao driver.
 * Quem consome recebe LINHAS do banco e nada mais.
 *
 * O que este modulo deliberadamente NAO faz:
 *   * validar entrada ou decidir codigo de erro;
 *   * decidir o que significa ausencia de linha;
 *   * aplicar limite padrao de paginacao;
 *   * mapear linha para o contrato publico;
 *   * calcular situacao financeira.
 *
 * Tudo isso vive em `src/services/`. A direcao da dependencia e SEMPRE
 * service -> db; este arquivo nao conhece `src/services/`.
 *
 * ---------------------------------------------------------------------------
 * SOMENTE LEITURA
 * ---------------------------------------------------------------------------
 * Nao ha INSERT, UPDATE, DELETE, BEGIN, COMMIT, ROLLBACK nem escrita em
 * `audit_log`. A gravacao do ledger (registrar, alocar, identificar, inativar,
 * ajustar) permanece exclusivamente na trilha SQLite nesta fase. Nenhuma
 * consulta usa lock: leitura nao adquire lock de escrita.
 */

const { cabeNoInt4 } = require('./tipos');

/** Colunas do movimento — uma unica lista, igual a da trilha SQLite. */
const COLUNAS_MOVIMENTO = `
         id, data, valor_centavos, tipo, origem, associado_id, observacao,
         estado_identificacao, ativo, inativado_em, motivo_inativacao,
         criado_em, atualizado_em`;

/** Colunas da alocacao, incluindo a trilha de inativacao (M-09). */
const COLUNAS_ALOCACAO = `
         id, movimento_id, competencia_id, valor_centavos, observacao, ativo,
         inativado_em, motivo_inativacao, criado_em, atualizado_em`;

const SQL_MOVIMENTO_POR_ID = `
  SELECT ${COLUNAS_MOVIMENTO}
    FROM movimento_financeiro
   WHERE id = $1
`;

/**
 * Fila de nao identificados (F-06 / F-10). As tres condicoes valem JUNTAS e
 * moram aqui, no SQL, e nao na rota:
 *   ativo = TRUE                          -> movimento inativado sai da fila (M-09);
 *   associado_id IS NULL                  -> ja vinculado nunca reaparece;
 *   estado_identificacao = 'nao_identificado'
 *                                         -> 'em_revisao' e ambiguidade DECLARADA
 *                                            (M-08) e NAO e promovido a fila.
 * Os dois ultimos filtros sao redundantes no caminho feliz e propositais: se
 * alguma inconsistencia manual deixar `associado_id` preenchido com estado
 * 'nao_identificado' (ou o contrario), o movimento fica FORA da fila em vez de
 * ser oferecido para identificacao.
 *
 * `ativo = TRUE` e o mesmo filtro que o SQLite escreve como `ativo = 1`: a
 * coluna e BOOLEAN aqui e INTEGER la, e o predicado tem de acompanhar.
 */
const SQL_FILTRO_NAO_IDENTIFICADOS = `
    FROM movimento_financeiro
   WHERE ativo = TRUE
     AND associado_id IS NULL
     AND estado_identificacao = 'nao_identificado'`;

/** `total` e contado ANTES de LIMIT/OFFSET: pagina e recorte, nao universo. */
const SQL_CONTAR_NAO_IDENTIFICADOS = `
  SELECT COUNT(*) AS total${SQL_FILTRO_NAO_IDENTIFICADOS}
`;

/** Ordenacao deterministica: fila cronologica, desempate estavel pelo id. */
const SQL_LISTAR_NAO_IDENTIFICADOS = `
  SELECT ${COLUNAS_MOVIMENTO}${SQL_FILTRO_NAO_IDENTIFICADOS}
   ORDER BY data ASC, id ASC
   LIMIT $1 OFFSET $2
`;

/**
 * Alocacoes de UM movimento. Duas variantes fixas em vez de um predicado
 * montado em tempo de execucao: a escolha e do CODIGO (um booleano do contrato),
 * nunca um valor do usuario entrando no texto do SQL.
 *
 * O filtro fica no SQL — e nao num `.filter()` depois — para nao trazer do
 * banco linhas que serao descartadas.
 */
const SQL_ALOCACOES_ATIVAS_DO_MOVIMENTO = `
  SELECT ${COLUNAS_ALOCACAO}
    FROM alocacao
   WHERE movimento_id = $1 AND ativo = TRUE
   ORDER BY id
`;

const SQL_ALOCACOES_DO_MOVIMENTO = `
  SELECT ${COLUNAS_ALOCACAO}
    FROM alocacao
   WHERE movimento_id = $1
   ORDER BY id
`;

/**
 * Ledger INDIVIDUAL (F-02): movimentos ligados ao associado pela unica coluna
 * que expressa esse vinculo — `associado_id`. Nao ha filtro por estado, valor,
 * data ou origem: quem esta vinculado aparece, e quem nao esta nao aparece.
 *
 * `ativo = FALSE` NAO e filtrado: esconder um movimento inativado seria apagar
 * historico da tela (M-09). O estado real vai junto e a UI o exibe.
 *
 * Ordenacao `data DESC, id DESC` — extrato individual comeca pelo mais recente,
 * ao contrario da fila de nao identificados, que e um backlog.
 */
const SQL_MOVIMENTOS_DO_ASSOCIADO = `
  SELECT ${COLUNAS_MOVIMENTO}
    FROM movimento_financeiro
   WHERE associado_id = $1
   ORDER BY data DESC, id DESC
`;

/**
 * Resumo das alocacoes ATIVAS de um movimento (F-08).
 *
 * T-06 — a soma e o ponto delicado desta consulta. `valor_centavos` e BIGINT e
 * `SUM(bigint)` no PostgreSQL retorna NUMERIC, que o driver entrega como
 * STRING para nao corromper valores grandes. Um `Number(...)` cru na aplicacao
 * seria exatamente a coercao insegura que T-06 proibe.
 *
 * O `::bigint` resolve isso NO BANCO, e nao com ponto flutuante:
 *   * a soma de BIGINTs e sempre um inteiro, entao o cast NUMERIC -> BIGINT e
 *     exato — nao ha fracao para arredondar;
 *   * se o total nao coubesse em int8, o PostgreSQL RECUSA a consulta em vez de
 *     arredondar em silencio;
 *   * o resultado volta como int8 e cai no `parseInt8Seguro` ja instalado na
 *     fundacao (PG-1), que so converte para Number dentro da faixa segura de
 *     inteiros do JavaScript e LANCA fora dela.
 *
 * Em nenhum ponto ha `::float`, `DOUBLE PRECISION` ou `parseFloat`.
 */
const SQL_RESUMO_ALOCACOES_ATIVAS = `
  SELECT COUNT(*) AS quantidade,
         COALESCE(SUM(valor_centavos), 0)::bigint AS soma
    FROM alocacao
   WHERE movimento_id = $1 AND ativo = TRUE
`;

/**
 * Monta `$1, $2, ...` a partir da QUANTIDADE de valores, comecando em `inicio`.
 * Nenhum valor fornecido pelo chamador entra no texto do SQL.
 */
function placeholders(quantidade, inicio = 1) {
  return Array.from({ length: quantidade }, (_, i) => `$${inicio + i}`).join(', ');
}

/**
 * Alocacoes de VARIOS movimentos em uma consulta, ja com a competencia
 * resolvida — evita uma ida ao banco por movimento e outra por competencia.
 *
 * As colunas de `competencia` sao apelidadas porque `id`, `observacao`,
 * `criado_em` e `atualizado_em` existem nas duas tabelas.
 */
function sqlAlocacoesComCompetencia(listaDePlaceholders) {
  return `
  SELECT a.id, a.movimento_id, a.competencia_id, a.valor_centavos, a.observacao,
         a.ativo, a.inativado_em, a.motivo_inativacao, a.criado_em, a.atualizado_em,
         c.ano AS competencia_ano, c.mes AS competencia_mes
    FROM alocacao a
    JOIN competencia c ON c.id = a.competencia_id
   WHERE a.movimento_id IN (${listaDePlaceholders})
   ORDER BY c.ano ASC, c.mes ASC, a.id ASC
`;
}

/**
 * Linha do movimento financeiro.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} pool
 * @param {number} movimentoId
 * @returns {Promise<object | undefined>} `undefined` quando nao ha linha — o que
 *   isso SIGNIFICA e decidido pelo caso de uso, nao aqui.
 */
async function buscarMovimentoPorId(pool, movimentoId) {
  // Id acima do teto do int4 nao pode ter linha: a coluna nao o representa.
  // Mandar assim mesmo faria o servidor recusar com 22003, enquanto o SQLite
  // apenas nao acharia nada — o contrato observavel tem de ser o mesmo.
  if (!cabeNoInt4(movimentoId)) return undefined;

  const { rows } = await pool.query(SQL_MOVIMENTO_POR_ID, [movimentoId]);
  return rows[0];
}

/**
 * Quantidade de movimentos elegiveis a fila, ANTES de LIMIT/OFFSET.
 *
 * `COUNT(*)` e int8; o parser seguro da PG-1 o entrega como Number dentro da
 * faixa segura, e `Number()` aqui mantem o contrato explicito.
 *
 * @returns {Promise<number>}
 */
async function contarNaoIdentificados(pool) {
  const { rows } = await pool.query(SQL_CONTAR_NAO_IDENTIFICADOS);
  return Number(rows[0].total);
}

/**
 * Pagina da fila de nao identificados.
 *
 * @param {{limite: number, offset: number}} pagina
 * @returns {Promise<object[]>}
 */
async function buscarNaoIdentificados(pool, { limite, offset }) {
  const { rows } = await pool.query(SQL_LISTAR_NAO_IDENTIFICADOS, [limite, offset]);
  return rows;
}

/**
 * Alocacoes de um movimento, ativas ou todas.
 *
 * @param {number} movimentoId
 * @param {{incluirInativas: boolean}} opcoes
 * @returns {Promise<object[]>}
 */
async function buscarAlocacoesDoMovimento(pool, movimentoId, { incluirInativas }) {
  // Mesmo raciocinio do movimento: id fora da faixa nao tem linha nenhuma.
  if (!cabeNoInt4(movimentoId)) return [];

  const sql = incluirInativas ? SQL_ALOCACOES_DO_MOVIMENTO : SQL_ALOCACOES_ATIVAS_DO_MOVIMENTO;
  const { rows } = await pool.query(sql, [movimentoId]);
  return rows;
}

/**
 * Movimentos vinculados a um associado (ativos e inativos).
 *
 * @returns {Promise<object[]>}
 */
async function buscarMovimentosDoAssociado(pool, associadoId) {
  if (!cabeNoInt4(associadoId)) return [];

  const { rows } = await pool.query(SQL_MOVIMENTOS_DO_ASSOCIADO, [associadoId]);
  return rows;
}

/**
 * Alocacoes de varios movimentos, com a competencia resolvida (evita N+1).
 *
 * Lista vazia nao consulta o banco — `IN ()` seria erro de sintaxe e a ida
 * seria inutil de qualquer forma.
 *
 * @param {number[]} movimentoIds
 * @returns {Promise<object[]>}
 */
async function buscarAlocacoesComCompetencia(pool, movimentoIds) {
  if (movimentoIds.length === 0) return [];

  // Os ids vem do proprio banco (sao ids de movimentos ja lidos), mas o filtro
  // de faixa e mantido: um unico id fora do int4 faria o servidor recusar o
  // lote INTEIRO com 22003, e alocacoes validas sumiriam por causa do vizinho.
  const consultaveis = movimentoIds.filter(cabeNoInt4);
  if (consultaveis.length === 0) return [];

  const { rows } = await pool.query(
    sqlAlocacoesComCompetencia(placeholders(consultaveis.length)),
    consultaveis
  );
  return rows;
}

/**
 * Quantidade e soma das alocacoes ATIVAS do movimento.
 *
 * Ver `SQL_RESUMO_ALOCACOES_ATIVAS` para o tratamento de `SUM(bigint)` (T-06).
 *
 * @returns {Promise<{quantidade: number, soma: number}>}
 */
async function resumirAlocacoesAtivas(pool, movimentoId) {
  if (!cabeNoInt4(movimentoId)) return { quantidade: 0, soma: 0 };

  const { rows } = await pool.query(SQL_RESUMO_ALOCACOES_ATIVAS, [movimentoId]);
  // `COUNT(*)` e `SUM(...)::bigint` chegam como Number pelo parser int8 seguro
  // instalado na fundacao; `Number()` aqui e apenas o contrato explicito.
  return { quantidade: Number(rows[0].quantidade), soma: Number(rows[0].soma) };
}

module.exports = {
  COLUNAS_MOVIMENTO,
  COLUNAS_ALOCACAO,
  buscarMovimentoPorId,
  contarNaoIdentificados,
  buscarNaoIdentificados,
  buscarAlocacoesDoMovimento,
  buscarMovimentosDoAssociado,
  buscarAlocacoesComCompetencia,
  resumirAlocacoesAtivas,
};
