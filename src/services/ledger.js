'use strict';

// Nucleo financeiro transacional (Fase 2A): registro MANUAL de movimento e
// alocacao do movimento em competencias.
//
// Requisitos do baseline atendidos aqui:
//   T-06 : todo valor monetario trafega e e persistido em CENTAVOS INTEIROS.
//   T-07 : movimento + alocacoes + auditoria gravam na MESMA transacao SQLite.
//   M-02 : um movimento atende varias competencias; uma competencia recebe
//          varios movimentos.
//   M-05 : movimento sem associado existe (deposito nao identificado).
//   M-09 : nada e excluido fisicamente por este servico. Correcao de lancamento
//          e INATIVACAO auditavel (`inativarMovimento` / `inativarAlocacao` /
//          `inativarAjuste`).
//   M-03 : credito e debito existem EXPLICITAMENTE, como vocabulario
//          estruturado (`registrarAjuste`), nunca deduzidos de texto livre.
//   M-10 : competencia e dado (linha em `competencia`), nunca coluna.
//   F-03 : registrar pagamento/deposito e aloca-lo em uma ou varias competencias.
//   F-04 : registrar ajustes de credito/debito com motivo e auditoria.
//   F-06 : fila de movimentos nao identificados, para vinculacao posterior.
//   F-08 : o resumo vem SOMENTE do ledger (movimento + alocacoes ativas).
//   F-10 : visao das pendencias operacionais — o que ainda nao tem identificacao.
//   F-11 : toda gravacao valida deixa trilha em `audit_log`.
//
// O que este servico NAO faz — e nao deve passar a fazer sem decisao humana:
//   * ler, interpretar ou converter celula legada em movimento;
//   * decidir mensalidade (25/40) ou vigencia de competencia;
//   * usar qualquer total ou formula da planilha em calculo;
//   * transformar um ajuste de credito/debito em saldo, quitacao, compensacao
//     automatica, estorno ou situacao de adimplencia;
//   * implementar comprovante, pendencia, conciliacao;
//   * autenticar: o ator gravado e uma representacao tecnica, nunca um usuario
//     inventado.

const { withTransaction } = require('../db/connection');
const { TIPO_AJUSTE, ATOR_PADRAO } = require('../domain/constants');
// Contrato compartilhado com a trilha PostgreSQL (ADR-003 / PG-2C1): erro de
// dominio, validacao de id/paginacao, mappers publicos e rotulo de competencia.
// A ESCRITA (validacao de centavos, data, origem, motivo, ator e a auditoria)
// continua aqui — este modulo ainda e o runtime, e move-la agora seria refatorar
// o ledger inteiro no meio da migracao de banco.
const {
  LedgerError,
  descrever,
  exigirId,
  exigirParametroDePagina,
  normalizarBooleano,
  mapearMovimento,
  mapearAlocacao,
  mapearMovimentoComInativacao,
  mapearAlocacaoComInativacao,
  rotuloCompetencia,
  montarResumo,
} = require('./ledger-contrato');

/**
 * Vocabulario de origem aceito no lancamento MANUAL desta fase.
 * `movimento_financeiro.origem` e texto livre no schema (o baseline ainda nao
 * congelou o vocabulario), portanto a restricao vive aqui, no dominio.
 */
const ORIGENS_MANUAIS = Object.freeze(['pagamento', 'deposito']);

/**
 * Pagamento e deposito sao ENTRADAS de dinheiro, logo `tipo = 'credito'`.
 * Saida (debito) e ajuste de credito/debito por associado pertencem a
 * `ajuste_credito_debito` e a fases proprias: nao ha valor negativo aqui.
 */
const TIPO_ENTRADA = 'credito';

// `ATOR_PADRAO` (ator tecnico, coerente com o default do schema) vem de
// `domain/constants`: as trilhas SQLite e PostgreSQL precisam do MESMO padrao e
// nenhuma delas pode depender da outra. Continua reexportado por este modulo.

/** Marca na auditoria que o lancamento foi digitado, nao derivado da planilha. */
const ORIGEM_REGISTRO = 'manual';

/**
 * Estado de identificacao servido pela fila operacional (F-06 / F-10).
 * Exportado para que a camada HTTP compare com ELE, em vez de repetir a string.
 */
const ESTADO_NAO_IDENTIFICADO = 'nao_identificado';

/**
 * Paginacao por LIMIT/OFFSET, com teto: uma fila operacional e lida em pagina,
 * nunca inteira de uma vez. Sem cursor nesta fase.
 *
 * Os valores moram em `./paginacao` desde a PG-2B1, para que a trilha PostgreSQL
 * possa reutiliza-los sem importar este arquivo (que carrega o driver SQLite).
 * A reexportacao permanece: quem ja lia `PAGINACAO` daqui continua funcionando.
 */
const { PAGINACAO } = require('./paginacao');

const ACAO_MOVIMENTO_CRIADO = 'movimento_financeiro.criado';
const ACAO_ALOCACAO_CRIADA = 'alocacao.criada';
const ACAO_MOVIMENTO_IDENTIFICADO = 'movimento_financeiro.identificado';
const ACAO_MOVIMENTO_INATIVADO = 'movimento_financeiro.inativado';
const ACAO_ALOCACAO_INATIVADA = 'alocacao.inativada';
const ACAO_AJUSTE_CRIADO = 'ajuste_credito_debito.criado';
const ACAO_AJUSTE_INATIVADO = 'ajuste_credito_debito.inativado';

const SQL_INSERT_MOVIMENTO = `
  INSERT INTO movimento_financeiro
    (data, valor_centavos, tipo, origem, associado_id, observacao, estado_identificacao)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;

/** Colunas do movimento lidas pelo servico — uma unica lista, um unico mapper. */
const COLUNAS_MOVIMENTO = `
         id, data, valor_centavos, tipo, origem, associado_id, observacao,
         estado_identificacao, ativo, inativado_em, motivo_inativacao,
         criado_em, atualizado_em`;

const SQL_MOVIMENTO_POR_ID = `
  SELECT ${COLUNAS_MOVIMENTO}
    FROM movimento_financeiro
   WHERE id = ?
`;

/**
 * Fila de nao identificados (F-06 / F-10). As tres condicoes valem JUNTAS e
 * moram aqui, no SQL, e nao na rota:
 *   ativo = 1                             -> movimento inativado sai da fila (M-09);
 *   associado_id IS NULL                  -> ja vinculado nunca reaparece;
 *   estado_identificacao = 'nao_identificado'
 *                                         -> 'em_revisao' e ambiguidade DECLARADA
 *                                            (M-08) e NAO e promovido a fila.
 * Os dois ultimos filtros sao redundantes no caminho feliz e propositais: se
 * alguma inconsistencia manual deixar `associado_id` preenchido com estado
 * 'nao_identificado' (ou o contrario), o movimento fica FORA da fila em vez de
 * ser oferecido para identificacao.
 */
const SQL_FILTRO_NAO_IDENTIFICADOS = `
    FROM movimento_financeiro
   WHERE ativo = 1
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
   LIMIT ? OFFSET ?
`;

/**
 * Identificacao posterior (F-06): so toca `associado_id` e
 * `estado_identificacao` — valor, data, tipo, origem, observacao e `ativo`
 * permanecem intactos. As pre-condicoes estao repetidas no WHERE de proposito:
 * mesmo dentro da transacao, o UPDATE so atinge um movimento ainda nao
 * identificado, entao nunca sobrescreve um vinculo existente (M-05 / M-09).
 */
const SQL_IDENTIFICAR_MOVIMENTO = `
  UPDATE movimento_financeiro
     SET associado_id = ?,
         estado_identificacao = 'identificado',
         atualizado_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
   WHERE id = ?
     AND ativo = 1
     AND associado_id IS NULL
     AND estado_identificacao = 'nao_identificado'
`;

/**
 * Inativacao AUDITAVEL do movimento (M-09 / F-11). Nao ha DELETE: a linha
 * permanece, com `ativo = 0`, `inativado_em` e `motivo_inativacao` — os dois
 * ultimos sao exigidos pelo proprio CHECK do schema.
 *
 * O SET nao encosta em `data`, `valor_centavos`, `tipo`, `origem`,
 * `associado_id`, `observacao` nem `estado_identificacao`: corrigir por
 * inativacao e declarar que o lancamento nao vale mais, nunca reescreve-lo.
 *
 * As pre-condicoes estao repetidas no WHERE por defesa em profundidade, ja
 * validadas antes sob o mesmo lock de escrita:
 *   ativo = 1                -> segunda inativacao nao vira no-op silencioso;
 *   NOT EXISTS alocacao ativa -> nao existe alocacao ativa pendurada em
 *                                movimento inativo (sem cascata implicita).
 * `strftime('now')` e constante dentro do mesmo statement, entao
 * `inativado_em` e `atualizado_em` gravam exatamente o mesmo instante UTC.
 */
const SQL_INATIVAR_MOVIMENTO = `
  UPDATE movimento_financeiro
     SET ativo = 0,
         inativado_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
         motivo_inativacao = ?,
         atualizado_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
   WHERE id = ?
     AND ativo = 1
     AND NOT EXISTS (
           SELECT 1
             FROM alocacao
            WHERE alocacao.movimento_id = movimento_financeiro.id
              AND alocacao.ativo = 1
         )
`;

const SQL_INSERT_ALOCACAO = `
  INSERT INTO alocacao (movimento_id, competencia_id, valor_centavos, observacao)
  VALUES (?, ?, ?, ?)
`;

/**
 * Inativacao AUDITAVEL da alocacao (M-09 / F-11). `movimento_id`,
 * `competencia_id`, `valor_centavos` e `observacao` permanecem intactos: a
 * alocacao continua contando a historia de onde aquele dinheiro FOI alocado.
 *
 * Com `ativo = 0`, o indice parcial `ux_alocacao_ativa` deixa de considerar a
 * linha, entao o mesmo par movimento+competencia pode receber uma nova alocacao
 * ativa — a correcao acontece sem apagar a tentativa anterior.
 */
const SQL_INATIVAR_ALOCACAO = `
  UPDATE alocacao
     SET ativo = 0,
         inativado_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
         motivo_inativacao = ?,
         atualizado_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
   WHERE id = ?
     AND ativo = 1
`;

const SQL_ALOCACAO_POR_ID = `
  SELECT id, movimento_id, competencia_id, valor_centavos, observacao, ativo,
         inativado_em, motivo_inativacao, criado_em, atualizado_em
    FROM alocacao
   WHERE id = ?
`;

const SQL_ALOCACOES_DO_MOVIMENTO = `
  SELECT id, movimento_id, competencia_id, valor_centavos, observacao, ativo,
         inativado_em, motivo_inativacao, criado_em, atualizado_em
    FROM alocacao
   WHERE movimento_id = ?
   ORDER BY id
`;

/**
 * Ledger INDIVIDUAL (F-02): movimentos ligados ao associado pela unica coluna
 * que expressa esse vinculo — `associado_id`. Nao ha filtro por estado, valor,
 * data ou origem: quem esta vinculado aparece, e quem nao esta nao aparece.
 * Movimento com `associado_id IS NULL` (M-05) fica de fora ate ser identificado
 * pelo fluxo estruturado.
 *
 * `ativo = 0` NAO e filtrado: esconder um movimento inativado seria apagar
 * historico da tela (M-09). O estado real vai junto e a UI o exibe.
 *
 * Ordenacao `data DESC, id DESC` — extrato individual comeca pelo mais recente.
 * Difere de proposito da fila de nao identificados (`data ASC`), que e um
 * backlog e por isso comeca pelo mais antigo.
 */
const SQL_MOVIMENTOS_DO_ASSOCIADO = `
  SELECT ${COLUNAS_MOVIMENTO}
    FROM movimento_financeiro
   WHERE associado_id = ?
   ORDER BY data DESC, id DESC
`;

/**
 * Alocacoes de VARIOS movimentos em uma consulta, ja com a competencia
 * resolvida — evita uma ida ao banco por movimento e outra por competencia.
 *
 * Os `?` sao gerados a partir da QUANTIDADE de ids; nenhum valor e concatenado
 * na SQL. As colunas de `competencia` sao apelidadas porque `id`, `observacao`,
 * `criado_em` e `atualizado_em` existem nas duas tabelas.
 */
function sqlAlocacoesComCompetencia(placeholders) {
  return `
  SELECT a.id, a.movimento_id, a.competencia_id, a.valor_centavos, a.observacao,
         a.ativo, a.inativado_em, a.motivo_inativacao, a.criado_em, a.atualizado_em,
         c.ano AS competencia_ano, c.mes AS competencia_mes
    FROM alocacao a
    JOIN competencia c ON c.id = a.competencia_id
   WHERE a.movimento_id IN (${placeholders})
   ORDER BY c.ano ASC, c.mes ASC, a.id ASC
`;
}

const SQL_ALOCACAO_ATIVA_NA_COMPETENCIA = `
  SELECT id FROM alocacao
   WHERE movimento_id = ? AND competencia_id = ? AND ativo = 1
`;

/**
 * Quantas alocacoes o movimento tem, no total e ativas.
 * `ativas` decide se a inativacao do movimento e permitida; `total` prova, na
 * auditoria, quantas linhas continuaram existindo depois dela (M-09).
 */
const SQL_CONTAGEM_ALOCACOES = `
  SELECT COUNT(*) AS total, COALESCE(SUM(ativo), 0) AS ativas
    FROM alocacao
   WHERE movimento_id = ?
`;

/** F-08: o total alocado sai do ledger, nunca de um total herdado da planilha. */
const SQL_RESUMO_ALOCACOES = `
  SELECT COUNT(*) AS quantidade, COALESCE(SUM(valor_centavos), 0) AS soma
    FROM alocacao
   WHERE movimento_id = ? AND ativo = 1
`;

const SQL_COMPETENCIA_POR_ID = `
  SELECT id, ano, mes, valor_esperado_centavos FROM competencia WHERE id = ?
`;

/**
 * Ajuste explicito de credito/debito por associado (M-03 / F-04).
 *
 * `ativo`, `criado_em` e `atualizado_em` NAO estao na lista: os defaults do
 * schema os preenchem. Ajuste nasce ATIVO, e nao ha caminho neste servico para
 * cria-lo ja inativado — inativacao e operacao propria, com motivo proprio.
 */
const SQL_INSERT_AJUSTE = `
  INSERT INTO ajuste_credito_debito
    (associado_id, tipo, valor_centavos, motivo, data, competencia_id, observacao)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;

const SQL_AJUSTE_POR_ID = `
  SELECT id, associado_id, tipo, valor_centavos, motivo, data, competencia_id,
         observacao, ativo, inativado_em, motivo_inativacao, criado_em, atualizado_em
    FROM ajuste_credito_debito
   WHERE id = ?
`;

/**
 * Inativacao AUDITAVEL do ajuste (M-09 / F-11), no mesmo formato ja usado por
 * movimento e alocacao. Nao ha DELETE: a linha permanece, com `ativo = 0`,
 * `inativado_em` e `motivo_inativacao` — os dois ultimos exigidos pelo proprio
 * CHECK do schema.
 *
 * O SET nao encosta em `associado_id`, `tipo`, `valor_centavos`, `motivo`,
 * `data`, `competencia_id` nem `observacao`: o ajuste continua contando o que
 * foi decidido e por que. `motivo_inativacao` e informacao ADICIONAL de
 * correcao e nunca sobrescreve o `motivo` original do ajuste.
 *
 * A pre-condicao `ativo = 1` esta repetida no WHERE por defesa em profundidade,
 * ja validada antes sob o mesmo lock de escrita: assim uma segunda inativacao
 * nao vira no-op silencioso sobre o timestamp e o motivo originais.
 *
 * `strftime('now')` e constante dentro do mesmo statement, entao `inativado_em`
 * e `atualizado_em` gravam exatamente o mesmo instante UTC.
 */
const SQL_INATIVAR_AJUSTE = `
  UPDATE ajuste_credito_debito
     SET ativo = 0,
         inativado_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
         motivo_inativacao = ?,
         atualizado_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
   WHERE id = ?
     AND ativo = 1
`;

const SQL_ASSOCIADO_POR_ID = 'SELECT id FROM associado WHERE id = ?';

const SQL_INSERT_AUDIT = `
  INSERT INTO audit_log
    (ator, acao, entidade_tipo, entidade_id, estado_anterior, estado_posterior, metadados)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;

// --- validacao de entrada ---------------------------------------------------

/**
 * T-06: a API so aceita centavos INTEIROS positivos.
 * 150.35 (reais) e recusado explicitamente em vez de virar 150 ou 150.35 no
 * banco — dinheiro fracionario nunca entra silenciosamente como fonte de verdade.
 */
function exigirCentavos(valor, campo) {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor)) {
    throw new LedgerError(
      `${campo} deve ser um inteiro em centavos (recebido: ${descrever(valor)})`,
      'valor_nao_inteiro'
    );
  }
  if (valor <= 0) {
    throw new LedgerError(`${campo} deve ser maior que zero (recebido: ${valor})`, 'valor_nao_positivo');
  }
  return valor;
}

const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

function exigirData(valor) {
  const texto = typeof valor === 'string' ? valor.trim() : '';
  if (!DATA_RE.test(texto)) {
    throw new LedgerError(
      `data deve estar no formato YYYY-MM-DD (recebido: ${descrever(valor)})`,
      'data_invalida'
    );
  }

  const [ano, mes, dia] = texto.split('-').map(Number);
  const referencia = new Date(Date.UTC(ano, mes - 1, dia));
  if (
    referencia.getUTCFullYear() !== ano ||
    referencia.getUTCMonth() !== mes - 1 ||
    referencia.getUTCDate() !== dia
  ) {
    throw new LedgerError(`data inexistente no calendario: ${texto}`, 'data_invalida');
  }

  return texto;
}

function exigirOrigem(valor) {
  const origem = typeof valor === 'string' ? valor.trim().toLowerCase() : '';
  if (!ORIGENS_MANUAIS.includes(origem)) {
    throw new LedgerError(
      `origem deve ser uma de: ${ORIGENS_MANUAIS.join(', ')} (recebido: ${descrever(valor)})`,
      'origem_invalida'
    );
  }
  return origem;
}

/**
 * M-03: credito e debito sao vocabulario ESTRUTURADO, nunca texto livre. O tipo
 * chega pelo mesmo vocabulario ja congelado no CHECK da migration 001 e
 * espelhado em `domain/constants.TIPO_AJUSTE` — nao ha segunda lista aqui.
 *
 * `trim().toLowerCase()` e a MESMA normalizacao que `exigirOrigem` ja aplica ao
 * vocabulario fechado do projeto: so uniformiza a caixa da palavra, jamais
 * traduz significado. 'credito' e 'CREDITO' sao a mesma palavra; 'credito' e
 * 'entrada' nao sao. Por isso continuam RECUSADOS: 'credito' acentuado, 'deb',
 * 'entrada', 'saida', 'estorno', '+' e '-'. Decidir que '+' quer dizer credito
 * seria interpretar, e interpretacao nao acontece aqui.
 */
function exigirTipoAjuste(valor) {
  const tipo = typeof valor === 'string' ? valor.trim().toLowerCase() : '';
  if (!TIPO_AJUSTE.includes(tipo)) {
    throw new LedgerError(
      `tipo deve ser um de: ${TIPO_AJUSTE.join(', ')} (recebido: ${descrever(valor)})`,
      'tipo_ajuste_invalido'
    );
  }
  return tipo;
}

function textoOpcional(valor, campo) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor !== 'string') {
    throw new LedgerError(`${campo} deve ser texto (recebido: ${descrever(valor)})`, 'campo_invalido');
  }
  const texto = valor.trim();
  return texto === '' ? null : texto;
}

function idOpcional(valor, campo) {
  if (valor === null || valor === undefined) return null;
  return exigirId(valor, campo);
}

function exigirAtor(valor) {
  return textoOpcional(valor, 'ator') ?? ATOR_PADRAO;
}

/**
 * M-08 / F-11: identificar um deposito — ou inativar um lancamento — e uma
 * decisao humana e precisa dizer por que. Texto vazio ou so espaco nao explica
 * nada e e recusado. A unica normalizacao aplicada e o `trim` ja convencionado
 * no projeto — o conteudo informado chega intacto a auditoria.
 *
 * `decisao` so muda a MENSAGEM de erro; o codigo (`motivo_obrigatorio`) e a
 * regra sao os mesmos para toda escrita que exige justificativa.
 */
function exigirMotivo(valor, decisao = 'a identificacao') {
  const motivo = textoOpcional(valor, 'motivo');
  if (motivo === null) {
    throw new LedgerError(
      `motivo e obrigatorio e deve explicar ${decisao} (recebido: ${descrever(valor)})`,
      'motivo_obrigatorio'
    );
  }
  return motivo;
}

// --- mapeamento linha -> objeto de dominio ----------------------------------

/**
 * Ajuste de credito/debito — mapper UNICO da entidade (M-03).
 *
 * Ja inclui a trilha de inativacao: diferente de movimento e alocacao, o ajuste
 * nao tem contrato JSON anterior a preservar, entao nao ha razao para duas
 * versoes do mesmo objeto. `inativadoEm`/`motivoInativacao` sao `null` em todo
 * ajuste recem-criado e existem no retorno para que o consumidor leia o estado
 * real (M-09) sem precisar de uma segunda consulta.
 *
 * O sinal economico vive SOMENTE em `tipo`: `valorCentavos` e sempre positivo,
 * aqui e no banco (T-06). Nada nesta funcao soma, compara ou converte valor.
 */
function mapearAjuste(row) {
  if (row === undefined || row === null) return null;
  return {
    id: row.id,
    associadoId: row.associado_id,
    tipo: row.tipo,
    valorCentavos: row.valor_centavos,
    motivo: row.motivo,
    data: row.data,
    competenciaId: row.competencia_id,
    observacao: row.observacao,
    ativo: normalizarBooleano(row.ativo),
    inativadoEm: row.inativado_em,
    motivoInativacao: row.motivo_inativacao,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

// --- auditoria (F-11) -------------------------------------------------------

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

// --- leitura do ledger ------------------------------------------------------

function lerMovimento(db, movimentoId) {
  return db.prepare(SQL_MOVIMENTO_POR_ID).get(movimentoId);
}

function exigirMovimento(db, movimentoId) {
  const row = lerMovimento(db, movimentoId);
  if (row === undefined) {
    throw new LedgerError(`movimento ${movimentoId} nao existe`, 'movimento_inexistente');
  }
  return row;
}

/** Resumo calculado EXCLUSIVAMENTE a partir do ledger (F-08). */
function resumoDeMovimento(db, movimentoRow) {
  const { quantidade, soma } = db.prepare(SQL_RESUMO_ALOCACOES).get(movimentoRow.id);
  return montarResumo({
    movimentoId: movimentoRow.id,
    totalCentavos: movimentoRow.valor_centavos,
    quantidade,
    soma,
  });
}

/**
 * M-05: enquanto o movimento nao tiver associado, ele e um deposito NAO
 * IDENTIFICADO — pode existir, mas nao pode ser alocado. Identificar primeiro,
 * alocar depois.
 */
function exigirMovimentoAlocavel(movimentoRow) {
  if (movimentoRow.ativo !== 1) {
    throw new LedgerError(
      `movimento ${movimentoRow.id} esta inativo e nao recebe alocacao`,
      'movimento_inativo'
    );
  }
  if (movimentoRow.associado_id === null || movimentoRow.estado_identificacao === 'nao_identificado') {
    throw new LedgerError(
      `movimento ${movimentoRow.id} nao identificado nao pode receber alocacao`,
      'movimento_nao_identificado'
    );
  }
  return movimentoRow;
}

// --- escrita (sempre dentro de transacao) -----------------------------------

/**
 * Insere UMA alocacao. Pressupoe transacao aberta pelo chamador: a leitura da
 * soma ja alocada e a gravacao precisam acontecer sob o mesmo lock de escrita,
 * senao duas gravacoes concorrentes poderiam furar o teto do movimento.
 */
function inserirAlocacao(db, movimentoRow, entrada, ator) {
  const competencia = db.prepare(SQL_COMPETENCIA_POR_ID).get(entrada.competenciaId);
  if (competencia === undefined) {
    throw new LedgerError(`competencia ${entrada.competenciaId} nao existe`, 'competencia_inexistente');
  }

  const jaAlocadaNaCompetencia = db
    .prepare(SQL_ALOCACAO_ATIVA_NA_COMPETENCIA)
    .get(movimentoRow.id, entrada.competenciaId);
  if (jaAlocadaNaCompetencia !== undefined) {
    throw new LedgerError(
      `movimento ${movimentoRow.id} ja possui alocacao ativa na competencia ${rotuloCompetencia(competencia)}`,
      'alocacao_duplicada'
    );
  }

  const { soma: alocadoAntes } = db.prepare(SQL_RESUMO_ALOCACOES).get(movimentoRow.id);
  const alocadoDepois = alocadoAntes + entrada.valorCentavos;

  if (alocadoDepois > movimentoRow.valor_centavos) {
    throw new LedgerError(
      `alocacao de ${entrada.valorCentavos} centavos excede o saldo nao alocado do movimento ` +
        `${movimentoRow.id} (total ${movimentoRow.valor_centavos}, alocado ${alocadoAntes}, ` +
        `disponivel ${movimentoRow.valor_centavos - alocadoAntes})`,
      'alocacao_excede_movimento'
    );
  }

  const info = db
    .prepare(SQL_INSERT_ALOCACAO)
    .run(movimentoRow.id, entrada.competenciaId, entrada.valorCentavos, entrada.observacao);
  const alocacaoId = Number(info.lastInsertRowid);
  const alocacao = mapearAlocacao(db.prepare(SQL_ALOCACAO_POR_ID).get(alocacaoId));

  registrarAuditoria(db, {
    ator,
    acao: ACAO_ALOCACAO_CRIADA,
    entidadeTipo: 'alocacao',
    entidadeId: alocacaoId,
    estadoPosterior: alocacao,
    metadados: {
      origemRegistro: ORIGEM_REGISTRO,
      movimentoId: movimentoRow.id,
      competencia: rotuloCompetencia(competencia),
      totalCentavos: movimentoRow.valor_centavos,
      alocadoCentavos: alocadoDepois,
      naoAlocadoCentavos: movimentoRow.valor_centavos - alocadoDepois,
    },
  });

  return alocacao;
}

function validarEntradaAlocacao(entrada, indice = null) {
  const prefixo = indice === null ? '' : `alocacoes[${indice}].`;
  return {
    competenciaId: exigirId(entrada?.competenciaId, `${prefixo}competenciaId`),
    valorCentavos: exigirCentavos(entrada?.valorCentavos, `${prefixo}valorCentavos`),
    observacao: textoOpcional(entrada?.observacao, `${prefixo}observacao`),
  };
}

/**
 * Registra um movimento financeiro manual (F-03).
 *
 * Pode nascer sem nenhuma alocacao, com uma ou com varias: quando `alocacoes` e
 * informado, movimento + alocacoes + auditoria entram na MESMA transacao, entao
 * qualquer erro deixa o banco exatamente como estava (T-07).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} entrada
 * @param {string} entrada.data              data do movimento (YYYY-MM-DD)
 * @param {number} entrada.valorCentavos     valor em CENTAVOS inteiros positivos
 * @param {string} entrada.origem            'pagamento' | 'deposito'
 * @param {number|null} [entrada.associadoId] ausente => deposito nao identificado
 * @param {string|null} [entrada.observacao]
 * @param {Array<object>} [entrada.alocacoes] alocacoes criadas junto do movimento
 * @param {string} [entrada.ator]            ator tecnico gravado na auditoria
 */
function registrarMovimento(db, entrada = {}) {
  const data = exigirData(entrada.data);
  const valorCentavos = exigirCentavos(entrada.valorCentavos, 'valorCentavos');
  const origem = exigirOrigem(entrada.origem);
  const associadoId = idOpcional(entrada.associadoId, 'associadoId');
  const observacao = textoOpcional(entrada.observacao, 'observacao');
  const ator = exigirAtor(entrada.ator);

  const alocacoesBrutas = entrada.alocacoes ?? [];
  if (!Array.isArray(alocacoesBrutas)) {
    throw new LedgerError('alocacoes deve ser uma lista', 'campo_invalido');
  }
  const alocacoesEntrada = alocacoesBrutas.map((item, indice) => validarEntradaAlocacao(item, indice));

  // M-05: sem associado o movimento nasce NAO IDENTIFICADO.
  const estadoIdentificacao = associadoId === null ? 'nao_identificado' : 'identificado';

  return withTransaction(db, (conexao) => {
    if (associadoId !== null) {
      const associado = conexao.prepare(SQL_ASSOCIADO_POR_ID).get(associadoId);
      if (associado === undefined) {
        throw new LedgerError(`associado ${associadoId} nao existe`, 'associado_inexistente');
      }
    }

    const info = conexao
      .prepare(SQL_INSERT_MOVIMENTO)
      .run(data, valorCentavos, TIPO_ENTRADA, origem, associadoId, observacao, estadoIdentificacao);
    const movimentoRow = lerMovimento(conexao, Number(info.lastInsertRowid));
    const movimento = mapearMovimento(movimentoRow);

    registrarAuditoria(conexao, {
      ator,
      acao: ACAO_MOVIMENTO_CRIADO,
      entidadeTipo: 'movimento_financeiro',
      entidadeId: movimento.id,
      estadoPosterior: movimento,
      metadados: { origemRegistro: ORIGEM_REGISTRO, alocacoesNaCriacao: alocacoesEntrada.length },
    });

    const alocacoes = [];
    if (alocacoesEntrada.length > 0) {
      exigirMovimentoAlocavel(movimentoRow);
      for (const item of alocacoesEntrada) {
        alocacoes.push(inserirAlocacao(conexao, movimentoRow, item, ator));
      }
    }

    return { ...movimento, alocacoes, resumo: resumoDeMovimento(conexao, movimentoRow) };
  });
}

/**
 * Aloca parte (ou o todo) de um movimento em UMA competencia (M-02 / F-03).
 * Validacao e gravacao ocorrem na mesma transacao; a soma das alocacoes ativas
 * nunca pode ultrapassar o valor do movimento.
 */
function alocarMovimento(db, entrada = {}) {
  const movimentoId = exigirId(entrada.movimentoId, 'movimentoId');
  const dados = validarEntradaAlocacao(entrada);
  const ator = exigirAtor(entrada.ator);

  return withTransaction(db, (conexao) => {
    const movimentoRow = exigirMovimentoAlocavel(exigirMovimento(conexao, movimentoId));
    const alocacao = inserirAlocacao(conexao, movimentoRow, dados, ator);
    return { ...alocacao, resumo: resumoDeMovimento(conexao, movimentoRow) };
  });
}

/**
 * Identifica POSTERIORMENTE um movimento que nasceu sem associado (M-05 / F-06).
 *
 * E uma acao EXPLICITA do operador: o associado chega pelo `id` interno e por
 * mais nada. Nenhuma descoberta automatica participa — nem planilha, nem
 * centavos, nem nome, nem observacao, nem legacy_id.
 *
 * A operacao e estreita de proposito: so promove `nao_identificado` ->
 * `identificado`. Trocar o titular de um movimento ja identificado exige
 * semantica de correcao e historico proprios, e sera operacao separada; aqui
 * isso e recusado (`movimento_ja_identificado`), inclusive quando o associado
 * informado for o mesmo ja vinculado.
 *
 * Alteracao + auditoria entram na mesma transacao (T-07): se a auditoria falhar,
 * o movimento continua nao identificado e com `associado_id` NULL.
 *
 * Nao cria alocacao: identificar apenas torna o movimento elegivel para
 * `alocarMovimento`, cuja regra permanece onde ja estava.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} entrada
 * @param {number} entrada.movimentoId
 * @param {number} entrada.associadoId id interno do associado (nunca nome/legacy_id)
 * @param {string} entrada.motivo      razao da identificacao manual (obrigatoria)
 * @param {string} [entrada.ator]      ator tecnico gravado na auditoria
 */
function identificarMovimento(db, entrada = {}) {
  const movimentoId = exigirId(entrada.movimentoId, 'movimentoId');
  const associadoId = exigirId(entrada.associadoId, 'associadoId');
  const motivo = exigirMotivo(entrada.motivo);
  const ator = exigirAtor(entrada.ator);

  return withTransaction(db, (conexao) => {
    const anteriorRow = exigirMovimento(conexao, movimentoId);

    // M-09: movimento inativo nao e identificado nem reativado implicitamente.
    if (anteriorRow.ativo !== 1) {
      throw new LedgerError(
        `movimento ${movimentoId} esta inativo e nao pode ser identificado`,
        'movimento_inativo'
      );
    }

    // M-08: 'em_revisao' e uma ambiguidade declarada, nao um sinonimo de
    // 'nao_identificado'. Nao existe fluxo de revisao nesta fase.
    if (anteriorRow.estado_identificacao === 'em_revisao') {
      throw new LedgerError(
        `movimento ${movimentoId} esta em revisao e nao pode ser identificado nesta operacao`,
        'movimento_em_revisao'
      );
    }

    if (anteriorRow.associado_id !== null || anteriorRow.estado_identificacao === 'identificado') {
      throw new LedgerError(
        `movimento ${movimentoId} ja esta identificado (associado ${anteriorRow.associado_id}); ` +
          'troca de titularidade e uma operacao de correcao separada',
        'movimento_ja_identificado'
      );
    }

    const associado = conexao.prepare(SQL_ASSOCIADO_POR_ID).get(associadoId);
    if (associado === undefined) {
      throw new LedgerError(`associado ${associadoId} nao existe`, 'associado_inexistente');
    }

    const estadoAnterior = mapearMovimento(anteriorRow);

    const info = conexao.prepare(SQL_IDENTIFICAR_MOVIMENTO).run(associadoId, movimentoId);
    if (info.changes !== 1) {
      // Defensivo: as pre-condicoes acima ja rodaram sob o lock de escrita.
      throw new LedgerError(
        `movimento ${movimentoId} nao estava em estado identificavel no momento da gravacao`,
        'movimento_ja_identificado'
      );
    }

    const posteriorRow = lerMovimento(conexao, movimentoId);
    const estadoPosterior = mapearMovimento(posteriorRow);

    registrarAuditoria(conexao, {
      ator,
      acao: ACAO_MOVIMENTO_IDENTIFICADO,
      entidadeTipo: 'movimento_financeiro',
      entidadeId: movimentoId,
      estadoAnterior,
      estadoPosterior,
      metadados: {
        origemRegistro: ORIGEM_REGISTRO,
        movimentoId,
        associadoId,
        motivo,
        // Prova de que a decisao foi humana e explicita, nao inferida.
        criterio: 'associado informado explicitamente pelo operador',
      },
    });

    return {
      ...estadoPosterior,
      alocacoes: listarAlocacoesDoMovimento(conexao, movimentoId),
      resumo: resumoDeMovimento(conexao, posteriorRow),
    };
  });
}

/**
 * Inativa um movimento financeiro, preservando o historico (M-09 / F-11).
 *
 * E o UNICO caminho suportado para corrigir um lancamento errado: a linha
 * continua fisicamente no banco, com `ativo = 0`, `inativado_em` e
 * `motivo_inativacao`. Nao existe DELETE, nao existe edicao de valor e nao
 * existe reativacao — desfazer uma inativacao seria outra operacao, com trilha
 * propria, e nao esta implementada.
 *
 * SEM CASCATA, por decisao explicita: movimento com pelo menos uma alocacao
 * ATIVA e recusado (`movimento_possui_alocacoes_ativas`). Inativar o movimento
 * arrastando as alocacoes junto produziria varias correcoes financeiras com um
 * unico motivo e uma unica assinatura; cada alocacao errada precisa da propria
 * razao. O operador inativa as alocacoes primeiro e so entao o movimento.
 * Alocacoes JA inativas nao bloqueiam nada: elas sao historico.
 *
 * A operacao NAO e idempotente: inativar duas vezes e recusado com
 * `movimento_inativo`, entao a segunda tentativa nao mexe no timestamp, no
 * motivo ja gravado, nem produz uma segunda auditoria.
 *
 * Tudo em UMA transacao (T-07): leitura, validacao, UPDATE e `audit_log`. Se a
 * auditoria falhar, o ROLLBACK devolve o movimento ATIVO — nao existe
 * inativacao sem trilha.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} entrada
 * @param {number} entrada.movimentoId
 * @param {string} entrada.motivo  razao da correcao (obrigatoria, vai so para a
 *        auditoria e para `motivo_inativacao` — nunca para `observacao`)
 * @param {string} [entrada.ator]  ator tecnico gravado na auditoria
 * @returns {object} o movimento ja inativado, com `alocacoes` (as ATIVAS —
 *          necessariamente vazia, pela pre-condicao) e o `resumo` do ledger.
 * @throws {LedgerError} `id_invalido`, `motivo_obrigatorio`,
 *         `movimento_inexistente`, `movimento_inativo`,
 *         `movimento_possui_alocacoes_ativas`.
 */
function inativarMovimento(db, entrada = {}) {
  const movimentoId = exigirId(entrada.movimentoId, 'movimentoId');
  const motivo = exigirMotivo(entrada.motivo, 'a inativacao');
  const ator = exigirAtor(entrada.ator);

  return withTransaction(db, (conexao) => {
    const anteriorRow = exigirMovimento(conexao, movimentoId);

    if (anteriorRow.ativo !== 1) {
      throw new LedgerError(
        `movimento ${movimentoId} ja esta inativo desde ${anteriorRow.inativado_em}`,
        'movimento_inativo'
      );
    }

    const contagem = conexao.prepare(SQL_CONTAGEM_ALOCACOES).get(movimentoId);
    if (contagem.ativas > 0) {
      throw new LedgerError(
        `movimento ${movimentoId} possui ${contagem.ativas} alocacao(oes) ativa(s); ` +
          'inative cada alocacao com o proprio motivo antes de inativar o movimento',
        'movimento_possui_alocacoes_ativas'
      );
    }

    const estadoAnterior = mapearMovimentoComInativacao(anteriorRow);

    const info = conexao.prepare(SQL_INATIVAR_MOVIMENTO).run(motivo, movimentoId);
    if (info.changes !== 1) {
      // Defensivo: as pre-condicoes acima ja rodaram sob o lock de escrita.
      throw new LedgerError(
        `movimento ${movimentoId} nao estava em estado inativavel no momento da gravacao`,
        'movimento_inativo'
      );
    }

    const posteriorRow = lerMovimento(conexao, movimentoId);
    const estadoPosterior = mapearMovimentoComInativacao(posteriorRow);

    registrarAuditoria(conexao, {
      ator,
      acao: ACAO_MOVIMENTO_INATIVADO,
      entidadeTipo: 'movimento_financeiro',
      entidadeId: movimentoId,
      estadoAnterior,
      estadoPosterior,
      metadados: {
        origemRegistro: ORIGEM_REGISTRO,
        movimentoId,
        motivo,
        // M-09: nenhuma linha sumiu — as alocacoes continuam la, inativas.
        alocacoesPreservadas: contagem.total,
        alocacoesAtivas: contagem.ativas,
      },
    });

    return {
      ...estadoPosterior,
      alocacoes: listarAlocacoesDoMovimento(conexao, movimentoId),
      resumo: resumoDeMovimento(conexao, posteriorRow),
    };
  });
}

/**
 * Inativa UMA alocacao, preservando o historico (M-09 / M-02 / F-11).
 *
 * Corrige "este dinheiro foi alocado na competencia errada" sem apagar a
 * tentativa: `movimento_id`, `competencia_id`, `valor_centavos` e `observacao`
 * ficam intactos e a linha continua existindo. Como o indice parcial
 * `ux_alocacao_ativa` so enxerga `ativo = 1`, o mesmo par movimento+competencia
 * pode receber uma nova alocacao ativa depois desta operacao.
 *
 * O movimento NAO e tocado: valor, data, vinculo e estado de identificacao
 * permanecem. Inativar a ultima alocacao nao inativa o movimento — isso e uma
 * decisao separada, com o proprio motivo.
 *
 * Nao e idempotente: a segunda chamada e recusada com `alocacao_inativa` e nao
 * gera nova auditoria. UPDATE + `audit_log` na mesma transacao (T-07).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} entrada
 * @param {number} entrada.alocacaoId
 * @param {string} entrada.motivo  razao da correcao (obrigatoria)
 * @param {string} [entrada.ator]  ator tecnico gravado na auditoria
 * @returns {object} a alocacao ja inativada, com o `resumo` do movimento dono
 *          recalculado a partir do que restou ATIVO (F-08).
 * @throws {LedgerError} `id_invalido`, `motivo_obrigatorio`,
 *         `alocacao_inexistente`, `alocacao_inativa`.
 */
function inativarAlocacao(db, entrada = {}) {
  const alocacaoId = exigirId(entrada.alocacaoId, 'alocacaoId');
  const motivo = exigirMotivo(entrada.motivo, 'a inativacao');
  const ator = exigirAtor(entrada.ator);

  return withTransaction(db, (conexao) => {
    const anteriorRow = conexao.prepare(SQL_ALOCACAO_POR_ID).get(alocacaoId);
    if (anteriorRow === undefined) {
      throw new LedgerError(`alocacao ${alocacaoId} nao existe`, 'alocacao_inexistente');
    }

    if (anteriorRow.ativo !== 1) {
      throw new LedgerError(
        `alocacao ${alocacaoId} ja esta inativa desde ${anteriorRow.inativado_em}`,
        'alocacao_inativa'
      );
    }

    const estadoAnterior = mapearAlocacaoComInativacao(anteriorRow);
    const competencia = conexao.prepare(SQL_COMPETENCIA_POR_ID).get(anteriorRow.competencia_id);

    const info = conexao.prepare(SQL_INATIVAR_ALOCACAO).run(motivo, alocacaoId);
    if (info.changes !== 1) {
      // Defensivo: a pre-condicao acima ja rodou sob o lock de escrita.
      throw new LedgerError(
        `alocacao ${alocacaoId} nao estava em estado inativavel no momento da gravacao`,
        'alocacao_inativa'
      );
    }

    const estadoPosterior = mapearAlocacaoComInativacao(
      conexao.prepare(SQL_ALOCACAO_POR_ID).get(alocacaoId)
    );

    registrarAuditoria(conexao, {
      ator,
      acao: ACAO_ALOCACAO_INATIVADA,
      entidadeTipo: 'alocacao',
      entidadeId: alocacaoId,
      estadoAnterior,
      estadoPosterior,
      metadados: {
        origemRegistro: ORIGEM_REGISTRO,
        alocacaoId,
        movimentoId: anteriorRow.movimento_id,
        competencia: rotuloCompetencia(competencia),
        valorCentavos: anteriorRow.valor_centavos,
        motivo,
      },
    });

    const movimentoRow = lerMovimento(conexao, anteriorRow.movimento_id);
    return { ...estadoPosterior, resumo: resumoDeMovimento(conexao, movimentoRow) };
  });
}

/**
 * Registra um ajuste EXPLICITO de credito ou debito de um associado
 * (M-03 / F-04 / T-06 / T-07 / F-11).
 *
 * O que a operacao faz, e so isso: grava um evento estruturado dizendo que
 * alguem decidiu, com motivo, creditar ou debitar um valor de um associado, e
 * deixa a trilha correspondente em `audit_log`.
 *
 * O que ela deliberadamente NAO faz — nenhum destes pontos foi decidido, e
 * inferir qualquer um deles a partir de um ajuste seria inventar regra:
 *   * nao calcula saldo, total devido, total pago nem credito disponivel;
 *   * nao declara adimplencia ou inadimplencia (M-06 segue TO CONFIRM);
 *   * nao quita, compensa nem abate mensalidade de competencia alguma;
 *   * nao cria, altera ou inativa movimento, alocacao, competencia,
 *     comprovante ou pendencia;
 *   * nao le nem interpreta a planilha legada.
 * Um credito registrado aqui NAO significa "mensalidade paga", e um debito NAO
 * significa "associado inadimplente". Significa exatamente o que esta escrito
 * na linha: um ajuste, com motivo, numa data.
 *
 * T-06: `valorCentavos` e sempre um inteiro POSITIVO em centavos. O sinal
 * economico e expresso unicamente por `tipo`, entao valor negativo nunca chega
 * ao banco — o proprio CHECK do schema tambem o recusaria.
 *
 * `competenciaId` e OPCIONAL. Ausente significa apenas que o ajuste nao foi
 * amarrado a um mes especifico; nao significa credito geral, saldo, adiantamento
 * nem qualquer outra leitura. Quando informada, a competencia precisa existir:
 * nenhuma e criada automaticamente (M-10).
 *
 * T-07: validacao, INSERT e `audit_log` acontecem na MESMA transacao. Se a
 * auditoria falhar, o ROLLBACK nao deixa ajuste nenhum para tras — nao existe
 * criacao financeira sem trilha.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} entrada
 * @param {number} entrada.associadoId        id interno (nunca nome ou legacy_id)
 * @param {string} entrada.tipo               'credito' | 'debito'
 * @param {number} entrada.valorCentavos      centavos inteiros POSITIVOS
 * @param {string} entrada.motivo             razao do ajuste (obrigatoria)
 * @param {string} entrada.data               YYYY-MM-DD
 * @param {number|null} [entrada.competenciaId] competencia existente, se houver
 * @param {string|null} [entrada.observacao]  texto livre, preservado sem leitura
 * @param {string} [entrada.ator]             ator tecnico gravado na auditoria
 * @returns {object} o ajuste criado (ver `mapearAjuste`). Sem saldo, sem
 *          situacao financeira, sem agregado.
 * @throws {LedgerError} `id_invalido`, `tipo_ajuste_invalido`,
 *         `valor_nao_inteiro`, `valor_nao_positivo`, `motivo_obrigatorio`,
 *         `data_invalida`, `campo_invalido`, `associado_inexistente`,
 *         `competencia_inexistente`.
 */
function registrarAjuste(db, entrada = {}) {
  const associadoId = exigirId(entrada.associadoId, 'associadoId');
  const tipo = exigirTipoAjuste(entrada.tipo);
  const valorCentavos = exigirCentavos(entrada.valorCentavos, 'valorCentavos');
  const motivo = exigirMotivo(entrada.motivo, 'o ajuste');
  const data = exigirData(entrada.data);
  const competenciaId = idOpcional(entrada.competenciaId, 'competenciaId');
  const observacao = textoOpcional(entrada.observacao, 'observacao');
  const ator = exigirAtor(entrada.ator);

  return withTransaction(db, (conexao) => {
    const associado = conexao.prepare(SQL_ASSOCIADO_POR_ID).get(associadoId);
    if (associado === undefined) {
      throw new LedgerError(`associado ${associadoId} nao existe`, 'associado_inexistente');
    }

    // Lida so quando ha competencia: o rotulo AAAA-MM da auditoria sai daqui,
    // pelo helper ja existente, em vez de ser remontado a partir da entrada.
    let competencia = null;
    if (competenciaId !== null) {
      competencia = conexao.prepare(SQL_COMPETENCIA_POR_ID).get(competenciaId);
      if (competencia === undefined) {
        throw new LedgerError(`competencia ${competenciaId} nao existe`, 'competencia_inexistente');
      }
    }

    const info = conexao
      .prepare(SQL_INSERT_AJUSTE)
      .run(associadoId, tipo, valorCentavos, motivo, data, competenciaId, observacao);
    const ajusteId = Number(info.lastInsertRowid);

    // Relido do banco: `ativo`, `criado_em` e `atualizado_em` vem dos defaults do
    // schema, entao o objeto devolvido e auditado e o que EXISTE, nao o que foi
    // enviado.
    const ajuste = mapearAjuste(conexao.prepare(SQL_AJUSTE_POR_ID).get(ajusteId));

    registrarAuditoria(conexao, {
      ator,
      acao: ACAO_AJUSTE_CRIADO,
      entidadeTipo: 'ajuste_credito_debito',
      entidadeId: ajusteId,
      // Criacao: nao havia estado antes desta linha.
      estadoAnterior: null,
      estadoPosterior: ajuste,
      metadados: {
        origemRegistro: ORIGEM_REGISTRO,
        ajusteId,
        associadoId,
        tipo,
        valorCentavos,
        competenciaId,
        // Presente so quando ha competencia; `null` aqui e ausencia de vinculo,
        // nunca "competencia generica".
        competencia: competencia === null ? null : rotuloCompetencia(competencia),
      },
    });

    return ajuste;
  });
}

/**
 * Inativa um ajuste de credito/debito, preservando o historico (M-09 / F-11).
 *
 * E o UNICO caminho suportado para corrigir um ajuste registrado por engano — o
 * mesmo contrato ja aplicado a movimento e alocacao. A linha continua
 * fisicamente no banco, com `ativo = 0`, `inativado_em` e `motivo_inativacao`.
 * Nao existe DELETE, nao existe edicao e nao existe reativacao: desfazer uma
 * inativacao seria outra operacao, com trilha propria, e nao esta implementada.
 *
 * NADA de economico e recalculado. `tipo`, `valor_centavos`, `associado_id`,
 * `competencia_id`, `data`, `motivo` e `observacao` permanecem exatamente como
 * foram gravados (T-06): um debito inativado continua sendo um debito daquele
 * valor, so que sem efeito. O `motivo` original do ajuste NAO e sobrescrito —
 * `motivo_inativacao` e uma segunda informacao, nao uma correcao da primeira.
 *
 * A operacao NAO e idempotente: inativar duas vezes e recusado com
 * `ajuste_inativo`, entao a segunda tentativa nao mexe no timestamp, no motivo
 * ja gravado, nem produz uma segunda auditoria.
 *
 * NENHUM efeito colateral: nao cria ajuste oposto, nao estorna, nao compensa,
 * nao toca movimento nem alocacao, e nao produz saldo, quitacao ou adimplencia
 * (M-06 segue TO CONFIRM). Inativar e declarar que aquele evento nao vale mais.
 *
 * Tudo em UMA transacao (T-07): leitura, validacao, UPDATE e `audit_log`. Se a
 * auditoria falhar, o ROLLBACK devolve o ajuste ATIVO — nao existe inativacao
 * sem trilha.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} entrada
 * @param {number} entrada.ajusteId
 * @param {string} entrada.motivo  razao da correcao (obrigatoria, vai so para
 *        `motivo_inativacao` e para a auditoria — nunca para `motivo` nem para
 *        `observacao`)
 * @param {string} [entrada.ator]  ator tecnico gravado na auditoria
 * @returns {object} o ajuste ja inativado, relido do banco (ver `mapearAjuste`).
 * @throws {LedgerError} `id_invalido`, `motivo_obrigatorio`,
 *         `ajuste_inexistente`, `ajuste_inativo`.
 */
function inativarAjuste(db, entrada = {}) {
  const ajusteId = exigirId(entrada.ajusteId, 'ajusteId');
  const motivo = exigirMotivo(entrada.motivo, 'a inativacao');
  const ator = exigirAtor(entrada.ator);

  return withTransaction(db, (conexao) => {
    const anteriorRow = conexao.prepare(SQL_AJUSTE_POR_ID).get(ajusteId);
    if (anteriorRow === undefined) {
      throw new LedgerError(`ajuste ${ajusteId} nao existe`, 'ajuste_inexistente');
    }

    if (anteriorRow.ativo !== 1) {
      throw new LedgerError(
        `ajuste ${ajusteId} ja esta inativo desde ${anteriorRow.inativado_em}`,
        'ajuste_inativo'
      );
    }

    const estadoAnterior = mapearAjuste(anteriorRow);

    // Lida ANTES do UPDATE, so para o rotulo AAAA-MM da auditoria. A coluna
    // `competencia_id` nao e tocada pela inativacao.
    const competencia =
      anteriorRow.competencia_id === null
        ? null
        : conexao.prepare(SQL_COMPETENCIA_POR_ID).get(anteriorRow.competencia_id);

    const info = conexao.prepare(SQL_INATIVAR_AJUSTE).run(motivo, ajusteId);
    if (info.changes !== 1) {
      // Defensivo: a pre-condicao acima ja rodou sob o lock de escrita.
      throw new LedgerError(
        `ajuste ${ajusteId} nao estava em estado inativavel no momento da gravacao`,
        'ajuste_inativo'
      );
    }

    // Relido do banco: `inativado_em` e `atualizado_em` sao gerados pelo SQLite,
    // entao o estado posterior e o que EXISTE, nao um objeto remontado a mao.
    const estadoPosterior = mapearAjuste(conexao.prepare(SQL_AJUSTE_POR_ID).get(ajusteId));

    registrarAuditoria(conexao, {
      ator,
      acao: ACAO_AJUSTE_INATIVADO,
      entidadeTipo: 'ajuste_credito_debito',
      entidadeId: ajusteId,
      estadoAnterior,
      estadoPosterior,
      metadados: {
        origemRegistro: ORIGEM_REGISTRO,
        ajusteId,
        // Copiados do registro ORIGINAL: a auditoria prova o que foi desativado,
        // sem recalcular nada.
        associadoId: anteriorRow.associado_id,
        tipo: anteriorRow.tipo,
        valorCentavos: anteriorRow.valor_centavos,
        competenciaId: anteriorRow.competencia_id,
        competencia: competencia === null ? null : rotuloCompetencia(competencia),
        motivo,
      },
    });

    return estadoPosterior;
  });
}

/**
 * Movimento com suas alocacoes ativas e o resumo do ledger.
 * @returns {object|null} `null` quando o movimento nao existe.
 */
function obterMovimento(db, movimentoId) {
  const id = exigirId(movimentoId, 'movimentoId');
  const movimentoRow = lerMovimento(db, id);
  if (movimentoRow === undefined) return null;

  return {
    ...mapearMovimento(movimentoRow),
    alocacoes: listarAlocacoesDoMovimento(db, id),
    resumo: resumoDeMovimento(db, movimentoRow),
  };
}

/**
 * Fila paginada de movimentos NAO IDENTIFICADOS (F-06 / F-10).
 *
 * Consulta pura: nao grava, nao corrige estado e — por ser leitura — nao produz
 * `audit_log`. Devolve exatamente os movimentos que a operacao de identificacao
 * posterior (`identificarMovimento`) aceita: ativos, sem associado e com estado
 * `nao_identificado`. Movimento identificado, `em_revisao` ou inativo NAO
 * aparece, e nada aqui promove um estado a outro (M-08).
 *
 * Nenhum dado do legado participa: a fila e formada apenas pelas colunas do
 * proprio movimento. Nao ha leitura da camada bruta da planilha, busca por
 * associado, nem qualquer inferencia a partir dos centavos do valor.
 *
 * Ordenacao `data ASC, id ASC` — fila cronologica com desempate estavel, entao
 * paginar duas vezes o mesmo banco devolve sempre a mesma sequencia.
 *
 * `total` conta os elegiveis ANTES do LIMIT/OFFSET; pedir uma pagina alem do fim
 * devolve `itens` vazio sem alterar `total`. As duas consultas (COUNT e SELECT)
 * rodam em sequencia na mesma conexao sincrona, sem transacao de escrita: uma
 * leitura nao precisa — e nao deve — adquirir o lock de gravacao.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opcoes]
 * @param {number} [opcoes.limite] 1..200 (padrao 50)
 * @param {number} [opcoes.offset] >= 0 (padrao 0)
 * @returns {{itens: object[], paginacao: {limite: number, offset: number, total: number}}}
 */
function listarMovimentosNaoIdentificados(db, opcoes = {}) {
  const limite = exigirParametroDePagina(opcoes.limite, 'limite', {
    padrao: PAGINACAO.limitePadrao,
    minimo: PAGINACAO.limiteMinimo,
    maximo: PAGINACAO.limiteMaximo,
  });
  const offset = exigirParametroDePagina(opcoes.offset, 'offset', {
    padrao: PAGINACAO.offsetPadrao,
    minimo: PAGINACAO.offsetMinimo,
  });

  const { total } = db.prepare(SQL_CONTAR_NAO_IDENTIFICADOS).get();
  const itens = db.prepare(SQL_LISTAR_NAO_IDENTIFICADOS).all(limite, offset).map(mapearMovimento);

  return { itens, paginacao: { limite, offset, total } };
}

/**
 * Alocacoes do movimento. Por padrao apenas as ativas; as inativadas continuam
 * no banco (M-09) e podem ser listadas com `{ incluirInativas: true }`.
 */
function listarAlocacoesDoMovimento(db, movimentoId, { incluirInativas = false } = {}) {
  const id = exigirId(movimentoId, 'movimentoId');
  return db
    .prepare(SQL_ALOCACOES_DO_MOVIMENTO)
    .all(id)
    .filter((row) => incluirInativas || row.ativo === 1)
    .map(mapearAlocacao);
}

/**
 * Alocacoes dos movimentos informados, agrupadas por `movimentoId` e com a
 * competencia resolvida. Alocacoes INATIVADAS vem junto (M-09): quem exibe
 * decide como marca-las, mas o read model nao as omite.
 *
 * @returns {Map<number, object[]>} movimento sem alocacao simplesmente nao tem
 *          chave no mapa.
 */
function agruparAlocacoesComCompetencia(db, movimentoIds) {
  const placeholders = movimentoIds.map(() => '?').join(', ');
  const porMovimento = new Map();

  for (const row of db.prepare(sqlAlocacoesComCompetencia(placeholders)).all(...movimentoIds)) {
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
 * Valores permanecem em CENTAVOS INTEIROS (T-06); formatacao e assunto da view.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} associadoId id interno (nunca nome ou legacy_id)
 * @returns {object[]} vazio quando o associado nao tem movimento vinculado.
 * @throws {LedgerError} `id_invalido` quando `associadoId` nao e inteiro positivo.
 */
function listarMovimentosDoAssociado(db, associadoId) {
  const id = exigirId(associadoId, 'associadoId');

  const linhas = db.prepare(SQL_MOVIMENTOS_DO_ASSOCIADO).all(id);
  if (linhas.length === 0) return [];

  const alocacoes = agruparAlocacoesComCompetencia(
    db,
    linhas.map((row) => row.id)
  );

  // `...ComInativacao`: o extrato precisa PROVAR quando e por que um lancamento
  // deixou de valer, sem alterar o contrato base consumido pelas rotas JSON.
  return linhas.map((row) => ({
    ...mapearMovimentoComInativacao(row),
    alocacoes: alocacoes.get(row.id) ?? [],
  }));
}

/** Total, alocado e nao alocado do movimento — tudo em centavos inteiros (F-08). */
function calcularResumoDoMovimento(db, movimentoId) {
  const id = exigirId(movimentoId, 'movimentoId');
  return resumoDeMovimento(db, exigirMovimento(db, id));
}

module.exports = {
  registrarMovimento,
  obterMovimento,
  alocarMovimento,
  identificarMovimento,
  inativarMovimento,
  inativarAlocacao,
  registrarAjuste,
  inativarAjuste,
  listarMovimentosNaoIdentificados,
  listarMovimentosDoAssociado,
  listarAlocacoesDoMovimento,
  calcularResumoDoMovimento,
  LedgerError,
  ORIGENS_MANUAIS,
  TIPO_ENTRADA,
  ATOR_PADRAO,
  ESTADO_NAO_IDENTIFICADO,
  PAGINACAO,
  ACAO_MOVIMENTO_CRIADO,
  ACAO_ALOCACAO_CRIADA,
  ACAO_MOVIMENTO_IDENTIFICADO,
  ACAO_MOVIMENTO_INATIVADO,
  ACAO_ALOCACAO_INATIVADA,
  ACAO_AJUSTE_CRIADO,
  ACAO_AJUSTE_INATIVADO,
};
