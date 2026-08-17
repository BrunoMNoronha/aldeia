'use strict';

// Helper de testes: gera arquivos .xlsx temporarios com a MESMA biblioteca usada
// pelo importador. A suite nunca depende da planilha real do cliente.

const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');

/**
 * Escreve um .xlsx em `caminho`.
 *
 * @param {string} caminho
 * @param {(worksheet: ExcelJS.Worksheet, workbook: ExcelJS.Workbook) => void} montar
 * @param {{aba?: string}} [opcoes]
 */
async function escreverWorkbook(caminho, montar, opcoes = {}) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(opcoes.aba ?? 'Dados');
  montar(worksheet, workbook);
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  await workbook.xlsx.writeFile(caminho);
  return caminho;
}

/** Preenchimento solido; usado apenas como EVIDENCIA visual, nunca como regra. */
function preenchimento(argb) {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb }, bgColor: { argb } };
}

module.exports = { escreverWorkbook, preenchimento };
