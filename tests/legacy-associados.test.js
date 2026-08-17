'use strict';

// Fase 1B — materializacao auditavel de associados a partir de A/B.
//
// A suite NUNCA usa a planilha real: cada teste gera o proprio .xlsx e roda a
// importacao bruta da Fase 1A antes de materializar.
//
// Alem de verificar o que e criado, os testes verificam o que NAO pode
// acontecer: nada financeiro, nenhuma sobrescrita de nome, nenhuma escolha
// silenciosa diante de ambiguidade.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { createMigratedDb } = require('./helpers/temp-db');
const { escreverWorkbook } = require('./helpers/workbook');
const { importarPlanilhaLegada } = require('../src/import/legacy-importer');
const {
  materializarAssociados,
  OCORRENCIA,
  PAPEL_LEGACY_ID,
  PAPEL_NOME,
} = require('../src/import/associate-materializer');

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

function assertSemEfeitoFinanceiro(db) {
  for (const tabela of TABELAS_FINANCEIRAS) {
    assert.equal(contar(db, tabela), 0, `a fase cadastral nao pode popular ${tabela}`);
  }
}

/** Importa um workbook gerado na hora e devolve o importacao_id. */
async function importarFixture(ctx, nome, montar) {
  const arquivo = path.join(ctx.dir, nome);
  await escreverWorkbook(arquivo, montar);
  const resumo = await importarPlanilhaLegada(ctx.db, arquivo);
  assert.equal(resumo.duplicada, false, `fixture ${nome} deveria ser uma importacao nova`);
  return resumo.importacaoId;
}

function associados(db) {
  return db.prepare('SELECT * FROM associado ORDER BY legacy_id').all();
}

function linksDoAssociado(db, associadoId) {
  return db
    .prepare(
      `SELECT l.papel, c.endereco, c.coluna, c.importacao_id
         FROM legacy_cell_link l
         JOIN legacy_cell c ON c.id = l.legacy_cell_id
        WHERE l.entidade_tipo = 'associado' AND l.entidade_id = ?
        ORDER BY c.importacao_id, l.papel`
    )
    .all(associadoId);
}

function codigos(relatorio) {
  return relatorio.ocorrencias.map((ocorrencia) => ocorrencia.codigo);
}

// ---------------------------------------------------------------------------
// Teste 1 — criacao basica
// ---------------------------------------------------------------------------
test('materializa associados determinísticos de A/B', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'basico.xlsx', (ws) => {
    ws.getCell('A1').value = 1;
    ws.getCell('B1').value = 'Maria';
    ws.getCell('A2').value = 2;
    ws.getCell('B2').value = 'João';
  });

  const relatorio = materializarAssociados(ctx.db, importacaoId);

  assert.equal(relatorio.candidatos, 2);
  assert.equal(relatorio.associadosCriados, 2);
  assert.equal(relatorio.associadosExistentes, 0);
  assert.equal(relatorio.ocorrenciasRevisao, 0);

  const criados = associados(ctx.db);
  assert.equal(criados.length, 2);
  assert.equal(criados[0].legacy_id, '1');
  assert.equal(criados[0].nome, 'Maria');
  assert.equal(criados[1].legacy_id, '2');
  assert.equal(criados[1].nome, 'João', 'acentuacao preservada sem correcao');

  // Nenhum campo de dominio foi preenchido artificialmente.
  assert.equal(criados[0].status_cadastral, 'indefinido', 'default neutro do schema');
  assert.equal(criados[0].legacy_status_code, null, 'C-01 continua TO CONFIRM');
  assert.equal(criados[0].observacoes, null);

  assertSemEfeitoFinanceiro(ctx.db);
});

// ---------------------------------------------------------------------------
// Teste 2 — links de proveniencia
// ---------------------------------------------------------------------------
test('cada associado aponta para a celula A do ID e a celula B do nome', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'proveniencia.xlsx', (ws) => {
    ws.getCell('A5').value = 15;
    ws.getCell('B5').value = 'Maria Silva';
  });

  const relatorio = materializarAssociados(ctx.db, importacaoId);
  assert.equal(relatorio.linksCriados, 2);

  const [associado] = associados(ctx.db);
  const links = linksDoAssociado(ctx.db, associado.id);

  assert.equal(links.length, 2, 'exatamente 2 links: um para A, outro para B');

  const porPapel = new Map(links.map((link) => [link.papel, link]));
  assert.equal(porPapel.get(PAPEL_LEGACY_ID).endereco, 'A5', 'A5 forneceu o legacy_id');
  assert.equal(porPapel.get(PAPEL_LEGACY_ID).coluna, 1);
  assert.equal(porPapel.get(PAPEL_NOME).endereco, 'B5', 'B5 forneceu o nome');
  assert.equal(porPapel.get(PAPEL_NOME).coluna, 2);

  assert.equal(contar(ctx.db, 'legacy_cell_link'), 2, 'nenhum vinculo extra');
});

// ---------------------------------------------------------------------------
// Teste 3 — idempotencia da mesma importacao
// ---------------------------------------------------------------------------
test('materializar duas vezes a mesma importacao nao duplica nada', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'idempotente.xlsx', (ws) => {
    ws.getCell('A1').value = 1;
    ws.getCell('B1').value = 'Maria';
    ws.getCell('A2').value = 2;
    ws.getCell('B2').value = 'João';
  });

  const primeira = materializarAssociados(ctx.db, importacaoId);
  const associadosApos1 = contar(ctx.db, 'associado');
  const linksApos1 = contar(ctx.db, 'legacy_cell_link');

  const segunda = materializarAssociados(ctx.db, importacaoId);

  assert.equal(contar(ctx.db, 'associado'), associadosApos1, 'COUNT(associado) inalterado');
  assert.equal(contar(ctx.db, 'legacy_cell_link'), linksApos1, 'COUNT(link) inalterado');

  assert.equal(primeira.associadosCriados, 2);
  assert.equal(segunda.associadosCriados, 0, 'nada novo na segunda execucao');
  assert.equal(segunda.associadosExistentes, 2, 'os dois foram reconhecidos como existentes');
  assert.equal(segunda.linksCriados, 0, 'nenhum link duplicado');
  assert.equal(segunda.ocorrenciasRevisao, 0, 'reexecutar nao pode inventar conflito');
});

// ---------------------------------------------------------------------------
// Teste 4 — nova importacao, mesmo associado
// ---------------------------------------------------------------------------
test('duas importacoes com o mesmo ID/nome compartilham um unico associado', async (t) => {
  const ctx = createMigratedDb(t);

  const primeiraId = await importarFixture(ctx, 'arquivo-1.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria';
  });
  // Conteudo cadastral igual, bytes diferentes => outra importacao.
  const segundaId = await importarFixture(ctx, 'arquivo-2.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria';
    ws.getCell('D9').value = 'diferenca irrelevante para o cadastro';
  });

  assert.notEqual(primeiraId, segundaId);

  materializarAssociados(ctx.db, primeiraId);
  const relatorio = materializarAssociados(ctx.db, segundaId);

  assert.equal(contar(ctx.db, 'associado'), 1, 'o associado nao se duplica por arquivo');
  assert.equal(relatorio.associadosCriados, 0);
  assert.equal(relatorio.associadosExistentes, 1);
  assert.equal(relatorio.linksCriados, 2, 'a nova proveniencia tambem e registrada');

  const [associado] = associados(ctx.db);
  const links = linksDoAssociado(ctx.db, associado.id);
  assert.equal(links.length, 4, '2 celulas por importacao, das duas importacoes');

  const importacoesVinculadas = new Set(links.map((link) => link.importacao_id));
  assert.deepEqual([...importacoesVinculadas].sort(), [primeiraId, segundaId].sort());
});

// ---------------------------------------------------------------------------
// Teste 5 — mesmo legacy_id com nome diferente
// ---------------------------------------------------------------------------
test('nome divergente para o mesmo legacy_id nao sobrescreve e vira conflito', async (t) => {
  const ctx = createMigratedDb(t);

  const primeiraId = await importarFixture(ctx, 'conflito-1.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria Silva';
  });
  const segundaId = await importarFixture(ctx, 'conflito-2.xlsx', (ws) => {
    ws.getCell('A3').value = 1;
    ws.getCell('B3').value = 'Maria Souza';
  });

  materializarAssociados(ctx.db, primeiraId);
  const relatorio = materializarAssociados(ctx.db, segundaId);

  const [associado] = associados(ctx.db);
  assert.equal(contar(ctx.db, 'associado'), 1);
  assert.equal(associado.nome, 'Maria Silva', 'o nome original NAO pode ser sobrescrito');

  assert.equal(relatorio.associadosCriados, 0);
  assert.equal(relatorio.associadosExistentes, 0);
  assert.equal(relatorio.linksCriados, 0, 'conflito nao gera vinculo enganoso');
  assert.deepEqual(codigos(relatorio), [OCORRENCIA.LEGACY_ID_NAME_CONFLICT]);

  const [conflito] = relatorio.ocorrencias;
  assert.equal(conflito.legacyIdCandidato, '1');
  assert.equal(conflito.nomeExistente, 'Maria Silva');
  assert.equal(conflito.nomeCandidato, 'Maria Souza');
  assert.equal(conflito.associadoExistenteId, associado.id);
  assert.equal(conflito.linha, 3);
  assert.equal(conflito.celulaLegacyId.endereco, 'A3', 'proveniencia da celula A');
  assert.equal(conflito.celulaNome.endereco, 'B3', 'proveniencia da celula B');

  // Nenhuma decisao automatica: nem correcao, nem transferencia, nem novo cadastro.
  assertSemEfeitoFinanceiro(ctx.db);
});

// ---------------------------------------------------------------------------
// Teste 6 — duplicate_legacy_id
// ---------------------------------------------------------------------------
test('legacy_id repetido na mesma importacao nao e resolvido arbitrariamente', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'duplicado.xlsx', (ws) => {
    ws.getCell('A1').value = 1;
    ws.getCell('B1').value = 'Maria';
    ws.getCell('A2').value = 1;
    ws.getCell('B2').value = 'Maria';
  });

  const relatorio = materializarAssociados(ctx.db, importacaoId);

  assert.equal(contar(ctx.db, 'associado'), 0, 'nenhuma das duas linhas pode ser escolhida');
  assert.equal(relatorio.candidatos, 2);
  assert.equal(relatorio.associadosCriados, 0);
  assert.deepEqual(codigos(relatorio), [
    OCORRENCIA.DUPLICATE_LEGACY_ID,
    OCORRENCIA.DUPLICATE_LEGACY_ID,
  ]);

  const linhasRelatadas = relatorio.ocorrencias.map((ocorrencia) => ocorrencia.linha).sort();
  assert.deepEqual(linhasRelatadas, [1, 2], 'as duas linhas permanecem visiveis');
});

// ---------------------------------------------------------------------------
// Teste 7 — missing_name
// ---------------------------------------------------------------------------
test('ID sem nome nao cria cadastro incompleto', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'sem-nome.xlsx', (ws) => {
    ws.getCell('A1').value = 1;
    ws.getCell('B1').value = null;
    ws.getCell('A2').value = 2;
    ws.getCell('B2').value = '   '; // so espacos: vazio para efeito de nome
  });

  const relatorio = materializarAssociados(ctx.db, importacaoId);

  assert.equal(contar(ctx.db, 'associado'), 0);
  assert.deepEqual(codigos(relatorio), [OCORRENCIA.MISSING_NAME, OCORRENCIA.MISSING_NAME]);
  assert.equal(relatorio.ocorrencias[0].legacyIdCandidato, '1');
  assert.equal(relatorio.ocorrencias[0].celulaLegacyId.endereco, 'A1');
});

// ---------------------------------------------------------------------------
// Teste 8 — missing_legacy_id
// ---------------------------------------------------------------------------
test('nome sem ID nao gera identificador', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'sem-id.xlsx', (ws) => {
    ws.getCell('B1').value = 'Maria';
  });

  const relatorio = materializarAssociados(ctx.db, importacaoId);

  assert.equal(contar(ctx.db, 'associado'), 0);
  assert.deepEqual(codigos(relatorio), [OCORRENCIA.MISSING_LEGACY_ID]);
  assert.equal(relatorio.ocorrencias[0].celulaNome.endereco, 'B1');
  assert.equal(relatorio.ocorrencias[0].celulaLegacyId, null);
});

// ---------------------------------------------------------------------------
// Teste 9 — IDs invalidos
// ---------------------------------------------------------------------------
test('IDs invalidos nao sao convertidos por heuristica', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'ids-invalidos.xlsx', (ws) => {
    ws.getCell('A1').value = 1.5;
    ws.getCell('B1').value = 'Decimal';
    ws.getCell('A2').value = -2;
    ws.getCell('B2').value = 'Negativo';
    ws.getCell('A3').value = '12A';
    ws.getCell('B3').value = 'Texto misturado';
    ws.getCell('A4').value = '01';
    ws.getCell('B4').value = 'Texto que parece numero';
    ws.getCell('A5').value = 0;
    ws.getCell('B5').value = 'Zero';
    ws.getCell('A6').value = true;
    ws.getCell('B6').value = 'Booleano';
  });

  const relatorio = materializarAssociados(ctx.db, importacaoId);

  assert.equal(contar(ctx.db, 'associado'), 0, 'nenhum ID invalido vira cadastro');
  assert.equal(relatorio.candidatos, 0);
  assert.equal(relatorio.ocorrenciasRevisao, 6);
  assert.deepEqual(
    new Set(codigos(relatorio)),
    new Set([OCORRENCIA.INVALID_LEGACY_ID]),
    'todos classificados com codigo estruturado'
  );

  const porLinha = new Map(relatorio.ocorrencias.map((o) => [o.linha, o]));
  assert.equal(porLinha.get(1).celulaLegacyId.valorBruto, '1.5');
  assert.equal(porLinha.get(3).celulaLegacyId.valorBruto, '12A');
  assert.equal(porLinha.get(4).celulaLegacyId.valorBruto, '01', 'texto "01" nao vira id 1');
});

test('nome de tipo inutilizavel vira invalid_name em vez de virar cadastro', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'nome-invalido.xlsx', (ws) => {
    ws.getCell('A1').value = 1;
    ws.getCell('B1').value = { formula: 'CONCATENATE("Ma","ria")', result: 'Maria' };
    ws.getCell('A2').value = 2;
    ws.getCell('B2').value = true;
  });

  const relatorio = materializarAssociados(ctx.db, importacaoId);

  assert.equal(contar(ctx.db, 'associado'), 0, 'nome vindo de formula nao e aceito');
  assert.deepEqual(codigos(relatorio), [OCORRENCIA.INVALID_NAME, OCORRENCIA.INVALID_NAME]);
});

// ---------------------------------------------------------------------------
// legacy_id vindo de formula: opt-in explicito
// ---------------------------------------------------------------------------
test('legacy_id que so existe como resultado de formula exige opt-in humano', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'id-formula.xlsx', (ws) => {
    ws.getCell('A1').value = { formula: 'ROW(A1)', result: 1 };
    ws.getCell('B1').value = 'Maria';
  });

  const conservador = materializarAssociados(ctx.db, importacaoId);
  assert.equal(contar(ctx.db, 'associado'), 0, 'por padrao a formula nao vira identidade');
  assert.deepEqual(codigos(conservador), [OCORRENCIA.LEGACY_ID_FROM_FORMULA]);
  assert.equal(conservador.ocorrencias[0].legacyIdCandidato, '1');
  assert.equal(conservador.ocorrencias[0].celulaLegacyId.formula, 'ROW(A1)');

  const explicito = materializarAssociados(ctx.db, importacaoId, { aceitarIdDeFormula: true });
  assert.equal(explicito.associadosCriados, 1, 'com opt-in explicito o cadastro e criado');
  assert.equal(explicito.ocorrenciasRevisao, 0);

  const [associado] = associados(ctx.db);
  assert.equal(associado.legacy_id, '1');
  assert.equal(associado.nome, 'Maria');
});

// ---------------------------------------------------------------------------
// Teste 10 — nenhuma tabela financeira alterada
// ---------------------------------------------------------------------------
test('a materializacao e exclusivamente cadastral', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'cadastral.xlsx', (ws) => {
    ws.getCell('A1').value = 1;
    ws.getCell('B1').value = 'Maria';
    // Colunas de pagamento e o bloco BL:BN existem no arquivo e devem ser ignorados.
    ws.getCell('C1').value = 40.02;
    ws.getCell('D1').value = 'ok';
    ws.getCell('BL1').value = 'MARIA CONSOLIDADA';
    ws.getCell('BM1').value = 'a';
    ws.getCell('BN1').value = 'DESLIGADO';
  });

  materializarAssociados(ctx.db, importacaoId);

  assertSemEfeitoFinanceiro(ctx.db);
  assert.equal(contar(ctx.db, 'pendencia'), 0, 'nem pendencia e inferida nesta fase');

  const [associado] = associados(ctx.db);
  assert.equal(associado.nome, 'Maria', 'BL nao substitui B');
  assert.equal(associado.legacy_status_code, null, 'BM nao e interpretado');
  assert.equal(associado.status_cadastral, 'indefinido', 'BN nao vira status');

  // Nenhuma celula fora de A/B foi vinculada ao associado.
  const colunasVinculadas = ctx.db
    .prepare(
      `SELECT DISTINCT c.coluna
         FROM legacy_cell_link l JOIN legacy_cell c ON c.id = l.legacy_cell_id
        ORDER BY c.coluna`
    )
    .all()
    .map((linha) => linha.coluna);
  assert.deepEqual(colunasVinculadas, [1, 2], 'somente A e B geram proveniencia de associado');
});

// ---------------------------------------------------------------------------
// Teste 11 — rollback
// ---------------------------------------------------------------------------
test('erro no meio da materializacao nao deixa estado parcial', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'rollback.xlsx', (ws) => {
    for (let linha = 1; linha <= 10; linha += 1) {
      ws.getCell(`A${linha}`).value = linha;
      ws.getCell(`B${linha}`).value = `Associado ${linha}`;
    }
  });

  const resultadoAntes = ctx.db
    .prepare('SELECT resultado FROM importacao WHERE id = ?')
    .get(importacaoId).resultado;

  // Falha injetada no BANCO, nao no codigo de producao: a partir do terceiro
  // associado qualquer INSERT aborta.
  ctx.db.exec(`
    CREATE TRIGGER teste_falha_apos_dois_associados
    BEFORE INSERT ON associado
    WHEN (SELECT COUNT(*) FROM associado) >= 2
    BEGIN
      SELECT RAISE(ABORT, 'falha simulada no meio da materializacao');
    END;
  `);

  assert.throws(
    () => materializarAssociados(ctx.db, importacaoId),
    /falha simulada no meio da materializacao/
  );

  assert.equal(contar(ctx.db, 'associado'), 0, 'nenhum associado parcial');
  assert.equal(contar(ctx.db, 'legacy_cell_link'), 0, 'nenhum link parcial');
  assert.equal(ctx.db.inTransaction, false, 'a transacao nao pode ficar aberta');

  const resultadoDepois = ctx.db
    .prepare('SELECT resultado FROM importacao WHERE id = ?')
    .get(importacaoId).resultado;
  assert.equal(resultadoDepois, resultadoAntes, 'resultado nao pode ser parcialmente atualizado');
  assert.equal(JSON.parse(resultadoDepois).associados, undefined);

  // Removido o problema, a operacao roda inteira.
  ctx.db.exec('DROP TRIGGER teste_falha_apos_dois_associados');
  const relatorio = materializarAssociados(ctx.db, importacaoId);
  assert.equal(relatorio.associadosCriados, 10);
  assert.equal(contar(ctx.db, 'legacy_cell_link'), 20);
});

// ---------------------------------------------------------------------------
// Teste 12 — preservacao do resultado anterior
// ---------------------------------------------------------------------------
test('o resultado da Fase 1A e preservado e o namespace de associados e acrescentado', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'resultado.xlsx', (ws) => {
    ws.getCell('A1').value = 1;
    ws.getCell('B1').value = 'Maria';
  });

  const antes = JSON.parse(
    ctx.db.prepare('SELECT resultado FROM importacao WHERE id = ?').get(importacaoId).resultado
  );
  assert.ok(antes.abas, 'a fase 1A gravou seu proprio resultado');
  assert.ok(antes.totais);
  assert.equal(antes.associados, undefined);

  materializarAssociados(ctx.db, importacaoId);

  const depois = JSON.parse(
    ctx.db.prepare('SELECT resultado FROM importacao WHERE id = ?').get(importacaoId).resultado
  );

  assert.deepEqual(depois.abas, antes.abas, 'resultado anterior intacto');
  assert.deepEqual(depois.totais, antes.totais, 'totais da fase 1A intactos');
  assert.equal(depois.versaoImportador, antes.versaoImportador);

  assert.ok(depois.associados, 'namespace de associados acrescentado');
  assert.equal(depois.associados.importacaoId, importacaoId);
  assert.equal(depois.associados.associadosCriados, 1);
  assert.equal(depois.associados.linksCriados, 2);
  assert.equal(depois.associados.linhasAnalisadas, 1);
  assert.equal(depois.associados.ocorrenciasRevisao, 0);
  assert.ok(depois.associados.versaoMaterializador);
});

// ---------------------------------------------------------------------------
// Entrada invalida
// ---------------------------------------------------------------------------
test('importacao inexistente ou nao concluida falha de forma clara', (t) => {
  const ctx = createMigratedDb(t);

  assert.throws(() => materializarAssociados(ctx.db, 999), /nao encontrada/i);
  assert.throws(() => materializarAssociados(ctx.db, 'abc'), /importacao_id invalido/i);

  ctx.db
    .prepare(
      "INSERT INTO importacao (nome_arquivo, sha256, versao_importador, status) VALUES (?, ?, 'teste', 'falhou')"
    )
    .run('parcial.xlsx', 'b'.repeat(64));

  assert.throws(() => materializarAssociados(ctx.db, 1), /status "falhou"/);
  assert.equal(contar(ctx.db, 'associado'), 0);
});

test('resultado nao estruturado aborta em vez de ser sobrescrito', (t) => {
  const ctx = createMigratedDb(t);

  ctx.db
    .prepare(
      `INSERT INTO importacao (nome_arquivo, sha256, versao_importador, status, resultado)
       VALUES (?, ?, 'teste', 'concluida', ?)`
    )
    .run('legado.xlsx', 'c'.repeat(64), 'relatorio em texto puro, nao JSON');

  assert.throws(() => materializarAssociados(ctx.db, 1), /nao e um objeto JSON/);

  const preservado = ctx.db.prepare('SELECT resultado FROM importacao WHERE id = 1').get().resultado;
  assert.equal(preservado, 'relatorio em texto puro, nao JSON', 'conteudo anterior intacto');
});

test('linhas sem conteudo em A e B nao entram na analise', async (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = await importarFixture(ctx, 'esparso.xlsx', (ws) => {
    ws.getCell('A1').value = 1;
    ws.getCell('B1').value = 'Maria';
    // Linha 5 so tem conteudo fora de A/B: nao e uma linha cadastral.
    ws.getCell('C5').value = 'pagamento qualquer';
  });

  const relatorio = materializarAssociados(ctx.db, importacaoId);

  assert.equal(relatorio.linhasAnalisadas, 1, 'somente a linha com conteudo em A/B');
  assert.equal(relatorio.ocorrenciasRevisao, 0);
  assert.equal(relatorio.associadosCriados, 1);
});
