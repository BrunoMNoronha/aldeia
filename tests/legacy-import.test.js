'use strict';

// Fase 1A — importacao bruta, auditavel e idempotente.
//
// A suite NUNCA usa a planilha real: cada teste gera o proprio .xlsx.
// Alem de verificar o que e gravado, os testes verificam o que NAO pode
// acontecer: nenhuma interpretacao financeira nasce da importacao bruta.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createMigratedDb } = require('./helpers/temp-db');
const { escreverWorkbook, preenchimento } = require('./helpers/workbook');
const { importarPlanilhaLegada, calcularSha256 } = require('../src/import/legacy-importer');

const TABELAS_FINANCEIRAS = ['movimento_financeiro', 'alocacao', 'ajuste_credito_debito'];

function contar(db, tabela) {
  return db.prepare(`SELECT COUNT(*) AS total FROM ${tabela}`).get().total;
}

function celula(db, importacaoId, endereco) {
  return db
    .prepare('SELECT * FROM legacy_cell WHERE importacao_id = ? AND endereco = ?')
    .get(importacaoId, endereco);
}

/** Nada de financeiro pode ter sido criado pela camada bruta. */
function assertSemEfeitoFinanceiro(db) {
  for (const tabela of TABELAS_FINANCEIRAS) {
    assert.equal(contar(db, tabela), 0, `importacao bruta nao pode criar ${tabela}`);
  }
  assert.equal(contar(db, 'associado'), 0, 'importacao bruta nao pode criar associado');
  assert.equal(contar(db, 'competencia'), 0, 'importacao bruta nao pode criar competencia');
}

function shaDoArquivo(caminho) {
  return crypto.createHash('sha256').update(fs.readFileSync(caminho)).digest('hex');
}

// ---------------------------------------------------------------------------
// Teste 1 — importacao basica
// ---------------------------------------------------------------------------
test('importa um xlsx preservando aba, endereco e valor bruto', async (t) => {
  const ctx = createMigratedDb(t);
  const arquivo = path.join(ctx.dir, 'basico.xlsx');

  await escreverWorkbook(
    arquivo,
    (ws) => {
      ws.getCell('A1').value = 'texto';
      ws.getCell('B2').value = 1234;
      ws.getCell('C3').value = 'ok';
      ws.getCell('D4').value = 'c20';
    },
    { aba: 'Pagina1' }
  );

  const resumo = await importarPlanilhaLegada(ctx.db, arquivo);

  assert.equal(resumo.duplicada, false);
  assert.equal(contar(ctx.db, 'importacao'), 1);

  const importacao = ctx.db.prepare('SELECT * FROM importacao WHERE id = ?').get(resumo.importacaoId);
  assert.equal(importacao.nome_arquivo, 'basico.xlsx');
  assert.equal(importacao.sha256, shaDoArquivo(arquivo), 'hash gravado = hash dos bytes do arquivo');
  assert.equal(importacao.status, 'concluida');
  assert.ok(importacao.importado_em, 'timestamp de importacao registrado');
  assert.ok(importacao.versao_importador, 'versao do importador registrada');

  const abas = ctx.db
    .prepare('SELECT DISTINCT aba FROM legacy_cell WHERE importacao_id = ?')
    .all(resumo.importacaoId)
    .map((linha) => linha.aba);
  assert.deepEqual(abas, ['Pagina1'], 'nome da aba preservado');

  const a1 = celula(ctx.db, resumo.importacaoId, 'A1');
  assert.equal(a1.valor_bruto, 'texto');
  assert.equal(a1.linha, 1);
  assert.equal(a1.coluna, 1);
  assert.equal(a1.tipo_original, 'texto');

  const b2 = celula(ctx.db, resumo.importacaoId, 'B2');
  assert.equal(b2.valor_bruto, '1234');
  assert.equal(b2.tipo_original, 'numero');
  assert.deepEqual(JSON.parse(b2.valor_json), { tipo: 'numero', valor: 1234 });

  assert.equal(celula(ctx.db, resumo.importacaoId, 'C3').valor_bruto, 'ok');
  assert.equal(celula(ctx.db, resumo.importacaoId, 'D4').valor_bruto, 'c20');

  assertSemEfeitoFinanceiro(ctx.db);
});

// ---------------------------------------------------------------------------
// Teste 2 — idempotencia por conteudo
// ---------------------------------------------------------------------------
test('reimportar o mesmo arquivo nao duplica importacao nem celulas', async (t) => {
  const ctx = createMigratedDb(t);
  const arquivo = path.join(ctx.dir, 'idempotente.xlsx');

  await escreverWorkbook(arquivo, (ws) => {
    ws.getCell('A1').value = 'linha unica';
    ws.getCell('B1').value = 10;
  });

  const primeira = await importarPlanilhaLegada(ctx.db, arquivo);
  const celulasApos1 = contar(ctx.db, 'legacy_cell');

  const segunda = await importarPlanilhaLegada(ctx.db, arquivo);

  assert.equal(segunda.duplicada, true, 'segunda execucao deve ser reconhecida como duplicada');
  assert.equal(segunda.importacaoId, primeira.importacaoId, 'aponta para a importacao original');
  assert.equal(segunda.sha256, primeira.sha256);

  assert.equal(contar(ctx.db, 'importacao'), 1, 'COUNT(importacao) = 1');
  assert.equal(contar(ctx.db, 'legacy_cell'), celulasApos1, 'nenhuma celula duplicada');
});

test('o banco recusa uma segunda importacao com o mesmo sha256 (constraint, nao so JS)', (t) => {
  const ctx = createMigratedDb(t);
  const sha = 'a'.repeat(64);
  const inserir = ctx.db.prepare(
    "INSERT INTO importacao (nome_arquivo, sha256, versao_importador) VALUES (?, ?, 'teste')"
  );

  inserir.run('primeiro.xlsx', sha);

  assert.throws(() => inserir.run('segundo.xlsx', sha), /UNIQUE/i);
});

// ---------------------------------------------------------------------------
// Teste 3 — mesmo conteudo, nome diferente
// ---------------------------------------------------------------------------
test('mesmo conteudo com outro nome e reconhecido pelo hash', async (t) => {
  const ctx = createMigratedDb(t);
  const original = path.join(ctx.dir, 'controle.xlsx');
  const copia = path.join(ctx.dir, 'copia.xlsx');

  await escreverWorkbook(original, (ws) => {
    ws.getCell('A1').value = 'conteudo identico';
  });
  fs.copyFileSync(original, copia);

  assert.equal(shaDoArquivo(original), shaDoArquivo(copia), 'bytes iguais => mesmo sha256');

  const primeira = await importarPlanilhaLegada(ctx.db, original);
  const celulas = contar(ctx.db, 'legacy_cell');

  const segunda = await importarPlanilhaLegada(ctx.db, copia);

  assert.equal(segunda.duplicada, true);
  assert.equal(segunda.importacaoId, primeira.importacaoId);
  assert.equal(
    segunda.nomeArquivoOriginal,
    'controle.xlsx',
    'a resposta mostra sob qual nome o conteudo ja havia entrado'
  );

  assert.equal(contar(ctx.db, 'importacao'), 1);
  assert.equal(contar(ctx.db, 'legacy_cell'), celulas);
});

// ---------------------------------------------------------------------------
// Teste 4 — valores ambiguos permanecem brutos
// ---------------------------------------------------------------------------
test('valores ambiguos entram intactos e sem normalizacao financeira', async (t) => {
  const ctx = createMigratedDb(t);
  const arquivo = path.join(ctx.dir, 'ambiguos.xlsx');

  await escreverWorkbook(arquivo, (ws) => {
    ws.getCell('A1').value = 40.02; // numero
    ws.getCell('A2').value = '40,02'; // texto com virgula
    ws.getCell('A3').value = 'ok';
    ws.getCell('A4').value = 'c20';
    ws.getCell('A5').value = 'f15';
    ws.getCell('A6').value = 'LG';
  });

  const resumo = await importarPlanilhaLegada(ctx.db, arquivo);

  const esperado = [
    ['A1', '40.02', 'numero'],
    ['A2', '40,02', 'texto'],
    ['A3', 'ok', 'texto'],
    ['A4', 'c20', 'texto'],
    ['A5', 'f15', 'texto'],
    ['A6', 'LG', 'texto'],
  ];

  for (const [endereco, valor, tipo] of esperado) {
    const linha = celula(ctx.db, resumo.importacaoId, endereco);
    assert.equal(linha.valor_bruto, valor, `${endereco} deve permanecer bruto`);
    assert.equal(linha.tipo_original, tipo, `${endereco} deve preservar o tipo original`);
    assert.equal(linha.classificacao, null, `${endereco} nao pode receber classificacao automatica`);
    assert.equal(linha.estado_revisao, 'nao_revisado', `${endereco} nao pode nascer revisado`);
  }

  // 40.02 (numero) e '40,02' (texto) continuam distinguiveis apos gravados.
  const numero = celula(ctx.db, resumo.importacaoId, 'A1');
  const texto = celula(ctx.db, resumo.importacaoId, 'A2');
  assert.deepEqual(JSON.parse(numero.valor_json), { tipo: 'numero', valor: 40.02 });
  assert.deepEqual(JSON.parse(texto.valor_json), { tipo: 'texto', valor: '40,02' });

  // Nenhuma coluna monetaria foi tocada (T-06).
  assertSemEfeitoFinanceiro(ctx.db);
  assert.equal(contar(ctx.db, 'pendencia'), 0, 'nesta fase nem pendencia e inferida');
});

// ---------------------------------------------------------------------------
// Teste 5 — formula
// ---------------------------------------------------------------------------
test('formula legada e preservada como evidencia e nao gera evento financeiro', async (t) => {
  const ctx = createMigratedDb(t);
  const arquivo = path.join(ctx.dir, 'formula.xlsx');

  await escreverWorkbook(arquivo, (ws) => {
    ws.getCell('A1').value = 100;
    ws.getCell('A2').value = 50;
    ws.getCell('A3').value = { formula: 'SUM(A1:A2)', result: 150 };
  });

  const resumo = await importarPlanilhaLegada(ctx.db, arquivo);

  const total = celula(ctx.db, resumo.importacaoId, 'A3');
  assert.equal(total.tipo_original, 'formula');
  assert.equal(total.formula, 'SUM(A1:A2)', 'expressao da formula preservada');
  assert.equal(total.valor_bruto, '150', 'cache do resultado preservado');

  const payload = JSON.parse(total.valor_json);
  assert.equal(payload.tipo, 'formula');
  assert.equal(payload.formula, 'SUM(A1:A2)');
  assert.equal(payload.resultado, 150);

  // O total parcial da planilha nao vira saldo.
  assertSemEfeitoFinanceiro(ctx.db);
});

// ---------------------------------------------------------------------------
// Teste 6 — estilo sem conteudo
// ---------------------------------------------------------------------------
test('celula vazia com preenchimento nao e descartada, e a cor nao e interpretada', async (t) => {
  const ctx = createMigratedDb(t);
  const arquivo = path.join(ctx.dir, 'estilo.xlsx');

  await escreverWorkbook(arquivo, (ws) => {
    ws.getCell('A1').value = 'ancora';
    ws.getCell('C3').fill = preenchimento('FFFF0000'); // vermelha e VAZIA
    ws.getCell('E5').value = 'fim';
  });

  const resumo = await importarPlanilhaLegada(ctx.db, arquivo);

  const pintada = celula(ctx.db, resumo.importacaoId, 'C3');
  assert.ok(pintada, 'celula vazia com preenchimento deve ser persistida');
  assert.equal(pintada.valor_bruto, null, 'ela nao tem valor, e isso e preservado como tal');
  assert.equal(pintada.tipo_original, 'vazio');

  assert.ok(pintada.estilo, 'evidencia de estilo nao pode ser descartada');
  const estilo = JSON.parse(pintada.estilo);
  assert.equal(estilo.fill.pattern, 'solid');
  assert.equal(estilo.fill.fgColor.argb, 'FFFF0000', 'a cor original fica registrada');

  // C-05: cor sem legenda inequivoca nao vira regra.
  assert.equal(pintada.classificacao, null, 'a cor nao pode virar classificacao automatica');
  assert.equal(pintada.estado_revisao, 'nao_revisado');
  assertSemEfeitoFinanceiro(ctx.db);
});

// ---------------------------------------------------------------------------
// Teste 7 — rollback
// ---------------------------------------------------------------------------
test('erro no meio da importacao nao deixa importacao nem celulas parciais', async (t) => {
  const ctx = createMigratedDb(t);
  const arquivo = path.join(ctx.dir, 'rollback.xlsx');

  await escreverWorkbook(arquivo, (ws) => {
    for (let linha = 1; linha <= 20; linha += 1) {
      ws.getCell(`A${linha}`).value = `valor ${linha}`;
    }
  });

  // Falha injetada no BANCO (nao no codigo de producao): a partir da terceira
  // celula qualquer INSERT aborta, simulando uma constraint violada no meio.
  ctx.db.exec(`
    CREATE TRIGGER teste_falha_apos_duas_celulas
    BEFORE INSERT ON legacy_cell
    WHEN (SELECT COUNT(*) FROM legacy_cell) >= 2
    BEGIN
      SELECT RAISE(ABORT, 'falha simulada no meio da importacao');
    END;
  `);

  await assert.rejects(
    () => importarPlanilhaLegada(ctx.db, arquivo),
    /falha simulada no meio da importacao/
  );

  assert.equal(contar(ctx.db, 'importacao'), 0, 'ROLLBACK deve desfazer a importacao');
  assert.equal(contar(ctx.db, 'legacy_cell'), 0, 'nenhuma celula parcial pode sobrar');
  assert.equal(ctx.db.inTransaction, false, 'a transacao nao pode ficar aberta');

  // Depois do problema resolvido, a mesma importacao roda inteira.
  ctx.db.exec('DROP TRIGGER teste_falha_apos_duas_celulas');
  const resumo = await importarPlanilhaLegada(ctx.db, arquivo);
  assert.equal(resumo.duplicada, false, 'o hash nao ficou registrado pela tentativa que falhou');
  assert.equal(contar(ctx.db, 'legacy_cell'), 20);
});

// ---------------------------------------------------------------------------
// Teste 8 — banco vazio + todas as migrations
// ---------------------------------------------------------------------------
test('banco criado do zero ja nasce apto a importar (migrations 001 + 002)', async (t) => {
  const ctx = createMigratedDb(t);

  assert.equal(fs.existsSync(ctx.dbPath), true, 'o banco foi criado pelas migrations');

  const versoes = ctx.db
    .prepare('SELECT version FROM schema_migration ORDER BY version')
    .all()
    .map((linha) => linha.version);
  assert.ok(versoes.includes('001'), 'migration 001 aplicada');
  assert.ok(versoes.includes('002'), 'migration 002 aplicada');

  const colunas = ctx.db
    .prepare('PRAGMA table_info(legacy_cell)')
    .all()
    .map((linha) => linha.name);
  for (const coluna of ['tipo_original', 'formula', 'texto_formatado', 'valor_json']) {
    assert.ok(colunas.includes(coluna), `legacy_cell.${coluna} ausente apos as migrations`);
  }

  const arquivo = path.join(ctx.dir, 'banco-vazio.xlsx');
  await escreverWorkbook(arquivo, (ws) => {
    ws.getCell('A1').value = 'funciona';
  });

  const resumo = await importarPlanilhaLegada(ctx.db, arquivo);
  assert.equal(resumo.duplicada, false);
  assert.equal(celula(ctx.db, resumo.importacaoId, 'A1').valor_bruto, 'funciona');
});

// ---------------------------------------------------------------------------
// Validacao de entrada
// ---------------------------------------------------------------------------
test('entrada invalida falha de forma clara e sem importacao parcial', async (t) => {
  const ctx = createMigratedDb(t);

  await assert.rejects(() => importarPlanilhaLegada(ctx.db, undefined), /nao informado/i);
  await assert.rejects(
    () => importarPlanilhaLegada(ctx.db, path.join(ctx.dir, 'nao-existe.xlsx')),
    /arquivo nao encontrado/i
  );
  await assert.rejects(() => importarPlanilhaLegada(ctx.db, ctx.dir), /nao e um arquivo/i);

  const invalido = path.join(ctx.dir, 'quebrado.xlsx');
  fs.writeFileSync(invalido, 'isto nao e um workbook');
  await assert.rejects(() => importarPlanilhaLegada(ctx.db, invalido), /workbook/i);

  assert.equal(contar(ctx.db, 'importacao'), 0);
  assert.equal(contar(ctx.db, 'legacy_cell'), 0);
});

test('sha256 e calculado sobre os bytes reais do arquivo', async (t) => {
  const ctx = createMigratedDb(t);
  const arquivo = path.join(ctx.dir, 'hash.xlsx');

  await escreverWorkbook(arquivo, (ws) => {
    ws.getCell('A1').value = 'hash';
  });

  const bytes = fs.readFileSync(arquivo);
  assert.equal(calcularSha256(bytes), shaDoArquivo(arquivo));

  const resumo = await importarPlanilhaLegada(ctx.db, arquivo);
  assert.equal(resumo.sha256, calcularSha256(bytes));
  assert.equal(resumo.sha256.length, 64);
});

test('o resultado registra o intervalo utilizado e o que foi ignorado', async (t) => {
  const ctx = createMigratedDb(t);
  const arquivo = path.join(ctx.dir, 'resultado.xlsx');

  await escreverWorkbook(
    arquivo,
    (ws) => {
      ws.getCell('A1').value = 'inicio';
      ws.getCell('C3').value = 'fim';
    },
    { aba: 'Folha' }
  );

  const resumo = await importarPlanilhaLegada(ctx.db, arquivo);
  const gravado = JSON.parse(
    ctx.db.prepare('SELECT resultado FROM importacao WHERE id = ?').get(resumo.importacaoId).resultado
  );

  assert.equal(gravado.totais.abas, 1);
  assert.equal(gravado.abas[0].nome, 'Folha');
  assert.equal(gravado.abas[0].intervaloUtilizado, 'A1:C3');
  assert.equal(gravado.totais.comValor, 2);
  assert.equal(typeof gravado.totais.ignoradasVaziasSemEstilo, 'number');
  assert.ok(gravado.versaoImportador, 'a versao do importador fica no resultado');
});
