'use strict';

// Fase 1C — diagnostico estruturado do legado.
//
// A suite NUNCA usa a planilha real: cada teste gera o proprio .xlsx, roda a
// importacao bruta (1A), materializa associados quando precisa do vinculo (1B) e
// so entao diagnostica.
//
// Alem de verificar o que o relatorio mede, os testes verificam o que ele NAO
// pode fazer: nada financeiro, nenhuma interpretacao de codigo legado, nenhuma
// alteracao de evidencia e nenhuma sobrescrita de resultado anterior.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createMigratedDb } = require('./helpers/temp-db');
const { escreverWorkbook, preenchimento } = require('./helpers/workbook');
const { importarPlanilhaLegada } = require('../src/import/legacy-importer');
const { materializarAssociados } = require('../src/import/associate-materializer');
const {
  diagnosticarLegado,
  OCORRENCIA,
  SIGNIFICADO_NAO_CONFIRMADO,
  HIPOTESE_NAO_APLICADA,
} = require('../src/import/legacy-diagnostics');

const TABELAS_FINANCEIRAS = [
  'movimento_financeiro',
  'alocacao',
  'ajuste_credito_debito',
  'competencia',
  'comprovante',
];

function contar(db, tabela) {
  return db.prepare(`SELECT COUNT(*) AS total FROM ${tabela}`).get().total;
}

/** Garantia negativa obrigatoria: o diagnostico nao popula nada financeiro. */
function assertSemEfeitoFinanceiro(db) {
  for (const tabela of TABELAS_FINANCEIRAS) {
    assert.equal(contar(db, tabela), 0, `o diagnostico nao pode popular ${tabela}`);
  }
}

function associados(db) {
  return db.prepare('SELECT * FROM associado ORDER BY legacy_id').all();
}

function resultadoBruto(db, importacaoId) {
  return db.prepare('SELECT resultado FROM importacao WHERE id = ?').get(importacaoId).resultado;
}

function celulas(db, importacaoId) {
  return db
    .prepare('SELECT endereco, valor_bruto, tipo_original FROM legacy_cell WHERE importacao_id = ? ORDER BY endereco')
    .all(importacaoId);
}

async function importarFixture(ctx, nome, montar) {
  const arquivo = path.join(ctx.dir, nome);
  await escreverWorkbook(arquivo, montar);
  const resumo = await importarPlanilhaLegada(ctx.db, arquivo);
  assert.equal(resumo.duplicada, false, `fixture ${nome} deveria ser uma importacao nova`);
  return resumo.importacaoId;
}

function porValorBruto(lista) {
  return new Map(lista.map((item) => [item.valorBruto, item]));
}

function codigos(relatorio) {
  return new Set(relatorio.ocorrencias.map((ocorrencia) => ocorrencia.codigo));
}

// ---------------------------------------------------------------------------
// T1 — distribuicao de tipos
// ---------------------------------------------------------------------------
test('T1: distribui os tipos de celula por area sem inventar semantica', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'tipos.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria';
    ws.getCell('C3').value = 40.02; // numero
    ws.getCell('D3').value = 'ok'; // texto
    ws.getCell('E3').value = { formula: 'SUM(C3:C3)', result: 40.02 }; // formula
    ws.getCell('F3').value = new Date(Date.UTC(2024, 0, 15)); // data
    ws.getCell('G3').fill = preenchimento('FF00FF00'); // vazia com estilo
    ws.getCell('BJ3').value = { formula: 'SUM(C3:BH3)', result: 40.02 };
    ws.getCell('BL3').value = 'MARIA CONSOLIDADA';
    ws.getCell('BM3').value = 'a';
    ws.getCell('BN3').value = 'sem comprovante';
  });

  const relatorio = diagnosticarLegado(ctx.db, importacaoId);

  const lancamentos = relatorio.distribuicaoTipos.porArea['C:BH'];
  assert.equal(lancamentos.numero, 1);
  assert.equal(lancamentos.texto, 1);
  assert.equal(lancamentos.formula, 1);
  assert.equal(lancamentos.data, 1);
  assert.equal(lancamentos.vazio, 1, 'celula vazia com estilo e evidencia e entra na contagem');

  assert.deepEqual(relatorio.distribuicaoTipos.porArea['BJ'], { formula: 1 });
  assert.deepEqual(relatorio.distribuicaoTipos.porArea['BL:BN'], { texto: 3 });
  assert.deepEqual(relatorio.distribuicaoTipos.porArea['A:B'], { numero: 1, texto: 1 });

  // O bloco anual e apenas um recorte descritivo de C:BH, nunca uma competencia.
  const bloco2024 = relatorio.distribuicaoTipos.porBlocoAnual['2024 (C:Y)'];
  assert.equal(bloco2024.numero, 1);
  assert.equal(bloco2024.texto, 1);

  assert.equal(relatorio.totais.legacyCells, celulas(ctx.db, importacaoId).length);
  assertSemEfeitoFinanceiro(ctx.db);
});

// ---------------------------------------------------------------------------
// T2 — texto permanece texto
// ---------------------------------------------------------------------------
test('T2: tokens desconhecidos entram no inventario sem ganhar significado', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'tokens.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria';
    ws.getCell('C3').value = 'ok';
    ws.getCell('D3').value = 'c20';
    ws.getCell('E3').value = 'f15';
    ws.getCell('F3').value = 'LG';
    ws.getCell('G3').value = 'TLA';
    ws.getCell('H3').value = 'ok';
  });

  const relatorio = diagnosticarLegado(ctx.db, importacaoId);
  const inventario = porValorBruto(relatorio.textos.valores);

  for (const token of ['ok', 'c20', 'f15', 'LG', 'TLA']) {
    assert.ok(inventario.has(token), `token ${token} deve aparecer no inventario`);
  }
  assert.equal(inventario.get('ok').ocorrencias, 2, 'frequencia bruta preservada');
  assert.equal(relatorio.textos.significado, SIGNIFICADO_NAO_CONFIRMADO);

  // Cada token e rastreavel ate a celula que o produziu.
  const amostra = inventario.get('c20').amostras[0];
  assert.equal(amostra.endereco, 'D3');
  assert.ok(Number.isInteger(amostra.legacyCellId));

  // Nenhum token virou dominio: sem status, sem valor, sem competencia.
  assert.equal(relatorio.textos.valores.every((valor) => valor.valorBruto !== undefined), true);
  for (const valor of relatorio.textos.valores) {
    assert.equal(valor.significado, undefined, 'o inventario nao atribui significado por token');
  }

  const tokensCurtos = porValorBruto(relatorio.textos.tokensCurtos.valores);
  assert.ok(tokensCurtos.has('LG'), 'token curto listado separadamente');
  assert.ok(codigos(relatorio).has(OCORRENCIA.TOKEN_TEXTUAL_NAO_DOCUMENTADO));

  assertSemEfeitoFinanceiro(ctx.db);
});

// ---------------------------------------------------------------------------
// T3 — valor bruto preservado
// ---------------------------------------------------------------------------
test('T3: o agrupamento diagnostico nunca altera valor_bruto', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'agrupamento.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria';
    ws.getCell('C3').value = ' OK ';
    ws.getCell('D3').value = 'ok';
    ws.getCell('E3').value = 'Ok';
  });

  const antes = celulas(ctx.db, importacaoId);
  const relatorio = diagnosticarLegado(ctx.db, importacaoId);
  const depois = celulas(ctx.db, importacaoId);

  assert.deepEqual(depois, antes, 'nenhuma celula foi tocada pelo diagnostico');

  const inventario = porValorBruto(relatorio.textos.valores);
  assert.equal(inventario.size, 3, 'tres valores brutos distintos permanecem distintos');
  assert.ok(inventario.has(' OK '), 'espacos preservados no valor bruto');
  assert.ok(inventario.has('Ok'), 'caixa preservada no valor bruto');

  // A chave existe, e derivada e serve apenas para agrupar.
  for (const valor of inventario.values()) {
    assert.equal(valor.chaveAgrupamento, 'ok');
  }
  assert.match(relatorio.textos.chaveAgrupamento, /valor_bruto preservado/);
});

// ---------------------------------------------------------------------------
// T4 — BM nao e interpretado
// ---------------------------------------------------------------------------
test('T4: BM e inventariado sem virar status cadastral ou financeiro', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'bm.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria';
    ws.getCell('BM3').value = 'a';
    ws.getCell('A4').value = 2;
    ws.getCell('B4').value = 'João';
    ws.getCell('BM4').value = 'i';
    ws.getCell('A5').value = 3;
    ws.getCell('B5').value = 'Ana';
    ws.getCell('BM5').value = 'DESLIGADO';
  });

  materializarAssociados(ctx.db, importacaoId);
  const antes = associados(ctx.db);

  const relatorio = diagnosticarLegado(ctx.db, importacaoId);

  assert.equal(relatorio.situacaoLegada.preenchidas, 3);
  assert.equal(relatorio.situacaoLegada.emLinhaDeAssociado, 3);
  assert.equal(relatorio.situacaoLegada.foraDeLinhaDeAssociado, 0);
  assert.equal(relatorio.situacaoLegada.interpretacao, 'nao_aplicada');
  const valores = porValorBruto(relatorio.situacaoLegada.valores);
  assert.deepEqual([...valores.keys()].sort(), ['DESLIGADO', 'a', 'i']);
  assert.ok(codigos(relatorio).has(OCORRENCIA.BM_CODIGO_NAO_INTERPRETADO));

  const depois = associados(ctx.db);
  assert.deepEqual(depois, antes, 'nenhum associado foi alterado');
  for (const associado of depois) {
    assert.equal(associado.status_cadastral, 'indefinido', 'BM nao vira status_cadastral');
    assert.equal(associado.legacy_status_code, null, 'C-01 continua TO CONFIRM');
  }

  assertSemEfeitoFinanceiro(ctx.db);
});

// ---------------------------------------------------------------------------
// T5 — centavos nao geram associacao financeira
// ---------------------------------------------------------------------------
test('T5: a coincidencia centavos x legacy_id e medida, nunca aplicada', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'centavos.xlsx', (ws) => {
    ws.getCell('A3').value = 2;
    ws.getCell('B3').value = 'Dois';
    ws.getCell('A4').value = 35;
    ws.getCell('B4').value = 'Trinta e cinco';
    ws.getCell('A5').value = 37;
    ws.getCell('B5').value = 'Trinta e sete';
    ws.getCell('C3').value = 40.02; // sufixo 02 -> legacy_id 2
    ws.getCell('C4').value = 150.35; // sufixo 35 -> legacy_id 35
    ws.getCell('C5').value = 51.37; // sufixo 37 -> legacy_id 37
    ws.getCell('D3').value = 40.99; // sufixo 99 -> nenhum associado
    ws.getCell('D4').value = 40; // inteiro
  });

  materializarAssociados(ctx.db, importacaoId);
  const relatorio = diagnosticarLegado(ctx.db, importacaoId);

  const centavos = relatorio.centavosVersusLegacyId;
  assert.equal(centavos.hipotese, HIPOTESE_NAO_APLICADA);
  assert.equal(centavos.avaliada, true);
  assert.equal(centavos.legacyIdsConsiderados, 3);
  assert.equal(centavos.valoresComDuasCasasDecimais, 4);
  assert.equal(centavos.coincidencias.leituraExataDuasCasas, 3);
  assert.equal(centavos.coincidencias.total, 3);
  assert.equal(centavos.semCoincidencia, 1, '40.99 nao coincide com nenhum legacy_id');

  // O relatorio declara o quanto o proprio teste vale: com 3 IDs conhecidos, a
  // maioria dos sufixos nao tem correspondente e a coincidencia significa algo.
  assert.equal(centavos.poderDiscriminante.sufixosAlcancadosPorAlgumLegacyId, 3);
  assert.equal(centavos.poderDiscriminante.todosOsSufixosSaoAlcancaveis, false);

  const amostra = centavos.amostras.find((item) => item.endereco === 'C4');
  assert.equal(amostra.sufixo, '35');
  assert.equal(amostra.legacyIdEquivalente, '35');
  assert.ok(Number.isInteger(amostra.legacyCellId), 'amostra rastreavel ate legacy_cell');

  // O valor continua intacto: nenhum centavo foi removido do dado.
  const celula = ctx.db
    .prepare('SELECT valor_bruto FROM legacy_cell WHERE importacao_id = ? AND endereco = ?')
    .get(importacaoId, 'C4');
  assert.equal(celula.valor_bruto, '150.35');

  // Nenhum vinculo financeiro nasceu da coincidencia.
  assertSemEfeitoFinanceiro(ctx.db);
  assert.equal(contar(ctx.db, 'pendencia'), 0);
});

test('T5b: sem associados materializados a hipotese nao e sequer avaliada', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'centavos-sem-associado.xlsx', (ws) => {
    ws.getCell('C3').value = 40.02;
  });

  const relatorio = diagnosticarLegado(ctx.db, importacaoId);

  assert.equal(relatorio.centavosVersusLegacyId.avaliada, false);
  assert.match(relatorio.centavosVersusLegacyId.motivoNaoAvaliada, /nenhum associado/);
  assert.equal(relatorio.centavosVersusLegacyId.coincidencias.total, 0);
});

test('T5d: coincidencia de 100% e reportada como sem poder discriminante', async (t) => {
  const ctx = createMigratedDb(t);

  // 99 associados cobrem todos os sufixos possiveis: qualquer valor com centavos
  // coincide por construcao e a hipotese deixa de distinguir qualquer coisa.
  const importacaoId = await importarFixture(ctx, 'centavos-cobertura.xlsx', (ws) => {
    for (let id = 1; id <= 99; id += 1) {
      ws.getCell(`A${id + 2}`).value = id;
      ws.getCell(`B${id + 2}`).value = `Associado ${id}`;
    }
    ws.getCell('C3').value = 40.77;
  });

  materializarAssociados(ctx.db, importacaoId);
  const centavos = diagnosticarLegado(ctx.db, importacaoId).centavosVersusLegacyId;

  assert.equal(centavos.semCoincidencia, 0);
  assert.equal(centavos.poderDiscriminante.todosOsSufixosSaoAlcancaveis, true);
  assert.match(centavos.poderDiscriminante.observacao, /NAO e evidencia de vinculo/);
  assert.equal(centavos.hipotese, HIPOTESE_NAO_APLICADA);

  assertSemEfeitoFinanceiro(ctx.db);
});

test('T5c: uma casa decimal e reportada como ambiguidade, nao resolvida', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'centavos-ambiguos.xlsx', (ws) => {
    ws.getCell('A3').value = 20;
    ws.getCell('B3').value = 'Vinte';
    // O arquivo guarda 40,20 e 40,2 como o MESMO numero: a leitura exata e a
    // leitura com zero a direita divergem e isso precisa ficar visivel.
    ws.getCell('C3').value = 40.2;
  });

  materializarAssociados(ctx.db, importacaoId);
  const relatorio = diagnosticarLegado(ctx.db, importacaoId);
  const centavos = relatorio.centavosVersusLegacyId;

  assert.equal(centavos.valoresComUmaCasaDecimal, 1);
  assert.equal(centavos.coincidencias.leituraExataDuasCasas, 0);
  assert.equal(centavos.coincidencias.leituraComZeroAdicionado, 1);
  assert.ok(codigos(relatorio).has(OCORRENCIA.CENTAVOS_AMBIGUOS_POR_ZERO_A_DIREITA));

  assertSemEfeitoFinanceiro(ctx.db);
});

// ---------------------------------------------------------------------------
// T6 — estilos desconhecidos
// ---------------------------------------------------------------------------
test('T6: preenchimento sem legenda aparece no inventario e continua sem significado', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'estilos.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria';
    ws.getCell('C3').value = 40.02;
    ws.getCell('C3').fill = preenchimento('FFFFFF00'); // amarelo: citado pelo baseline
    ws.getCell('D3').value = 10;
    ws.getCell('D3').fill = preenchimento('FF7030A0'); // roxo: sem legenda alguma
  });

  const relatorio = diagnosticarLegado(ctx.db, importacaoId);

  const assinaturas = new Map(relatorio.estilos.assinaturas.map((item) => [item.fgArgb, item]));
  const desconhecida = assinaturas.get('FF7030A0');

  assert.ok(desconhecida, 'a assinatura desconhecida precisa aparecer');
  assert.equal(desconhecida.significado, SIGNIFICADO_NAO_CONFIRMADO);
  assert.equal(desconhecida.notaBaseline, null, 'nenhum nome inventado para a cor');
  assert.equal(desconhecida.ocorrencias, 1);
  assert.equal(desconhecida.amostras[0].endereco, 'D3');

  // Ate a cor citada pelo baseline continua sem significado de dominio.
  const amarela = assinaturas.get('FFFFFF00');
  assert.equal(amarela.significado, SIGNIFICADO_NAO_CONFIRMADO);
  assert.match(amarela.notaBaseline, /evidencia textual/);

  assert.ok(codigos(relatorio).has(OCORRENCIA.PREENCHIMENTO_SEM_SIGNIFICADO_CONFIRMADO));
  assertSemEfeitoFinanceiro(ctx.db);
});

// ---------------------------------------------------------------------------
// T7 — BJ nao vira saldo
// ---------------------------------------------------------------------------
test('T7: BJ e evidencia de total parcial legado, nunca saldo oficial', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'bj.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria';
    ws.getCell('C3').value = 40.02;
    ws.getCell('BJ3').value = { formula: 'SUM(C3:BH3)', result: 40.02 };
    ws.getCell('BJ4').value = 999.99;
  });

  const relatorio = diagnosticarLegado(ctx.db, importacaoId);

  assert.equal(relatorio.totalParcialLegado.saldoOficial, false);
  assert.equal(relatorio.totalParcialLegado.usoPermitido, 'evidencia');
  assert.equal(relatorio.totalParcialLegado.preenchidas, 2);
  assert.deepEqual(relatorio.totalParcialLegado.porTipo, { formula: 1, numero: 1 });

  const ocorrencia = relatorio.ocorrencias.find(
    (item) => item.codigo === OCORRENCIA.FORMULA_TOTAL_PARCIAL_LEGADO
  );
  assert.ok(ocorrencia, 'a formula de BJ vira ocorrencia rastreavel');
  assert.equal(ocorrencia.endereco, 'BJ3');
  assert.equal(ocorrencia.formula, 'SUM(C3:BH3)');
  assert.equal(ocorrencia.saldoOficial, false);

  assertSemEfeitoFinanceiro(ctx.db);
});

// ---------------------------------------------------------------------------
// T8 — registros fora da tabela principal
// ---------------------------------------------------------------------------
test('T8: conteudo fora das linhas de associado e inventariado sem ser convertido', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'fora.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria';
    ws.getCell('C3').value = 40.02;
    // Bloco abaixo da tabela: nomes sem ID, pendencias e saldo.
    ws.getCell('B20').value = 'PENDENTES - IDENTIFICAR';
    ws.getCell('B21').value = 'deposito sem identificacao';
    ws.getCell('C21').value = 100.5;
    ws.getCell('B22').value = 'SALDO';
    ws.getCell('C22').value = 1234.56;
  });

  materializarAssociados(ctx.db, importacaoId);
  const associadosAntes = associados(ctx.db);

  const relatorio = diagnosticarLegado(ctx.db, importacaoId);
  const fora = relatorio.foraDaTabelaPrincipal;

  assert.equal(fora.linhasDeAssociadoConhecidas, true);
  assert.equal(fora.linhasDeAssociado, 1);
  assert.equal(fora.linhasForaDaTabela, 3, 'linhas 20, 21 e 22');

  const linhas = new Map(fora.linhas.map((linha) => [linha.linha, linha]));
  assert.deepEqual([...linhas.keys()].sort((a, b) => a - b), [20, 21, 22]);

  const pendentes = linhas.get(20).celulas[0];
  assert.equal(pendentes.endereco, 'B20');
  assert.equal(pendentes.valorBruto, 'PENDENTES - IDENTIFICAR');
  assert.equal(pendentes.tipoOriginal, 'texto');
  assert.ok(Number.isInteger(pendentes.legacyCellId));

  assert.ok(codigos(relatorio).has(OCORRENCIA.REGISTRO_FORA_DA_TABELA_PRINCIPAL));

  assert.deepEqual(associados(ctx.db), associadosAntes, 'nada virou associado');
  assertSemEfeitoFinanceiro(ctx.db);
});

// ---------------------------------------------------------------------------
// T9 — preservacao do resultado anterior
// ---------------------------------------------------------------------------
test('T9: o diagnostico acrescenta seu namespace sem tocar nos anteriores', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'resultado.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria';
    ws.getCell('C3').value = 40.02;
  });
  materializarAssociados(ctx.db, importacaoId);

  const antes = JSON.parse(resultadoBruto(ctx.db, importacaoId));
  assert.ok(antes.abas, 'fase 1A presente');
  assert.ok(antes.associados, 'fase 1B presente');
  assert.equal(antes.diagnosticoLegado, undefined);

  diagnosticarLegado(ctx.db, importacaoId);

  const depois = JSON.parse(resultadoBruto(ctx.db, importacaoId));
  assert.deepEqual(depois.abas, antes.abas, 'resultado da fase 1A intacto');
  assert.deepEqual(depois.totais, antes.totais, 'totais da fase 1A intactos');
  assert.equal(depois.versaoImportador, antes.versaoImportador);
  assert.deepEqual(depois.associados, antes.associados, 'resultado da fase 1B intacto');

  assert.ok(depois.diagnosticoLegado, 'namespace do diagnostico acrescentado');
  assert.equal(depois.diagnosticoLegado.importacaoId, importacaoId);
  assert.equal(depois.diagnosticoLegado.sha256.length, 64);
  assert.ok(depois.diagnosticoLegado.versaoDiagnostico);
});

// ---------------------------------------------------------------------------
// T10 — rollback
// ---------------------------------------------------------------------------
test('T10: falha ao persistir mantem o resultado anterior byte a byte', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'rollback.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria';
    ws.getCell('C3').value = 40.02;
  });
  materializarAssociados(ctx.db, importacaoId);

  const antes = resultadoBruto(ctx.db, importacaoId);

  // Falha injetada no BANCO, nao no codigo de producao.
  ctx.db.exec(`
    CREATE TRIGGER teste_falha_ao_gravar_diagnostico
    BEFORE UPDATE ON importacao
    BEGIN
      SELECT RAISE(ABORT, 'falha simulada ao gravar o diagnostico');
    END;
  `);

  assert.throws(
    () => diagnosticarLegado(ctx.db, importacaoId),
    /falha simulada ao gravar o diagnostico/
  );

  assert.equal(resultadoBruto(ctx.db, importacaoId), antes, 'resultado inalterado byte a byte');
  assert.equal(ctx.db.inTransaction, false, 'a transacao nao pode ficar aberta');
  assertSemEfeitoFinanceiro(ctx.db);

  ctx.db.exec('DROP TRIGGER teste_falha_ao_gravar_diagnostico');
  diagnosticarLegado(ctx.db, importacaoId);
  assert.ok(JSON.parse(resultadoBruto(ctx.db, importacaoId)).diagnosticoLegado);
});

// ---------------------------------------------------------------------------
// T11 — reexecucao
// ---------------------------------------------------------------------------
test('T11: reexecutar o diagnostico e idempotente e deterministico', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'reexecucao.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria';
    ws.getCell('C3').value = 40.02;
    ws.getCell('D3').value = 'ok';
    ws.getCell('BM3').value = 'a';
    ws.getCell('BN3').value = 'sem comprovante';
    ws.getCell('B20').value = 'PENDENTES - IDENTIFICAR';
  });
  materializarAssociados(ctx.db, importacaoId);

  const contagens = () =>
    Object.fromEntries(
      ['associado', 'legacy_cell', 'legacy_cell_link', 'pendencia', 'importacao', ...TABELAS_FINANCEIRAS].map(
        (tabela) => [tabela, contar(ctx.db, tabela)]
      )
    );

  const primeira = diagnosticarLegado(ctx.db, importacaoId);
  const apos1 = contagens();
  const resultado1 = resultadoBruto(ctx.db, importacaoId);

  const segunda = diagnosticarLegado(ctx.db, importacaoId);
  const apos2 = contagens();

  assert.deepEqual(apos2, apos1, 'nenhuma entidade criada ou duplicada na reexecucao');
  assert.equal(
    JSON.stringify(segunda),
    JSON.stringify(primeira),
    'a mesma evidencia produz exatamente o mesmo relatorio'
  );
  assert.equal(resultadoBruto(ctx.db, importacaoId), resultado1, 'resultado persistido identico');
  assert.equal(
    segunda.ocorrencias.length,
    primeira.ocorrencias.length,
    'ocorrencias nao se acumulam entre execucoes'
  );

  assertSemEfeitoFinanceiro(ctx.db);
});

// ---------------------------------------------------------------------------
// T12 — importacao invalida
// ---------------------------------------------------------------------------
test('T12: importacao inexistente, incompleta ou com resultado invalido falha claramente', (t) => {
  const ctx = createMigratedDb(t);

  assert.throws(() => diagnosticarLegado(ctx.db, 999), /nao encontrada/i);
  assert.throws(() => diagnosticarLegado(ctx.db, 'abc'), /importacao_id invalido/i);
  assert.throws(() => diagnosticarLegado(ctx.db, 0), /importacao_id invalido/i);

  ctx.db
    .prepare(
      "INSERT INTO importacao (nome_arquivo, sha256, versao_importador, status) VALUES (?, ?, 'teste', 'falhou')"
    )
    .run('parcial.xlsx', 'a'.repeat(64));
  assert.throws(() => diagnosticarLegado(ctx.db, 1), /status "falhou"/);

  ctx.db
    .prepare(
      `INSERT INTO importacao (nome_arquivo, sha256, versao_importador, status, resultado)
       VALUES (?, ?, 'teste', 'concluida', ?)`
    )
    .run('texto.xlsx', 'b'.repeat(64), 'relatorio em texto puro, nao JSON');
  assert.throws(() => diagnosticarLegado(ctx.db, 2), /nao e um objeto JSON/);

  assert.equal(
    resultadoBruto(ctx.db, 2),
    'relatorio em texto puro, nao JSON',
    'conteudo anterior intacto'
  );
  assertSemEfeitoFinanceiro(ctx.db);
});

// ---------------------------------------------------------------------------
// BN, formulas e anomalias
// ---------------------------------------------------------------------------
test('BN e inventariada com vinculo ao associado, sem virar comprovante ou pendencia', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'bn.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria';
    ws.getCell('BN3').value = 'faltam comprovantes de marco, abril e maio; conferir deposito de junho';
    ws.getCell('A4').value = 2;
    ws.getCell('B4').value = 'João';
    ws.getCell('BN4').value = '2 meses';
  });

  materializarAssociados(ctx.db, importacaoId);
  const relatorio = diagnosticarLegado(ctx.db, importacaoId);

  assert.equal(relatorio.observacoesLegadas.preenchidas, 2);
  assert.equal(relatorio.observacoesLegadas.valoresDistintos, 2);
  assert.equal(relatorio.observacoesLegadas.textosComplexos.length, 1, 'texto longo marcado para revisao');

  const complexo = relatorio.observacoesLegadas.textosComplexos[0];
  assert.equal(complexo.endereco, 'BN3');
  assert.equal(complexo.vinculoInequivoco, true);
  assert.equal(complexo.associado.legacyId, '1');

  assert.equal(contar(ctx.db, 'comprovante'), 0);
  assert.equal(contar(ctx.db, 'pendencia'), 0);
  assertSemEfeitoFinanceiro(ctx.db);
});

test('formulas sao inventariadas por texto exato e por padrao', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'formulas.xlsx', (ws) => {
    ws.getCell('A3').value = { formula: 'ROW(A3)', result: 3 };
    ws.getCell('B3').value = 'Maria';
    ws.getCell('C3').value = { formula: 'SUM(D3:E3)', result: 10 };
    ws.getCell('C4').value = { formula: 'SUM(D4:E4)', result: 20 };
  });

  const relatorio = diagnosticarLegado(ctx.db, importacaoId);

  assert.equal(relatorio.formulas.total, 3);
  assert.equal(relatorio.formulas.distintas, 3);
  // 'SUM(D3:E3)' e 'SUM(D4:E4)' compartilham o mesmo padrao.
  const padroes = new Map(relatorio.formulas.padroes.map((item) => [item.padrao, item]));
  assert.equal(padroes.get('SUM(#REF:#REF)').ocorrencias, 2);
  assert.equal(padroes.get('SUM(#REF:#REF)').formulasDistintas, 2);
  // O padrao carrega amostra propria: quando toda formula e distinta, a lista por
  // texto exato pode ser truncada e o padrao vira a via de rastreio.
  assert.equal(padroes.get('SUM(#REF:#REF)').amostras[0].endereco, 'C3');
  assert.equal(padroes.get('SUM(#REF:#REF)').amostras[0].formula, 'SUM(D3:E3)');
  assert.deepEqual(padroes.get('SUM(#REF:#REF)').colunas, { C: 2 });
  assert.equal(relatorio.formulas.porColuna.C, 2);
  assert.equal(relatorio.formulas.saldoOficial, undefined);
  assert.match(relatorio.formulas.observacao, /nunca saldo/);
});

test('o relatorio declara explicitamente o que continua TO CONFIRM', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'to-confirm.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria';
  });

  const relatorio = diagnosticarLegado(ctx.db, importacaoId);

  assert.equal(relatorio.naoInterpretado.situacao, 'to_confirm');
  assert.ok(relatorio.naoInterpretado.itens.length >= 7);
  assert.ok(relatorio.naoInterpretado.itens.some((item) => /'a' e 'i'/.test(item)));
});

test('o diagnostico pode rodar sem persistir nada', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'sem-persistir.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria';
  });

  const antes = resultadoBruto(ctx.db, importacaoId);
  const relatorio = diagnosticarLegado(ctx.db, importacaoId, { persistir: false });

  assert.ok(relatorio.versaoDiagnostico);
  assert.equal(resultadoBruto(ctx.db, importacaoId), antes, 'nada foi gravado');
});
