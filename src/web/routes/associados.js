'use strict';

// Rotas HTML de associados (Fase 3A). SOMENTE LEITURA: nenhuma rota aqui grava.
//
// Estas rotas nao passam pelo error handler JSON de `app.js` de proposito: uma
// falha numa pagina de navegacao precisa responder HTML, nao um corpo JSON que
// o navegador exibiria cru. Cada handler trata o proprio erro.

const express = require('express');

const associados = require('../../services/associados');
const ledger = require('../../services/ledger');
const comprovantes = require('../../services/comprovantes');
const views = require('../views/associados');

function enviarHtml(res, status, html) {
  return res.status(status).type('html').send(html);
}

/** Erro tecnico vai para o log; o navegador recebe uma pagina generica. */
function responderErroInterno(res, error) {
  console.error(error);
  return enviarHtml(res, 500, views.paginaErroInterno());
}

/**
 * @param {() => import('better-sqlite3').Database} resolveDb mesma estrategia de
 *        injecao usada pelas rotas JSON (os testes injetam um banco temporario).
 */
function associadosRouter(resolveDb) {
  const router = express.Router();

  // Listagem + busca. Filtro sem resultado continua sendo 200: "nao achei nada"
  // e uma resposta valida da lista, nao um recurso inexistente.
  router.get('/', (req, res) => {
    try {
      const resultado = associados.listarAssociados(resolveDb(), {
        nome: req.query.nome,
        legacyId: req.query.legacy_id,
      });
      return enviarHtml(res, 200, views.paginaListagem({ resultado }));
    } catch (error) {
      return responderErroInterno(res, error);
    }
  });

  // Declarada ANTES de `/:id` para que 'legacy' nunca seja capturado como id.
  router.get('/legacy/:legacyId', (req, res) => {
    try {
      const associado = associados.obterAssociadoPorLegacyId(resolveDb(), req.params.legacyId);
      if (associado === null) return enviarHtml(res, 404, views.paginaNaoEncontrado());
      return res.redirect(302, `/associados/${associado.id}`);
    } catch (error) {
      return responderErroInterno(res, error);
    }
  });

  // Detalhe cadastral. Id malformado e id inexistente respondem o mesmo 404
  // HTML: nesta superficie de navegacao uma URL invalida e apenas uma pagina
  // que nao existe, nao um erro de contrato.
  router.get('/:id', (req, res) => {
    try {
      const db = resolveDb();
      const associado = associados.obterAssociado(db, req.params.id);
      if (associado === null) return enviarHtml(res, 404, views.paginaNaoEncontrado());

      // O extrato vem do ledger, dono de `movimento_financeiro`. A rota so
      // encomenda a leitura: nao filtra, nao soma e nao classifica nada.
      const movimentos = ledger.listarMovimentosDoAssociado(db, associado.id);

      // Fase 4A: a evidencia vem do servico de comprovantes, dono de
      // `comprovante`, em UMA consulta para todos os movimentos. O mapa sempre
      // tem entrada para cada movimento — inclusive `sem_registro` —, entao a
      // view nunca precisa deduzir estado a partir de um campo faltando.
      const evidencias = comprovantes.obterComprovantesDeMovimentos(
        db,
        movimentos.map((movimento) => movimento.id)
      );
      const movimentosComEvidencia = movimentos.map((movimento) => ({
        ...movimento,
        comprovante: evidencias.get(movimento.id),
      }));

      return enviarHtml(
        res,
        200,
        views.paginaDetalhe({ associado, movimentos: movimentosComEvidencia })
      );
    } catch (error) {
      return responderErroInterno(res, error);
    }
  });

  return router;
}

module.exports = associadosRouter;
