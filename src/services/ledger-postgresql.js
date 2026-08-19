'use strict';

// Leitura do ledger sobre PostgreSQL (F-02 / F-06 / F-08 / F-10) — ADR-003, PG-2C1.
//
// ---------------------------------------------------------------------------
// ESTA IMPLEMENTACAO NAO ESTA NO RUNTIME
// ---------------------------------------------------------------------------
// Nenhuma rota, pagina, view ou script consome este modulo. O runtime continua
// no SQLite (`ledger.js`) ate PG-6. Este arquivo existe para que a equivalencia
// seja PROVADA por teste antes do cutover, e nao descoberta depois.
//
// Sem dual-read operacional e sem dual-write: so enxerga o que ja estiver no
// PostgreSQL, e nao grava nada em lugar nenhum.
//
// ---------------------------------------------------------------------------
// SOMENTE LEITURA — a escrita do ledger e fase posterior
// ---------------------------------------------------------------------------
// `registrarMovimento`, `alocarMovimento`, `identificarMovimento`,
// `inativarMovimento`, `inativarAlocacao`, `registrarAjuste` e `inativarAjuste`
// NAO foram convertidos. Nada aqui abre transacao, grava ou audita: leitura nao
// produz `audit_log` e nao corrige inconsistencia que encontre pelo caminho.
//
// ---------------------------------------------------------------------------
// Camadas (T-08)
// ---------------------------------------------------------------------------
// Este modulo e CASO DE USO. Nao contem SQL, `$n`, JOIN, agregacao, tipos do
// driver nem chamada de `query`: isso e persistencia e vive em
// `src/db/postgresql/ledger.js`.
//
// Aqui ficam as decisoes que sobrevivem a troca de banco: validacao e codigos de
// erro, o significado de ausencia de linha, paginacao, agrupamento do read model
// e composicao do resumo. O contrato comum esta em `ledger-contrato.js`,
// compartilhado com a trilha SQLite — as duas usam as MESMAS regras, entao a
// unica coisa que este arquivo pode fazer divergir e como o SQL foi escrito.
//
// A conexao chega pronta de fora e apenas ATRAVESSA este modulo rumo a
// persistencia, do mesmo jeito que o `db` do SQLite atravessa `ledger.js`.

const {
  LedgerError,
  exigirId,
  exigirPaginacao,
  mapearMovimento,
  mapearAlocacao,
  mapearMovimentoComInativacao,
  mapearAlocacaoComInativacao,
  rotuloCompetencia,
  montarResumo,
} = require('./ledger-contrato');

const repositorio = require('../db/postgresql/ledger');

/**
 * Resumo do movimento a partir do ledger (F-08), com a linha do movimento ja
 * lida. A aritmetica vive no contrato — aqui so buscamos os numeros.
 */
async function resumoDeMovimento(conexao, movimentoRow) {
  const { quantidade, soma } = await repositorio.resumirAlocacoesAtivas(conexao, movimentoRow.id);
  return montarResumo({
    movimentoId: movimentoRow.id,
    totalCentavos: movimentoRow.valor_centavos,
    quantidade,
    soma,
  });
}

/**
 * Alocacoes do movimento. Por padrao apenas as ativas; as inativadas continuam
 * no banco (M-09) e podem ser listadas com `{ incluirInativas: true }`.
 *
 * Ordenacao por `id` crescente: a ordem em que as alocacoes foram criadas.
 *
 * @param {object} conexao
 * @param {number} movimentoId
 * @param {{incluirInativas?: boolean}} [opcoes]
 * @returns {Promise<object[]>}
 * @throws {LedgerError} `id_invalido`.
 */
async function listarAlocacoesDoMovimento(conexao, movimentoId, { incluirInativas = false } = {}) {
  const id = exigirId(movimentoId, 'movimentoId');
  const linhas = await repositorio.buscarAlocacoesDoMovimento(conexao, id, { incluirInativas });
  return linhas.map(mapearAlocacao);
}

/**
 * Movimento com suas alocacoes ATIVAS e o resumo do ledger.
 *
 * Leitura pura. Movimento inexistente devolve `null` — e nao erro — mantendo o
 * contrato ja consumido pela camada web.
 *
 * @param {object} conexao
 * @param {number} movimentoId
 * @returns {Promise<object|null>} `null` quando o movimento nao existe.
 * @throws {LedgerError} `id_invalido`.
 */
async function obterMovimento(conexao, movimentoId) {
  const id = exigirId(movimentoId, 'movimentoId');
  const movimentoRow = await repositorio.buscarMovimentoPorId(conexao, id);
  if (movimentoRow === undefined) return null;

  return {
    ...mapearMovimento(movimentoRow),
    alocacoes: await listarAlocacoesDoMovimento(conexao, id),
    resumo: await resumoDeMovimento(conexao, movimentoRow),
  };
}

/**
 * Fila paginada de movimentos NAO IDENTIFICADOS (F-06 / F-10).
 *
 * Consulta pura: nao grava, nao corrige estado e — por ser leitura — nao produz
 * `audit_log`. Devolve exatamente os movimentos que a identificacao posterior
 * aceita: ativos, sem associado e com estado `nao_identificado`. Movimento
 * identificado, `em_revisao` ou inativo NAO aparece, e nada aqui promove um
 * estado a outro (M-08).
 *
 * Nenhum dado do legado participa: a fila e formada apenas pelas colunas do
 * proprio movimento. Nao ha busca por associado nem inferencia a partir do valor.
 *
 * `total` conta os elegiveis ANTES do LIMIT/OFFSET; pedir uma pagina alem do fim
 * devolve `itens` vazio sem alterar `total`. As duas consultas rodam fora de
 * transacao: leitura nao precisa — e nao deve — adquirir lock de gravacao.
 *
 * @param {object} conexao
 * @param {object} [opcoes]
 * @param {number} [opcoes.limite] 1..200 (padrao 50)
 * @param {number} [opcoes.offset] >= 0 (padrao 0)
 * @returns {Promise<{itens: object[], paginacao: {limite: number, offset: number, total: number}}>}
 */
async function listarMovimentosNaoIdentificados(conexao, opcoes = {}) {
  const { limite, offset } = exigirPaginacao(opcoes);

  const total = await repositorio.contarNaoIdentificados(conexao);
  const linhas = await repositorio.buscarNaoIdentificados(conexao, { limite, offset });

  return { itens: linhas.map(mapearMovimento), paginacao: { limite, offset, total } };
}

/**
 * Alocacoes dos movimentos informados, agrupadas por `movimentoId` e com a
 * competencia resolvida. Alocacoes INATIVADAS vem junto (M-09): quem exibe
 * decide como marca-las, mas o read model nao as omite.
 *
 * @returns {Promise<Map<number, object[]>>} movimento sem alocacao simplesmente
 *          nao tem chave no mapa.
 */
async function agruparAlocacoesComCompetencia(conexao, movimentoIds) {
  const porMovimento = new Map();

  for (const row of await repositorio.buscarAlocacoesComCompetencia(conexao, movimentoIds)) {
    const alocacao = {
      ...mapearAlocacaoComInativacao(row),
      competencia: {
        id: row.competencia_id,
        ano: row.competencia_ano,
        mes: row.competencia_mes,
        rotulo: rotuloCompetencia({ ano: row.competencia_ano, mes: row.competencia_mes }),
      },
    };
    const lista = porMovimento.get(row.movimento_id);
    if (lista === undefined) porMovimento.set(row.movimento_id, [alocacao]);
    else lista.push(alocacao);
  }

  return porMovimento;
}

/**
 * Extrato de um associado: seus movimentos, cada um com as proprias alocacoes
 * (F-02). Leitura pura — nao grava, nao corrige estado e nao gera `audit_log`.
 *
 * M-02 e preservado pela FORMA do retorno: as alocacoes ficam DENTRO do
 * movimento. Um movimento que atende tres competencias continua sendo um
 * movimento com tres alocacoes, nunca tres movimentos; e duas alocacoes de
 * movimentos diferentes na mesma competencia continuam sendo dois movimentos.
 *
 * Nao ha soma, saldo, valor esperado nem comparacao com competencia: C-03
 * segue TO CONFIRM e nada aqui produz situacao financeira (M-06).
 *
 * Duas consultas no total, independentemente da quantidade de movimentos: uma
 * para os movimentos e uma em lote para alocacoes + competencia. Nada de N+1.
 *
 * Valores permanecem em CENTAVOS INTEIROS (T-06); formatacao e assunto da view.
 *
 * @param {object} conexao
 * @param {number} associadoId id interno (nunca nome ou legacy_id)
 * @returns {Promise<object[]>} vazio quando o associado nao tem movimento vinculado.
 * @throws {LedgerError} `id_invalido` quando `associadoId` nao e inteiro positivo.
 */
async function listarMovimentosDoAssociado(conexao, associadoId) {
  const id = exigirId(associadoId, 'associadoId');

  const linhas = await repositorio.buscarMovimentosDoAssociado(conexao, id);
  if (linhas.length === 0) return [];

  const alocacoes = await agruparAlocacoesComCompetencia(
    conexao,
    linhas.map((row) => row.id)
  );

  // `...ComInativacao`: o extrato precisa PROVAR quando e por que um lancamento
  // deixou de valer, sem alterar o contrato base consumido pelas rotas JSON.
  return linhas.map((row) => ({
    ...mapearMovimentoComInativacao(row),
    alocacoes: alocacoes.get(row.id) ?? [],
  }));
}

/**
 * Total, alocado e nao alocado do movimento — tudo em centavos inteiros (F-08).
 *
 * Movimento inexistente e ERRO aqui (e nao `null`, como em `obterMovimento`):
 * o contrato ja consumido distingue "buscar um movimento que pode nao existir"
 * de "resumir ESTE movimento", e a segunda pergunta nao tem resposta vazia.
 *
 * @throws {LedgerError} `id_invalido`, `movimento_inexistente`.
 */
async function calcularResumoDoMovimento(conexao, movimentoId) {
  const id = exigirId(movimentoId, 'movimentoId');
  const movimentoRow = await repositorio.buscarMovimentoPorId(conexao, id);
  if (movimentoRow === undefined) {
    throw new LedgerError(`movimento ${id} nao existe`, 'movimento_inexistente');
  }
  return resumoDeMovimento(conexao, movimentoRow);
}

module.exports = {
  obterMovimento,
  listarMovimentosNaoIdentificados,
  listarMovimentosDoAssociado,
  listarAlocacoesDoMovimento,
  calcularResumoDoMovimento,
  LedgerError,
};
