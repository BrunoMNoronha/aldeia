#!/usr/bin/env node
'use strict';

// Diagnostico estruturado do conteudo legado de uma importacao (Fase 1C).
//
// Uso: npm run legacy:diagnostico -- <importacao_id>
//      npm run legacy:diagnostico -- <importacao_id> --json
//
// Este script e FINO de proposito: valida argumentos, abre a conexao, chama o
// servico e imprime. Nenhuma regra de analise mora aqui.

const { openDatabase } = require('../src/db/connection');
const { resolveDbPath } = require('../src/config');
const { diagnosticarLegado } = require('../src/import/legacy-diagnostics');

const FLAG_JSON = '--json';

function topN(lista, n) {
  return lista.slice(0, n);
}

function imprimirContagem(rotulo, contagem) {
  const itens = Object.entries(contagem).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  if (itens.length === 0) {
    console.log(`${rotulo}: (nenhuma)`);
    return;
  }
  console.log(`${rotulo}: ${itens.map(([chave, total]) => `${chave}=${total}`).join('  ')}`);
}

function imprimirResumo(relatorio) {
  console.log('diagnostico do legado concluido');
  console.log('');
  console.log(`importacao: ${relatorio.importacaoId}`);
  console.log(`arquivo: ${relatorio.nomeArquivo}`);
  console.log(`sha256: ${relatorio.sha256}`);
  console.log(`versao: ${relatorio.versaoDiagnostico}`);
  for (const aba of relatorio.abas) {
    console.log(
      `aba "${aba.nome}": ${aba.intervaloUtilizado ?? 'intervalo desconhecido'} -> ${aba.celulas} celulas`
    );
  }
  console.log(`legacy_cell: ${relatorio.totais.legacyCells} (com conteudo: ${relatorio.totais.comConteudo})`);
  console.log(`associados vinculados: ${relatorio.totais.associadosVinculados}`);

  console.log('');
  console.log('-- distribuicao de tipos --');
  imprimirContagem('total', relatorio.distribuicaoTipos.total);
  for (const [area, contagem] of Object.entries(relatorio.distribuicaoTipos.porArea)) {
    imprimirContagem(`area ${area}`, contagem);
  }
  for (const [bloco, contagem] of Object.entries(relatorio.distribuicaoTipos.porBlocoAnual)) {
    imprimirContagem(`bloco ${bloco}`, contagem);
  }

  console.log('');
  console.log('-- textos --');
  console.log(
    `celulas textuais: ${relatorio.textos.celulasTextuais} | distintos: ${relatorio.textos.valoresDistintos}`
  );
  for (const valor of topN(relatorio.textos.valores, 15)) {
    console.log(`  ${valor.ocorrencias.toString().padStart(5)}x  ${JSON.stringify(valor.valorBruto)}`);
  }
  console.log(`tokens curtos distintos: ${relatorio.textos.tokensCurtos.distintos}`);
  for (const valor of topN(relatorio.textos.tokensCurtos.valores, 15)) {
    console.log(`  ${valor.ocorrencias.toString().padStart(5)}x  ${JSON.stringify(valor.valorBruto)}`);
  }

  console.log('');
  console.log('-- formulas --');
  console.log(
    `total: ${relatorio.formulas.total} | distintas: ${relatorio.formulas.distintas} | ` +
      `padroes: ${relatorio.formulas.padroesDistintos}`
  );
  imprimirContagem('por coluna', relatorio.formulas.porColuna);
  for (const padrao of topN(relatorio.formulas.padroes, 10)) {
    const amostra = padrao.amostras[0];
    console.log(
      `  ${padrao.ocorrencias.toString().padStart(5)}x  ${padrao.padrao}  ` +
        `(${padrao.formulasDistintas} distintas; ex.: ${amostra.endereco} = ${amostra.formula})`
    );
  }

  console.log('');
  console.log('-- estilos / preenchimentos --');
  console.log(
    `com estilo: ${relatorio.estilos.celulasComEstilo} | com preenchimento: ` +
      `${relatorio.estilos.celulasComPreenchimento} | assinaturas: ${relatorio.estilos.assinaturasDistintas}`
  );
  for (const assinatura of topN(relatorio.estilos.assinaturas, 20)) {
    const nota = assinatura.notaBaseline === null ? assinatura.significado : assinatura.notaBaseline;
    console.log(`  ${assinatura.ocorrencias.toString().padStart(5)}x  ${assinatura.assinatura}  [${nota}]`);
  }

  console.log('');
  console.log('-- numeros --');
  const numeros = relatorio.numeros;
  console.log(
    `quantidade: ${numeros.quantidade} | distintos: ${numeros.valoresDistintos} | inteiros: ${numeros.inteiros} | ` +
      `com 2 casas: ${numeros.comDuasCasasDecimais} | fora do padrao: ${numeros.foraDoPadraoDecimal}`
  );
  imprimirContagem('casas decimais', numeros.porCasasDecimais);
  if (numeros.minimo !== null) console.log(`minimo: ${numeros.minimo.valorBruto} (${numeros.minimo.endereco})`);
  if (numeros.maximo !== null) console.log(`maximo: ${numeros.maximo.valorBruto} (${numeros.maximo.endereco})`);
  console.log(`numeros em resultado de formula: ${numeros.numerosEmResultadoDeFormula}`);

  console.log('');
  console.log('-- centavos x legacy_id (hipotese) --');
  const centavos = relatorio.centavosVersusLegacyId;
  console.log(`hipotese: ${centavos.hipotese} | avaliada: ${centavos.avaliada ? 'sim' : 'nao'}`);
  console.log(`legacy_ids considerados: ${centavos.legacyIdsConsiderados}`);
  console.log(
    `valores com 2 casas: ${centavos.valoresComDuasCasasDecimais} | com 1 casa: ${centavos.valoresComUmaCasaDecimal}`
  );
  console.log(
    `coincidencias: exatas=${centavos.coincidencias.leituraExataDuasCasas} ` +
      `com zero adicionado=${centavos.coincidencias.leituraComZeroAdicionado} ` +
      `total=${centavos.coincidencias.total} | sem coincidencia: ${centavos.semCoincidencia}`
  );
  const poder = centavos.poderDiscriminante;
  console.log(
    `poder discriminante: ${poder.sufixosAlcancadosPorAlgumLegacyId}/${poder.sufixosPossiveis} sufixos alcancaveis`
  );
  console.log(`  ${poder.observacao}`);

  console.log('');
  console.log('-- BJ (total parcial legado) --');
  console.log(
    `celulas: ${relatorio.totalParcialLegado.celulas} | preenchidas: ${relatorio.totalParcialLegado.preenchidas} | ` +
      `saldo oficial: ${relatorio.totalParcialLegado.saldoOficial}`
  );
  imprimirContagem('por tipo', relatorio.totalParcialLegado.porTipo);

  console.log('');
  console.log('-- BM (situacao legada) --');
  console.log(
    `preenchidas: ${relatorio.situacaoLegada.preenchidas} ` +
      `(em linha de associado: ${relatorio.situacaoLegada.emLinhaDeAssociado} | fora: ` +
      `${relatorio.situacaoLegada.foraDeLinhaDeAssociado}) | distintos: ` +
      `${relatorio.situacaoLegada.valoresDistintos} | interpretacao: ${relatorio.situacaoLegada.interpretacao}`
  );
  for (const valor of topN(relatorio.situacaoLegada.valores, 20)) {
    console.log(`  ${valor.ocorrencias.toString().padStart(5)}x  ${JSON.stringify(valor.valorBruto)}`);
  }

  console.log('');
  console.log('-- BN (observacoes) --');
  console.log(
    `preenchidas: ${relatorio.observacoesLegadas.preenchidas} ` +
      `(em linha de associado: ${relatorio.observacoesLegadas.emLinhaDeAssociado} | fora: ` +
      `${relatorio.observacoesLegadas.foraDeLinhaDeAssociado}) | distintos: ` +
      `${relatorio.observacoesLegadas.valoresDistintos} | complexos: ${relatorio.observacoesLegadas.textosComplexos.length}`
  );
  for (const valor of topN(relatorio.observacoesLegadas.maisFrequentes, 10)) {
    console.log(`  ${valor.ocorrencias.toString().padStart(5)}x  ${JSON.stringify(valor.valorBruto)}`);
  }

  console.log('');
  console.log('-- fora da tabela principal --');
  const fora = relatorio.foraDaTabelaPrincipal;
  console.log(
    `linhas de associado: ${fora.linhasDeAssociado} | linhas fora: ${fora.linhasForaDaTabela} | ` +
      `celulas fora: ${fora.celulasForaDaTabela}`
  );
  for (const linha of topN(fora.linhas, 15)) {
    const amostra = linha.celulas[0];
    console.log(
      `  ${linha.aba}!${linha.linha} (${linha.celulasComConteudo} celulas) ` +
        `${amostra === undefined ? '' : `${amostra.endereco}=${JSON.stringify(amostra.valorBruto)}`}`
    );
  }

  console.log('');
  console.log('-- ocorrencias --');
  console.log(`listadas: ${relatorio.ocorrencias.length}`);
  imprimirContagem('detectadas por codigo', relatorio.ocorrenciasPorCodigo);
  const truncadas = Object.entries(relatorio.ocorrenciasTruncadas);
  if (truncadas.length > 0) {
    for (const [codigo, info] of truncadas) {
      console.log(`  truncado: ${codigo} (detectadas ${info.detectadas}, listadas ${info.listadas})`);
    }
  }

  console.log('');
  console.log('-- nao interpretado (TO CONFIRM) --');
  for (const item of relatorio.naoInterpretado.itens) console.log(`  ${item}`);
}

function main() {
  const argumentos = process.argv.slice(2);
  const comoJson = argumentos.includes(FLAG_JSON);
  const importacaoId = argumentos.find((argumento) => !argumento.startsWith('--'));

  if (importacaoId === undefined) {
    throw new Error(
      `informe o id da importacao: npm run legacy:diagnostico -- <importacao_id> [${FLAG_JSON}]`
    );
  }

  const dbPath = resolveDbPath();
  const db = openDatabase(dbPath);

  try {
    // Em modo --json o stdout carrega SOMENTE o JSON; qualquer log humano iria
    // corromper a saida para quem faz pipe.
    if (!comoJson) console.log(`banco: ${dbPath}`);

    const relatorio = diagnosticarLegado(db, importacaoId);

    if (comoJson) process.stdout.write(`${JSON.stringify(relatorio, null, 2)}\n`);
    else imprimirResumo(relatorio);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`erro no diagnostico: ${error.message}`);
  process.exitCode = 1;
}
