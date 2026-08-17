'use strict';

const express = require('express');

const { getDatabase } = require('../db/connection');
const { verificarSaude } = require('../db/health');
const ledger = require('../services/ledger');
const comprovantes = require('../services/comprovantes');
const associadosRouter = require('./routes/associados');

/**
 * Traducao codigo de dominio -> status HTTP.
 * As REGRAS financeiras ficam no servico; aqui so ha transporte.
 */
const STATUS_POR_CODIGO = Object.freeze({
  valor_nao_inteiro: 422,
  valor_nao_positivo: 422,
  data_invalida: 422,
  origem_invalida: 422,
  id_invalido: 422,
  campo_invalido: 422,
  associado_inexistente: 422,
  competencia_inexistente: 422,
  motivo_obrigatorio: 422,
  tipo_ajuste_invalido: 422,
  paginacao_invalida: 422,
  estado_nao_suportado: 422,
  // Fase 4A: estado de comprovante fora do vocabulario dos quatro estados.
  estado_comprovante_invalido: 422,
  movimento_inexistente: 404,
  movimento_inativo: 409,
  movimento_nao_identificado: 409,
  movimento_ja_identificado: 409,
  movimento_em_revisao: 409,
  alocacao_duplicada: 409,
  alocacao_excede_movimento: 409,
  alocacao_inexistente: 404,
  alocacao_inativa: 409,
  ajuste_inexistente: 404,
  ajuste_inativo: 409,
  movimento_possui_alocacoes_ativas: 409,
});

/**
 * Tabela do POST /api/ajustes. Mesmo VOCABULARIO de codigos — nenhum codigo novo
 * e inventado —, com dois status proprios desta rota:
 *
 *   associado_inexistente   -> 404
 *   competencia_inexistente -> 404
 *
 * No ajuste, associado e competencia sao RECURSOS referenciados por id: pedir um
 * id que nao existe e "nao encontrado", nao "corpo malformado". As rotas de
 * movimento continuam devolvendo 422 para os mesmos codigos, como sempre
 * devolveram: mudar aquele contrato ja publicado nao pertence a esta fase.
 */
const STATUS_POR_CODIGO_AJUSTE = Object.freeze({
  ...STATUS_POR_CODIGO,
  associado_inexistente: 404,
  competencia_inexistente: 404,
});

/**
 * Erro de DOMINIO (tem `codigo` e vira resposta 4xx). Cada servico tem a propria
 * classe — comprovante nao e ledger —, mas o contrato de transporte e o mesmo, e
 * por isso a traducao para HTTP continua num unico lugar.
 */
function ehErroDeDominio(error) {
  return error instanceof ledger.LedgerError || error instanceof comprovantes.ComprovanteError;
}

function responderErro(res, error, next, statusPorCodigo = STATUS_POR_CODIGO) {
  if (!ehErroDeDominio(error)) return next(error);
  const status = statusPorCodigo[error.codigo] ?? 422;
  return res.status(status).json({ status: 'erro', codigo: error.codigo, erro: error.message });
}

/** `:id` da rota so vira numero quando for realmente um inteiro positivo. */
function idDaRota(valor) {
  return /^\d+$/.test(valor) ? Number(valor) : valor;
}

/**
 * Query string e sempre texto: converte SO o que ja e um inteiro decimal.
 * Qualquer outra coisa ('abc', '1.5', '-1', ' 2 ') segue INTACTA para o servico,
 * que decide recusar — a faixa valida e regra de dominio, nao de transporte.
 */
function numeroDaQuery(valor) {
  if (valor === undefined) return undefined;
  return /^\d+$/.test(valor) ? Number(valor) : valor;
}

/**
 * Cria a aplicacao Express.
 *
 * @param {object} [options]
 * @param {import('better-sqlite3').Database} [options.db] conexao a usar
 *        (os testes injetam um banco temporario).
 */
function createApp({ db = null } = {}) {
  const app = express();
  const resolveDb = () => (db !== null ? db : getDatabase());

  app.disable('x-powered-by');
  app.use(express.json());

  // Health check: prova que a aplicacao web esta de pe e que o SQLite responde.
  // A sonda mora em `src/db/health.js` porque durante a migracao (NX-0) o mesmo
  // contrato tambem e servido pelo Route Handler `app/health/route.js`: um unico
  // lugar decide o que /health responde, nos dois transportes.
  app.get('/health', (req, res) => {
    const { saudavel, corpo } = verificarSaude(resolveDb);
    return res.status(saudavel ? 200 : 503).json(corpo);
  });

  // --- ledger financeiro (Fase 2A) -----------------------------------------
  // Nenhuma regra financeira mora nestas rotas: validacao, transacao e
  // auditoria sao responsabilidade de src/services/ledger.js.

  app.post('/api/movimentos', (req, res, next) => {
    try {
      const movimento = ledger.registrarMovimento(resolveDb(), req.body ?? {});
      return res.status(201).json({ status: 'ok', movimento });
    } catch (error) {
      return responderErro(res, error, next);
    }
  });

  // Fila operacional de movimentos nao identificados (F-06 / F-10).
  // Leitura pura: nao grava, nao corrige estado e nao gera auditoria.
  // `estado` e OBRIGATORIO e a rota so serve o valor que sabe servir: qualquer
  // outro ('em_revisao', 'identificado', vazio...) e recusado explicitamente,
  // nunca reinterpretado como a fila (M-08).
  app.get('/api/movimentos', (req, res, next) => {
    const estado = req.query.estado;
    if (estado !== ledger.ESTADO_NAO_IDENTIFICADO) {
      return res.status(422).json({
        status: 'erro',
        codigo: 'estado_nao_suportado',
        erro:
          `estado deve ser '${ledger.ESTADO_NAO_IDENTIFICADO}': esta rota serve apenas a fila ` +
          'de movimentos nao identificados',
      });
    }

    try {
      const resultado = ledger.listarMovimentosNaoIdentificados(resolveDb(), {
        limite: numeroDaQuery(req.query.limite),
        offset: numeroDaQuery(req.query.offset),
      });
      return res.json({ status: 'ok', ...resultado });
    } catch (error) {
      return responderErro(res, error, next);
    }
  });

  app.get('/api/movimentos/:id', (req, res, next) => {
    try {
      const movimento = ledger.obterMovimento(resolveDb(), idDaRota(req.params.id));
      if (movimento === null) {
        return res.status(404).json({ status: 'erro', codigo: 'movimento_inexistente', erro: 'movimento nao existe' });
      }
      return res.json({ status: 'ok', movimento });
    } catch (error) {
      return responderErro(res, error, next);
    }
  });

  app.post('/api/movimentos/:id/alocacoes', (req, res, next) => {
    try {
      const alocacao = ledger.alocarMovimento(resolveDb(), {
        ...(req.body ?? {}),
        movimentoId: idDaRota(req.params.id),
      });
      return res.status(201).json({ status: 'ok', alocacao });
    } catch (error) {
      return responderErro(res, error, next);
    }
  });

  // Identificacao posterior de deposito nao identificado (M-05 / F-06).
  // O associado vem SEMPRE do corpo, explicito: a rota nao pesquisa ninguem.
  app.post('/api/movimentos/:id/identificacao', (req, res, next) => {
    try {
      const movimento = ledger.identificarMovimento(resolveDb(), {
        ...(req.body ?? {}),
        movimentoId: idDaRota(req.params.id),
      });
      return res.status(200).json({ status: 'ok', movimento });
    } catch (error) {
      return responderErro(res, error, next);
    }
  });

  // Inativacao auditavel de movimento (M-09 / F-11). Correcao NUNCA e DELETE:
  // a rota so encomenda a inativacao; regra, transacao e auditoria ficam no
  // servico. Recusar movimento com alocacao ativa e decisao de dominio, e por
  // isso chega aqui apenas como `movimento_possui_alocacoes_ativas` (409).
  app.post('/api/movimentos/:id/inativacao', (req, res, next) => {
    try {
      const movimento = ledger.inativarMovimento(resolveDb(), {
        ...(req.body ?? {}),
        movimentoId: idDaRota(req.params.id),
      });
      return res.status(200).json({ status: 'ok', movimento });
    } catch (error) {
      return responderErro(res, error, next);
    }
  });

  // Inativacao auditavel de alocacao (M-09 / F-11). A alocacao continua no
  // banco; o par movimento+competencia volta a aceitar uma alocacao ativa.
  app.post('/api/alocacoes/:id/inativacao', (req, res, next) => {
    try {
      const alocacao = ledger.inativarAlocacao(resolveDb(), {
        ...(req.body ?? {}),
        alocacaoId: idDaRota(req.params.id),
      });
      return res.status(200).json({ status: 'ok', alocacao });
    } catch (error) {
      return responderErro(res, error, next);
    }
  });

  // Ajuste explicito de credito/debito (M-03 / F-04). Rota FINA: o corpo vai
  // inteiro para o servico, que valida, transaciona e audita. A rota nao decide
  // sinal, nao converte moeda, nao interpreta `tipo` e nao calcula saldo —
  // registrar um credito aqui nao quita nada.
  app.post('/api/ajustes', (req, res, next) => {
    try {
      const ajuste = ledger.registrarAjuste(resolveDb(), req.body ?? {});
      return res.status(201).json({ status: 'ok', ajuste });
    } catch (error) {
      return responderErro(res, error, next, STATUS_POR_CODIGO_AJUSTE);
    }
  });

  // Inativacao auditavel de ajuste (M-09 / F-11). Fecha o ciclo de correcao das
  // tres entidades financeiras. Correcao NUNCA e DELETE: o ajuste continua no
  // banco, com quando e por que deixou de valer, e nenhum ajuste oposto e criado
  // automaticamente. Regra, transacao e auditoria ficam no servico.
  app.post('/api/ajustes/:id/inativacao', (req, res, next) => {
    try {
      const ajuste = ledger.inativarAjuste(resolveDb(), {
        ...(req.body ?? {}),
        ajusteId: idDaRota(req.params.id),
      });
      return res.status(200).json({ status: 'ok', ajuste });
    } catch (error) {
      return responderErro(res, error, next, STATUS_POR_CODIGO_AJUSTE);
    }
  });

  // --- comprovantes: estado da evidencia (Fase 4A) --------------------------
  // M-04 / F-05 / F-10 / F-11. Rotas FINAS: validacao, transacao e auditoria
  // ficam em src/services/comprovantes.js. Nenhuma delas cria, altera ou
  // inativa movimento, alocacao ou ajuste, e nenhuma armazena arquivo — C-06
  // (armazenamento de comprovante) segue TO CONFIRM.

  // Estado atual do comprovante de um movimento. Leitura pura.
  // Sem registro NAO e 'ausente': a resposta traz `registrado: false` e
  // `estadoTecnico: 'sem_registro'`, com `estado: null`.
  app.get('/api/movimentos/:id/comprovante', (req, res, next) => {
    try {
      const comprovante = comprovantes.obterComprovanteDoMovimento(
        resolveDb(),
        idDaRota(req.params.id)
      );
      return res.json({ status: 'ok', comprovante });
    } catch (error) {
      return responderErro(res, error, next);
    }
  });

  // Registra ou altera o estado do comprovante. PUT porque a operacao e
  // idempotente por natureza: o mesmo corpo enviado duas vezes deixa o sistema
  // no mesmo estado. Sempre 200 — `comprovante.alteracao` diz o que aconteceu
  // ('registrado' | 'alterado' | 'sem_mudanca').
  app.put('/api/movimentos/:id/comprovante', (req, res, next) => {
    try {
      const comprovante = comprovantes.definirComprovanteDoMovimento(resolveDb(), {
        ...(req.body ?? {}),
        movimentoId: idDaRota(req.params.id),
      });
      return res.status(200).json({ status: 'ok', comprovante });
    } catch (error) {
      return responderErro(res, error, next);
    }
  });

  // Fila de pendencia de EVIDENCIA (F-05 / F-10): somente os movimentos com
  // comprovante declarado 'pendente' ou 'ausente'. Nao inclui deposito nao
  // identificado nem ambiguidade do legado — cada pendencia tem sua fila.
  app.get('/api/pendencias/comprovantes', (req, res, next) => {
    try {
      const resultado = comprovantes.listarPendenciasDeComprovante(resolveDb(), {
        estado: req.query.estado,
        limite: numeroDaQuery(req.query.limite),
        offset: numeroDaQuery(req.query.offset),
      });
      return res.json({ status: 'ok', ...resultado });
    } catch (error) {
      return responderErro(res, error, next);
    }
  });

  // --- superficie HTML operacional (Fase 3A) --------------------------------
  // Namespace separado de /api/*: leitura cadastral, sem regra financeira.
  app.use('/associados', associadosRouter(resolveDb));

  app.use((req, res) => res.status(404).json({ status: 'erro', erro: 'rota nao encontrada' }));

  // eslint-disable-next-line no-unused-vars -- assinatura de 4 args e obrigatoria no Express
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ status: 'erro', erro: 'erro interno' });
  });

  return app;
}

module.exports = { createApp };
