'use strict';

// Contrato de comprovante INDEPENDENTE de banco (M-04 / F-05 / F-10).
//
// Por que este arquivo existe (ADR-003 / PG-2B1):
//   durante a migracao SQLite -> PostgreSQL as duas implementacoes de leitura
//   convivem. Validacao, vocabulario de estados, forma da evidencia e mapeamento
//   publico sao os pontos onde uma divergencia silenciosa entre as trilhas
//   custaria caro — e so apareceria no cutover. Aqui essas regras sao UNICAS:
//   `comprovantes.js` (SQLite) e `comprovantes-postgresql.js` consomem as
//   mesmas, e a diferenca entre as duas fica restrita ao SQL e ao driver.
//
// Nada aqui conhece `better-sqlite3` ou `pg`. Nada aqui emite SQL.
//
// As duas regras que estruturam tudo o que segue continuam valendo:
//
//   1. A SITUACAO OFICIAL DO COMPROVANTE E O CAMPO `estado`, NUNCA O TEXTO.
//      `observacao` e contexto humano, preservada verbatim; nada aqui a le,
//      procura palavra-chave ou deduz estado a partir dela.
//
//   2. AUSENCIA DE REGISTRO NAO E 'ausente'.
//      "Ninguem ainda disse nada sobre o comprovante deste movimento" e "alguem
//      verificou e declarou que o comprovante NAO existe" sao fatos diferentes.
//      O primeiro e o estado TECNICO `sem_registro`; o segundo e o estado de
//      dominio 'ausente'. Somente o segundo entra na fila de pendencia.

const { ESTADO_COMPROVANTE } = require('../domain/constants');
const { PAGINACAO } = require('./paginacao');

/**
 * Vocabulario dos quatro estados, vindo de `domain/constants` — que por sua vez
 * espelha o CHECK das migrations. Nao ha segunda lista neste projeto.
 */
const ESTADOS = ESTADO_COMPROVANTE;

/**
 * Estado TECNICO de quem nao tem linha em `comprovante`. Nao e um estado de
 * dominio: nao existe no banco, nao pode ser enviado numa gravacao e nao entra
 * na fila de pendencia. Existe para que a ausencia de dado seja NOMEADA em vez
 * de virar 'ausente' por omissao.
 */
const SEM_REGISTRO = 'sem_registro';

/**
 * F-05 / F-10: os estados que significam "esta evidencia ainda precisa de
 * acompanhamento". 'presente' esta resolvido e 'nao_aplicavel' foi decidido —
 * nenhum dos dois e pendencia.
 */
const ESTADOS_PENDENTES = Object.freeze(['pendente', 'ausente']);

/**
 * Erro de dominio do comprovante.
 *
 * Classe UNICA para as duas trilhas: a camada web traduz `codigo` para status
 * HTTP, e dois erros diferentes com o mesmo nome quebrariam `instanceof` no
 * cutover.
 */
class ComprovanteError extends Error {
  constructor(message, codigo, options) {
    super(message, options);
    this.name = 'ComprovanteError';
    this.codigo = codigo;
  }
}

// --- validacao de entrada ---------------------------------------------------

function descrever(valor) {
  if (typeof valor === 'string') return `string ${JSON.stringify(valor)}`;
  return `${typeof valor} ${String(valor)}`;
}

function exigirId(valor, campo) {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor <= 0) {
    throw new ComprovanteError(
      `${campo} deve ser um id inteiro positivo (recebido: ${descrever(valor)})`,
      'id_invalido'
    );
  }
  return valor;
}

function textoOpcional(valor, campo) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor !== 'string') {
    throw new ComprovanteError(
      `${campo} deve ser texto (recebido: ${descrever(valor)})`,
      'campo_invalido'
    );
  }
  const texto = valor.trim();
  return texto === '' ? null : texto;
}

/**
 * M-04: o estado e vocabulario ESTRUTURADO e fechado. `trim().toLowerCase()`
 * uniformiza a CAIXA da palavra, jamais traduz significado.
 *
 * Continuam RECUSADOS, porque interpreta-los seria inventar regra: 'OK',
 * 'nao aplicavel' (com espaco), 'N/A', 'sim', 'nao', 'sem_registro' (estado
 * tecnico, nao de dominio), vazio, `null` e qualquer outro valor fora da lista.
 */
function exigirEstado(valor) {
  const estado = typeof valor === 'string' ? valor.trim().toLowerCase() : '';
  if (!ESTADOS.includes(estado)) {
    throw new ComprovanteError(
      `estado deve ser um de: ${ESTADOS.join(', ')} (recebido: ${descrever(valor)})`,
      'estado_comprovante_invalido'
    );
  }
  return estado;
}

/** Mesma faixa e mesma recusa explicita da paginacao ja usada pelo ledger. */
function exigirParametroDePagina(valor, campo, { padrao, minimo, maximo = null }) {
  if (valor === null || valor === undefined) return padrao;

  if (typeof valor !== 'number' || !Number.isSafeInteger(valor)) {
    throw new ComprovanteError(
      `${campo} deve ser um inteiro (recebido: ${descrever(valor)})`,
      'paginacao_invalida'
    );
  }
  if (valor < minimo || (maximo !== null && valor > maximo)) {
    const faixa = maximo === null ? `>= ${minimo}` : `entre ${minimo} e ${maximo}`;
    throw new ComprovanteError(
      `${campo} deve estar ${faixa} (recebido: ${valor})`,
      'paginacao_invalida'
    );
  }
  return valor;
}

/**
 * Filtro OPCIONAL da fila. Ausente = os dois estados pendentes. Presente,
 * precisa ser um estado que a fila realmente serve: pedir 'presente' aqui seria
 * pedir uma pendencia que nao existe, e isso e recusado em vez de devolver
 * lista vazia (que seria lida como "nao ha nada pendente").
 */
function exigirEstadoPendente(valor) {
  if (valor === null || valor === undefined) return [...ESTADOS_PENDENTES];

  const estado = exigirEstado(valor);
  if (!ESTADOS_PENDENTES.includes(estado)) {
    throw new ComprovanteError(
      `a fila de pendencia de comprovante serve apenas: ${ESTADOS_PENDENTES.join(', ')} ` +
        `(recebido: ${descrever(valor)})`,
      'estado_comprovante_invalido'
    );
  }
  return [estado];
}

/** Limite e offset da fila, com a faixa unica de `./paginacao`. */
function exigirPaginacao({ limite, offset }) {
  return {
    limite: exigirParametroDePagina(limite, 'limite', {
      padrao: PAGINACAO.limitePadrao,
      minimo: PAGINACAO.limiteMinimo,
      maximo: PAGINACAO.limiteMaximo,
    }),
    offset: exigirParametroDePagina(offset, 'offset', {
      padrao: PAGINACAO.offsetPadrao,
      minimo: PAGINACAO.offsetMinimo,
    }),
  };
}

// --- normalizacao de transporte ----------------------------------------------

/**
 * Instante de auditoria como texto UTC, com precisao de SEGUNDO.
 *
 * As duas trilhas guardam o mesmo FATO em tipos diferentes: o SQLite guarda TEXT
 * gerado por `strftime('%Y-%m-%dT%H:%M:%SZ','now')` e o PostgreSQL guarda
 * TIMESTAMPTZ, que o driver `pg` entrega como `Date`.
 *
 * `toISOString()` sozinho NAO resolve: ele produz `.000Z` (milissegundos), e o
 * contrato observavel hoje — verificado nos testes do SQLite — e
 * `YYYY-MM-DDTHH:MM:SSZ`, sem fracao. Deixar a diferenca passar faria o cutover
 * mudar o formato de todo timestamp publico sem ninguem pedir. Truncamos a
 * fracao para que as duas trilhas devolvam a MESMA string.
 *
 * Isto e conversao de TRANSPORTE, nao regra de dominio: o instante nao muda,
 * apenas a serializacao. A precisao completa continua no banco.
 *
 * @param {unknown} valor
 * @returns {string | null}
 */
function normalizarInstante(valor) {
  if (valor === undefined || valor === null) return null;
  if (valor instanceof Date) return `${valor.toISOString().slice(0, 19)}Z`;
  return valor;
}

/**
 * Data CIVIL (`comprovante.data`, `movimento_financeiro.data`).
 *
 * Nao ha conversao de fuso aqui, e isso e o ponto: o PostgreSQL entrega `DATE`
 * como texto 'YYYY-MM-DD' (parser instalado em `src/db/postgresql/connection.js`)
 * e o SQLite ja guarda o mesmo texto. Promover uma data civil a instante pode
 * move-la de dia, de mes e portanto de competencia (M-10).
 *
 * @param {unknown} valor
 * @returns {string | null}
 */
function normalizarDataCivil(valor) {
  if (valor === undefined || valor === null) return null;
  return valor;
}

/**
 * `ativo` como booleano no contrato publico.
 *
 * O SQLite guarda 0/1 (nao tem booleano) e o PostgreSQL guarda BOOLEAN. Sem esta
 * normalizacao uma trilha devolveria `1` e a outra `true` no MESMO campo.
 *
 * @param {unknown} valor
 * @returns {boolean}
 */
function normalizarBooleano(valor) {
  return valor === true || valor === 1;
}

// --- mapeamento linha -> objeto de dominio ----------------------------------

function mapearComprovante(row) {
  if (row === undefined || row === null) return null;
  return {
    id: row.id,
    movimentoId: row.movimento_id,
    estado: row.estado,
    observacao: row.observacao,
    // Reservadas para o futuro (C-06). Vao no retorno para que o consumidor veja
    // que existem e estao vazias, em vez de supor que foram preenchidas.
    // NENHUM significado novo e atribuido a elas aqui.
    referenciaExterna: row.referencia_externa,
    data: normalizarDataCivil(row.data),
    criadoEm: normalizarInstante(row.criado_em),
    atualizadoEm: normalizarInstante(row.atualizado_em),
  };
}

/**
 * Evidencia de UM movimento, na forma em que servico, API e tela a consomem.
 *
 * `estado` e `estadoTecnico` sao campos diferentes de proposito:
 *   estado        -> o estado de DOMINIO, ou `null` quando nao ha registro;
 *   estadoTecnico -> sempre preenchido, valendo `sem_registro` quando nao ha
 *                    linha. Assim nenhum consumidor precisa escolher entre
 *                    "null" e "ausente" — a diferenca esta escrita.
 */
function evidenciaRegistrada(movimentoId, registro) {
  return {
    movimentoId,
    registrado: true,
    estado: registro.estado,
    estadoTecnico: registro.estado,
    pendenteDeEvidencia: ESTADOS_PENDENTES.includes(registro.estado),
    observacao: registro.observacao,
    registro,
  };
}

/**
 * M-04: sem linha em `comprovante` o movimento nao esta 'ausente' — nao ha
 * declaracao alguma sobre ele. `pendenteDeEvidencia` e `false` porque pendencia
 * e algo DECLARADO, nunca deduzido de um vazio.
 */
function evidenciaSemRegistro(movimentoId) {
  return {
    movimentoId,
    registrado: false,
    estado: null,
    estadoTecnico: SEM_REGISTRO,
    pendenteDeEvidencia: false,
    observacao: null,
    registro: null,
  };
}

function evidenciaDaLinha(movimentoId, row) {
  return row === undefined || row === null
    ? evidenciaSemRegistro(movimentoId)
    : evidenciaRegistrada(movimentoId, mapearComprovante(row));
}

/**
 * Item da fila de pendencia, a partir da linha do JOIN comprovante x movimento.
 *
 * O movimento vai junto para que a fila seja operavel sem uma segunda consulta.
 * Valor continua em CENTAVOS INTEIROS (T-06) e nada aqui soma, compara ou
 * classifica situacao financeira.
 */
function mapearItemDaFila(row) {
  return {
    comprovanteId: row.comprovante_id,
    movimentoId: row.movimento_id,
    estado: row.estado,
    observacao: row.observacao,
    criadoEm: normalizarInstante(row.criado_em),
    atualizadoEm: normalizarInstante(row.atualizado_em),
    movimento: {
      id: row.movimento_id,
      data: normalizarDataCivil(row.movimento_data),
      valorCentavos: row.movimento_valor_centavos,
      associadoId: row.movimento_associado_id,
      estadoIdentificacao: row.movimento_estado_identificacao,
      ativo: normalizarBooleano(row.movimento_ativo),
    },
  };
}

module.exports = {
  ESTADOS,
  ESTADOS_PENDENTES,
  SEM_REGISTRO,
  ComprovanteError,
  descrever,
  exigirId,
  textoOpcional,
  exigirEstado,
  exigirEstadoPendente,
  exigirParametroDePagina,
  exigirPaginacao,
  normalizarInstante,
  normalizarDataCivil,
  normalizarBooleano,
  mapearComprovante,
  evidenciaRegistrada,
  evidenciaSemRegistro,
  evidenciaDaLinha,
  mapearItemDaFila,
};
