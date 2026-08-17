#!/usr/bin/env node
'use strict';

// Importa um .xlsx para a camada bruta do banco (Fase 1A).
//
// Uso: npm run import:legacy -- "C:\caminho\controle-de-pagamento.xlsx"
//      DB_PATH=... npm run import:legacy -- "<arquivo.xlsx>"
//
// A importacao e BRUTA: preserva proveniencia (arquivo, SHA-256, aba, celula,
// valor original) e nao interpreta pagamentos.

const { openDatabase } = require('../src/db/connection');
const { resolveDbPath } = require('../src/config');
const { importarPlanilhaLegada } = require('../src/import/legacy-importer');

function imprimirDuplicada(resumo) {
  console.log('arquivo ja importado');
  console.log(`sha256: ${resumo.sha256}`);
  console.log(`importacao_id: ${resumo.importacaoId}`);
  console.log(`importado_em: ${resumo.importadoEm}`);
  if (resumo.nomeArquivoOriginal !== resumo.nomeArquivo) {
    console.log(`nome na importacao original: ${resumo.nomeArquivoOriginal}`);
  }
  console.log('duplicada: sim');
}

function imprimirConcluida(resumo) {
  const { totais, abas } = resumo.resultado;

  console.log('importacao concluida');
  console.log(`arquivo: ${resumo.nomeArquivo}`);
  console.log(`sha256: ${resumo.sha256}`);
  console.log(`importacao_id: ${resumo.importacaoId}`);
  console.log(`abas: ${totais.abas}`);
  console.log(`celulas: ${totais.celulasPersistidas}`);
  console.log(
    `  com valor: ${totais.comValor} | formulas: ${totais.comFormula} | ` +
      `mescladas: ${totais.mescladas} | vazias com estilo: ${totais.vaziasComEstilo}`
  );
  for (const aba of abas) {
    console.log(`  aba "${aba.nome}": ${aba.intervaloUtilizado ?? 'vazia'} -> ${aba.celulasPersistidas} celulas`);
  }
  console.log('duplicada: nao');
}

async function main() {
  const caminhoArquivo = process.argv[2];

  if (!caminhoArquivo) {
    throw new Error('informe o caminho do .xlsx: npm run import:legacy -- "<arquivo.xlsx>"');
  }

  const dbPath = resolveDbPath();
  const db = openDatabase(dbPath);

  try {
    console.log(`banco: ${dbPath}`);
    const resumo = await importarPlanilhaLegada(db, caminhoArquivo);

    if (resumo.duplicada) imprimirDuplicada(resumo);
    else imprimirConcluida(resumo);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(`erro na importacao: ${error.message}`);
  process.exitCode = 1;
});
