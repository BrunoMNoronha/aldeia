'use strict';

// Contrato do ledger INDEPENDENTE de banco (ADR-003 / PG-2C1).
//
// Por que este arquivo existe: durante a migracao SQLite -> PostgreSQL as duas
// implementacoes de LEITURA convivem. Validacao, codigos de erro, forma dos
// objetos publicos e o rotulo de competencia sao os pontos onde uma divergencia
// silenciosa custaria caro — e so apareceria no cutover. Aqui essas regras sao
// UNICAS: `ledger.js` (SQLite) e `ledger-postgresql.js` consomem as mesmas, e a
// diferenca entre as trilhas fica restrita ao SQL e ao driver.
//
// Nada aqui conhece `better-sqlite3` ou `pg`. Nada aqui emite SQL.
//
// ESCOPO: apenas o que a leitura da PG-2C1 precisa. As regras exclusivas da
// ESCRITA (validacao de centavos, data, origem, tipo de ajuste, motivo, ator,
// auditoria) continuam em `ledger.js`, que segue sendo o runtime — mover tudo
// de uma vez seria refatorar o ledger inteiro no meio de uma migracao de banco.

const { PAGINACAO } = require('./paginacao');
const {
  normalizarInstante,
  normalizarDataCivil,
  normalizarBooleano,
} = require('./tipos-publicos');

/**
 * Erro de dominio do ledger.
 *
 * Classe UNICA para as duas trilhas: a camada web traduz `codigo` para status
 * HTTP, e dois erros diferentes com o mesmo nome quebrariam `instanceof` no
 * cutover.
 */
class LedgerError extends Error {
  constructor(message, codigo, options) {
    super(message, options);
    this.name = 'LedgerError';
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
    throw new LedgerError(
      `${campo} deve ser um id inteiro positivo (recebido: ${descrever(valor)})`,
      'id_invalido'
    );
  }
  return valor;
}

/** Mesma faixa e mesma recusa explicita nas duas trilhas. */
function exigirParametroDePagina(valor, campo, { padrao, minimo, maximo = null }) {
  if (valor === null || valor === undefined) return padrao;

  if (typeof valor !== 'number' || !Number.isSafeInteger(valor)) {
    throw new LedgerError(
      `${campo} deve ser um inteiro (recebido: ${descrever(valor)})`,
      'paginacao_invalida'
    );
  }
  if (valor < minimo || (maximo !== null && valor > maximo)) {
    const faixa = maximo === null ? `>= ${minimo}` : `entre ${minimo} e ${maximo}`;
    throw new LedgerError(`${campo} deve estar ${faixa} (recebido: ${valor})`, 'paginacao_invalida');
  }
  return valor;
}

/** Limite e offset de uma fila paginada, com a faixa unica de `./paginacao`. */
function exigirPaginacao({ limite, offset } = {}) {
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

// --- mapeamento linha -> objeto de dominio ----------------------------------
//
// Os mappers recebem linhas dos DOIS bancos. Por isso `ativo` passa por
// `normalizarBooleano` (0/1 ou false/true) e os instantes por
// `normalizarInstante` (texto ou `Date`): o objeto publico sai identico,
// independentemente de quem respondeu.

function mapearMovimento(row) {
  if (row === undefined || row === null) return null;
  return {
    id: row.id,
    data: normalizarDataCivil(row.data),
    valorCentavos: row.valor_centavos,
    tipo: row.tipo,
    origem: row.origem,
    associadoId: row.associado_id,
    observacao: row.observacao,
    estadoIdentificacao: row.estado_identificacao,
    ativo: normalizarBooleano(row.ativo),
    criadoEm: normalizarInstante(row.criado_em),
    atualizadoEm: normalizarInstante(row.atualizado_em),
  };
}

function mapearAlocacao(row) {
  if (row === undefined || row === null) return null;
  return {
    id: row.id,
    movimentoId: row.movimento_id,
    competenciaId: row.competencia_id,
    valorCentavos: row.valor_centavos,
    observacao: row.observacao,
    ativo: normalizarBooleano(row.ativo),
    criadoEm: normalizarInstante(row.criado_em),
    atualizadoEm: normalizarInstante(row.atualizado_em),
  };
}

/**
 * Movimento COM a trilha de inativacao (M-09).
 *
 * Os campos vivem num mapper separado de proposito: o contrato ja consumido
 * pelas rotas JSON de criacao/alocacao continua exatamente como estava, e quem
 * precisa provar a inativacao — auditoria e extrato individual — pede esta
 * versao explicitamente.
 */
function mapearMovimentoComInativacao(row) {
  if (row === undefined || row === null) return null;
  return {
    ...mapearMovimento(row),
    inativadoEm: normalizarInstante(row.inativado_em),
    motivoInativacao: row.motivo_inativacao,
  };
}

/** Alocacao COM a trilha de inativacao — mesma razao do mapper acima. */
function mapearAlocacaoComInativacao(row) {
  if (row === undefined || row === null) return null;
  return {
    ...mapearAlocacao(row),
    inativadoEm: normalizarInstante(row.inativado_em),
    motivoInativacao: row.motivo_inativacao,
  };
}

/** Competencia como a UI a le: 'AAAA-MM', com o mes sempre em dois digitos. */
function rotuloCompetencia(competencia) {
  return `${competencia.ano}-${String(competencia.mes).padStart(2, '0')}`;
}

/**
 * Resumo do movimento a partir do ledger (F-08), com os valores JA lidos.
 *
 * Nao consulta banco: recebe o valor do movimento e o par
 * quantidade/soma das alocacoes ATIVAS, e devolve o objeto publico. Assim a
 * aritmetica — a parte que nao pode divergir entre as trilhas — e a mesma nas
 * duas, e cada trilha so decide COMO obtem os numeros.
 *
 * Nada aqui compara com valor esperado de competencia, deduz quitacao,
 * adimplencia ou saldo: C-03/M-06 seguem sem inferencia automatica.
 *
 * @param {{movimentoId: number, totalCentavos: number, quantidade: number, soma: number}} dados
 */
function montarResumo({ movimentoId, totalCentavos, quantidade, soma }) {
  return {
    movimentoId,
    totalCentavos,
    alocadoCentavos: soma,
    naoAlocadoCentavos: totalCentavos - soma,
    quantidadeAlocacoes: quantidade,
    integralmenteAlocado: soma === totalCentavos,
  };
}

module.exports = {
  LedgerError,
  descrever,
  exigirId,
  exigirParametroDePagina,
  exigirPaginacao,
  normalizarInstante,
  normalizarDataCivil,
  normalizarBooleano,
  mapearMovimento,
  mapearAlocacao,
  mapearMovimentoComInativacao,
  mapearAlocacaoComInativacao,
  rotuloCompetencia,
  montarResumo,
};
