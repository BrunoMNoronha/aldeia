#!/usr/bin/env node
'use strict';

// Materializa associados a partir das colunas A/B de uma importacao ja capturada
// pela Fase 1A (Fase 1B).
//
// Uso: npm run legacy:associados -- <importacao_id>
//      npm run legacy:associados -- <importacao_id> --aceitar-id-de-formula
//
// Deliberadamente SEPARADO de `import:legacy`: captura bruta e materializacao
// normalizada sao etapas distintas e auditaveis de forma independente.

const { openDatabase } = require('../src/db/connection');
const { resolveDbPath } = require('../src/config');
const { materializarAssociados } = require('../src/import/associate-materializer');

const FLAG_ID_FORMULA = '--aceitar-id-de-formula';

function imprimir(relatorio) {
  console.log('materializacao de associados concluida');
  console.log('');
  console.log(`importacao: ${relatorio.importacaoId}`);
  console.log(`linhas analisadas: ${relatorio.linhasAnalisadas}`);
  console.log(`candidatos: ${relatorio.candidatos}`);
  console.log(`associados criados: ${relatorio.associadosCriados}`);
  console.log(`associados existentes: ${relatorio.associadosExistentes}`);
  console.log(`links criados: ${relatorio.linksCriados}`);
  console.log(`ocorrencias para revisao: ${relatorio.ocorrenciasRevisao}`);

  if (relatorio.ocorrenciasRevisao > 0) {
    console.log('');
    const codigos = Object.entries(relatorio.ocorrenciasPorCodigo).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
    );
    for (const [codigo, total] of codigos) {
      console.log(`${codigo}: ${total}`);
    }
  }

  if (!relatorio.aceitarIdDeFormula && relatorio.ocorrenciasPorCodigo.legacy_id_from_formula) {
    console.log('');
    console.log(
      `nota: ${relatorio.ocorrenciasPorCodigo.legacy_id_from_formula} linha(s) tem o legacy_id`
    );
    console.log('apenas como resultado de formula e aguardam decisao humana.');
    console.log(`para aceita-las explicitamente, reexecute com ${FLAG_ID_FORMULA}.`);
  }
}

function main() {
  const argumentos = process.argv.slice(2);
  const aceitarIdDeFormula = argumentos.includes(FLAG_ID_FORMULA);
  const importacaoId = argumentos.find((argumento) => !argumento.startsWith('--'));

  if (importacaoId === undefined) {
    throw new Error(
      `informe o id da importacao: npm run legacy:associados -- <importacao_id> [${FLAG_ID_FORMULA}]`
    );
  }

  const dbPath = resolveDbPath();
  const db = openDatabase(dbPath);

  try {
    console.log(`banco: ${dbPath}`);
    imprimir(materializarAssociados(db, importacaoId, { aceitarIdDeFormula }));
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`erro na materializacao: ${error.message}`);
  process.exitCode = 1;
}
