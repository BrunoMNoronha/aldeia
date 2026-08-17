'use strict';

// Vocabulario estruturado do dominio, espelhando os CHECK constraints da
// migration 001. Manter os dois lados em sincronia ao criar novas migrations.
//
// ATENCAO: nada aqui interpreta os codigos legados ('a', 'i', 'DESLIGADO', ...)
// nem define situacao financeira. Esses pontos seguem TO CONFIRM (M-06).

const STATUS_CADASTRAL = Object.freeze(['ativo', 'inativo', 'desligado', 'indefinido']);

const TIPO_MOVIMENTO = Object.freeze(['credito', 'debito']);

const ESTADO_IDENTIFICACAO = Object.freeze(['identificado', 'nao_identificado', 'em_revisao']);

const TIPO_AJUSTE = Object.freeze(['credito', 'debito']);

const ESTADO_COMPROVANTE = Object.freeze(['presente', 'ausente', 'pendente', 'nao_aplicavel']);

const PRIORIDADE_PENDENCIA = Object.freeze(['baixa', 'media', 'alta']);

const ESTADO_PENDENCIA = Object.freeze(['aberta', 'em_analise', 'resolvida', 'descartada']);

const STATUS_IMPORTACAO = Object.freeze(['pendente', 'concluida', 'falhou', 'revertida']);

const ESTADO_REVISAO_CELULA = Object.freeze(['nao_revisado', 'revisado', 'ambiguo', 'descartado']);

const ENTIDADES_LEGACY_LINK = Object.freeze([
  'associado',
  'competencia',
  'movimento_financeiro',
  'alocacao',
  'ajuste_credito_debito',
  'comprovante',
  'pendencia',
]);

module.exports = {
  STATUS_CADASTRAL,
  TIPO_MOVIMENTO,
  ESTADO_IDENTIFICACAO,
  TIPO_AJUSTE,
  ESTADO_COMPROVANTE,
  PRIORIDADE_PENDENCIA,
  ESTADO_PENDENCIA,
  STATUS_IMPORTACAO,
  ESTADO_REVISAO_CELULA,
  ENTIDADES_LEGACY_LINK,
};
