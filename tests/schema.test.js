'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { withTransaction } = require('../src/db/connection');
const { createMigratedDb } = require('./helpers/temp-db');

const COLUNAS_MONETARIAS = [
  ['competencia', 'valor_esperado_centavos'],
  ['movimento_financeiro', 'valor_centavos'],
  ['alocacao', 'valor_centavos'],
  ['ajuste_credito_debito', 'valor_centavos'],
];

function colunas(db, tabela) {
  return db.prepare(`PRAGMA table_info(${tabela})`).all();
}

// --- T-06: dinheiro em centavos inteiros -----------------------------------

test('colunas monetarias sao declaradas INTEGER', (t) => {
  const ctx = createMigratedDb(t);

  for (const [tabela, coluna] of COLUNAS_MONETARIAS) {
    const info = colunas(ctx.db, tabela).find((c) => c.name === coluna);
    assert.ok(info, `coluna ausente: ${tabela}.${coluna}`);
    assert.equal(info.type, 'INTEGER', `${tabela}.${coluna} deve ser INTEGER`);
  }
});

test('nenhuma coluna do schema usa REAL/FLOAT/DOUBLE', (t) => {
  const ctx = createMigratedDb(t);

  const tabelas = ctx.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);

  for (const tabela of tabelas) {
    for (const coluna of colunas(ctx.db, tabela)) {
      assert.doesNotMatch(
        coluna.type.toUpperCase(),
        /REAL|FLOA|DOUB/,
        `${tabela}.${coluna.name} usa tipo de ponto flutuante (${coluna.type})`
      );
    }
  }
});

test('valores monetarios sao persistidos como inteiro', (t) => {
  const ctx = createMigratedDb(t);

  const { lastInsertRowid } = ctx.db
    .prepare('INSERT INTO movimento_financeiro (data, valor_centavos, tipo) VALUES (?, ?, ?)')
    .run('2026-03-01', 2500, 'credito');

  const row = ctx.db
    .prepare('SELECT valor_centavos, typeof(valor_centavos) AS tipo FROM movimento_financeiro WHERE id = ?')
    .get(lastInsertRowid);

  assert.equal(row.tipo, 'integer');
  assert.equal(row.valor_centavos, 2500);
});

// --- M-10: competencia como dado -------------------------------------------

test('competencia aceita anos futuros e rejeita mes invalido', (t) => {
  const ctx = createMigratedDb(t);

  const insert = ctx.db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)');
  for (const ano of [2027, 2028, 2031]) {
    insert.run(ano, 12);
  }

  const total = ctx.db.prepare('SELECT COUNT(*) AS total FROM competencia WHERE ano > 2026').get();
  assert.equal(total.total, 3);

  assert.throws(() => insert.run(2027, 13), /CHECK constraint failed/i);
  assert.throws(() => insert.run(2027, 0), /CHECK constraint failed/i);
  assert.throws(() => insert.run(2027, 12), /UNIQUE constraint failed/i);
});

test('competencia nao esta modelada como colunas mensais', (t) => {
  const ctx = createMigratedDb(t);

  const tabelas = ctx.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name);

  const mensal = /^(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)[_-]?\d{2,4}$/i;
  for (const tabela of tabelas) {
    for (const coluna of colunas(ctx.db, tabela)) {
      assert.doesNotMatch(coluna.name, mensal, `${tabela}.${coluna.name} parece coluna mensal`);
    }
  }
});

// --- M-05: movimento sem associado -----------------------------------------

test('movimento financeiro pode existir sem associado', (t) => {
  const ctx = createMigratedDb(t);

  const { lastInsertRowid } = ctx.db
    .prepare('INSERT INTO movimento_financeiro (data, valor_centavos, tipo, origem) VALUES (?, ?, ?, ?)')
    .run('2026-02-05', 4000, 'credito', 'deposito');

  const row = ctx.db
    .prepare('SELECT associado_id, estado_identificacao FROM movimento_financeiro WHERE id = ?')
    .get(lastInsertRowid);

  assert.equal(row.associado_id, null);
  assert.equal(row.estado_identificacao, 'nao_identificado');
});

// --- M-02: N:N movimento <-> competencia -----------------------------------

test('um movimento pode ter alocacoes em varias competencias', (t) => {
  const ctx = createMigratedDb(t);

  const movimentoId = ctx.db
    .prepare('INSERT INTO movimento_financeiro (data, valor_centavos, tipo) VALUES (?, ?, ?)')
    .run('2026-01-15', 7500, 'credito').lastInsertRowid;

  const competencias = [1, 2, 3].map(
    (mes) => ctx.db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)').run(2026, mes).lastInsertRowid
  );

  withTransaction(ctx.db, (db) => {
    const insert = db.prepare(
      'INSERT INTO alocacao (movimento_id, competencia_id, valor_centavos) VALUES (?, ?, ?)'
    );
    for (const competenciaId of competencias) insert.run(movimentoId, competenciaId, 2500);
  });

  const total = ctx.db
    .prepare('SELECT COUNT(*) AS total, SUM(valor_centavos) AS soma FROM alocacao WHERE movimento_id = ?')
    .get(movimentoId);

  assert.equal(total.total, 3);
  assert.equal(total.soma, 7500);
});

test('uma competencia pode receber alocacoes de varios movimentos', (t) => {
  const ctx = createMigratedDb(t);

  const competenciaId = ctx.db
    .prepare('INSERT INTO competencia (ano, mes, valor_esperado_centavos) VALUES (?, ?, ?)')
    .run(2027, 6, 4000).lastInsertRowid;

  const insertMovimento = ctx.db.prepare(
    'INSERT INTO movimento_financeiro (data, valor_centavos, tipo) VALUES (?, ?, ?)'
  );
  const insertAlocacao = ctx.db.prepare(
    'INSERT INTO alocacao (movimento_id, competencia_id, valor_centavos) VALUES (?, ?, ?)'
  );

  for (const valor of [1500, 2500]) {
    const movimentoId = insertMovimento.run('2027-06-10', valor, 'credito').lastInsertRowid;
    insertAlocacao.run(movimentoId, competenciaId, valor);
  }

  const row = ctx.db
    .prepare(
      'SELECT COUNT(DISTINCT movimento_id) AS movimentos, SUM(valor_centavos) AS soma FROM alocacao WHERE competencia_id = ?'
    )
    .get(competenciaId);

  assert.equal(row.movimentos, 2);
  assert.equal(row.soma, 4000);
});

// --- M-09: correcao por inativacao, sem delete fisico ----------------------

/**
 * Cria uma linha ATIVA de cada entidade financeira sujeita a M-09.
 * @returns {{tabela: string, id: number|bigint}[]}
 */
function criarEntidadesFinanceiras(db) {
  const associadoId = db
    .prepare('INSERT INTO associado (nome) VALUES (?)')
    .run('Associado de Teste M-09').lastInsertRowid;
  const competenciaId = db
    .prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)')
    .run(2029, 3).lastInsertRowid;
  const movimentoId = db
    .prepare('INSERT INTO movimento_financeiro (data, valor_centavos, tipo) VALUES (?, ?, ?)')
    .run('2029-03-01', 2500, 'credito').lastInsertRowid;
  const alocacaoId = db
    .prepare('INSERT INTO alocacao (movimento_id, competencia_id, valor_centavos) VALUES (?, ?, ?)')
    .run(movimentoId, competenciaId, 2500).lastInsertRowid;
  const ajusteId = db
    .prepare(
      'INSERT INTO ajuste_credito_debito (associado_id, tipo, valor_centavos, motivo, data) VALUES (?, ?, ?, ?, ?)'
    )
    .run(associadoId, 'credito', 1000, 'ajuste de teste', '2029-03-02').lastInsertRowid;

  return [
    { tabela: 'movimento_financeiro', id: movimentoId },
    { tabela: 'alocacao', id: alocacaoId },
    { tabela: 'ajuste_credito_debito', id: ajusteId },
  ];
}

test('as tres entidades financeiras possuem motivo_inativacao', (t) => {
  const ctx = createMigratedDb(t);

  for (const tabela of ['movimento_financeiro', 'alocacao', 'ajuste_credito_debito']) {
    const nomes = colunas(ctx.db, tabela).map((c) => c.name);
    assert.ok(nomes.includes('inativado_em'), `${tabela}.inativado_em ausente`);
    assert.ok(nomes.includes('motivo_inativacao'), `${tabela}.motivo_inativacao ausente`);
  }
});

test('entidade financeira nao pode ser inativada sem timestamp e motivo (M-09)', (t) => {
  const ctx = createMigratedDb(t);

  // Cada tentativa omite ou esvazia parte da trilha exigida por M-09.
  const tentativasInvalidas = [
    ['sem timestamp e sem motivo', 'ativo = 0'],
    ['sem motivo', "ativo = 0, inativado_em = '2029-03-10'"],
    ['sem timestamp', "ativo = 0, motivo_inativacao = 'estorno'"],
    ['motivo vazio', "ativo = 0, inativado_em = '2029-03-10', motivo_inativacao = ''"],
    ['motivo so com espacos', "ativo = 0, inativado_em = '2029-03-10', motivo_inativacao = '   '"],
    ['motivo nulo explicito', "ativo = 0, inativado_em = '2029-03-10', motivo_inativacao = NULL"],
  ];

  for (const { tabela, id } of criarEntidadesFinanceiras(ctx.db)) {
    for (const [caso, atribuicoes] of tentativasInvalidas) {
      assert.throws(
        () => ctx.db.prepare(`UPDATE ${tabela} SET ${atribuicoes} WHERE id = ?`).run(id),
        /CHECK constraint failed/i,
        `${tabela}: inativacao ${caso} deveria ser rejeitada`
      );
    }

    const row = ctx.db.prepare(`SELECT ativo FROM ${tabela} WHERE id = ?`).get(id);
    assert.equal(row.ativo, 1, `${tabela} deve continuar ativa apos as tentativas invalidas`);
  }
});

test('entidade financeira nao pode nascer inativa sem timestamp e motivo (M-09)', (t) => {
  const ctx = createMigratedDb(t);

  assert.throws(
    () =>
      ctx.db
        .prepare(
          'INSERT INTO movimento_financeiro (data, valor_centavos, tipo, ativo) VALUES (?, ?, ?, 0)'
        )
        .run('2029-04-01', 2500, 'credito'),
    /CHECK constraint failed/i
  );

  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM movimento_financeiro').get().t, 0);
});

test('entidade financeira aceita inativacao com timestamp e motivo, preservando historico (M-09)', (t) => {
  const ctx = createMigratedDb(t);

  const quando = '2029-03-15T10:00:00Z';
  const porque = 'estorno: lancamento duplicado na conferencia de marco';

  for (const { tabela, id } of criarEntidadesFinanceiras(ctx.db)) {
    ctx.db
      .prepare(
        `UPDATE ${tabela} SET ativo = 0, inativado_em = ?, motivo_inativacao = ? WHERE id = ?`
      )
      .run(quando, porque, id);

    const row = ctx.db
      .prepare(`SELECT ativo, inativado_em, motivo_inativacao FROM ${tabela} WHERE id = ?`)
      .get(id);

    assert.equal(row.ativo, 0, `${tabela} deveria estar inativa`);
    assert.equal(row.inativado_em, quando);
    assert.equal(row.motivo_inativacao, porque);

    // M-09: a linha continua existindo; inativacao nao e exclusao.
    const total = ctx.db.prepare(`SELECT COUNT(*) AS t FROM ${tabela} WHERE id = ?`).get(id);
    assert.equal(total.t, 1, `${tabela}: registro inativado deve permanecer no historico`);
  }
});

test('alocacao inativada libera nova alocacao ativa para a mesma competencia', (t) => {
  const ctx = createMigratedDb(t);

  const movimentoId = ctx.db
    .prepare('INSERT INTO movimento_financeiro (data, valor_centavos, tipo) VALUES (?, ?, ?)')
    .run('2026-04-01', 2500, 'credito').lastInsertRowid;
  const competenciaId = ctx.db
    .prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)')
    .run(2026, 4).lastInsertRowid;

  const insert = ctx.db.prepare(
    'INSERT INTO alocacao (movimento_id, competencia_id, valor_centavos) VALUES (?, ?, ?)'
  );
  const primeira = insert.run(movimentoId, competenciaId, 2500).lastInsertRowid;

  assert.throws(() => insert.run(movimentoId, competenciaId, 2500), /UNIQUE constraint failed/i);

  ctx.db
    .prepare(
      "UPDATE alocacao SET ativo = 0, inativado_em = '2026-04-02', " +
        "motivo_inativacao = 'valor alocado incorretamente na conferencia' WHERE id = ?"
    )
    .run(primeira);
  insert.run(movimentoId, competenciaId, 2000);

  const historico = ctx.db
    .prepare('SELECT COUNT(*) AS total FROM alocacao WHERE movimento_id = ?')
    .get(movimentoId);
  assert.equal(historico.total, 2, 'a alocacao corrigida permanece no historico');
});

test('movimento com alocacao nao pode ser excluido fisicamente', (t) => {
  const ctx = createMigratedDb(t);

  const movimentoId = ctx.db
    .prepare('INSERT INTO movimento_financeiro (data, valor_centavos, tipo) VALUES (?, ?, ?)')
    .run('2026-05-01', 2500, 'credito').lastInsertRowid;
  const competenciaId = ctx.db
    .prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)')
    .run(2026, 5).lastInsertRowid;
  ctx.db
    .prepare('INSERT INTO alocacao (movimento_id, competencia_id, valor_centavos) VALUES (?, ?, ?)')
    .run(movimentoId, competenciaId, 2500);

  assert.throws(
    () => ctx.db.prepare('DELETE FROM movimento_financeiro WHERE id = ?').run(movimentoId),
    /FOREIGN KEY/i
  );
});

// --- M-03: credito/debito estruturado --------------------------------------

test('ajuste exige tipo credito ou debito estruturado', (t) => {
  const ctx = createMigratedDb(t);

  const associadoId = ctx.db
    .prepare('INSERT INTO associado (nome) VALUES (?)')
    .run('Fulana de Teste').lastInsertRowid;

  const insert = ctx.db.prepare(
    'INSERT INTO ajuste_credito_debito (associado_id, tipo, valor_centavos, motivo, data) VALUES (?, ?, ?, ?, ?)'
  );
  insert.run(associadoId, 'credito', 1000, 'pagamento a maior', '2026-01-20');
  insert.run(associadoId, 'debito', 500, 'taxa', '2026-01-21');

  assert.throws(
    () => insert.run(associadoId, 'texto livre', 500, 'x', '2026-01-22'),
    /CHECK constraint failed/i
  );
});

// --- M-06: status cadastral separado do codigo legado ----------------------

test('codigo legado e preservado sem virar situacao financeira', (t) => {
  const ctx = createMigratedDb(t);

  const id = ctx.db
    .prepare('INSERT INTO associado (legacy_id, nome, legacy_status_code) VALUES (?, ?, ?)')
    .run('42', 'Beltrano de Teste', 'a').lastInsertRowid;

  const row = ctx.db
    .prepare('SELECT status_cadastral, legacy_status_code FROM associado WHERE id = ?')
    .get(id);

  assert.equal(row.legacy_status_code, 'a', 'valor bruto preservado');
  assert.equal(row.status_cadastral, 'indefinido', 'nenhuma interpretacao automatica de "a"');
});

// --- M-04: comprovante independente ----------------------------------------

test('comprovante existe sem movimento associado', (t) => {
  const ctx = createMigratedDb(t);

  const id = ctx.db
    .prepare('INSERT INTO comprovante (estado, observacao) VALUES (?, ?)')
    .run('ausente', 'sem evidencia na planilha').lastInsertRowid;

  const row = ctx.db.prepare('SELECT movimento_id, estado FROM comprovante WHERE id = ?').get(id);
  assert.equal(row.movimento_id, null);
  assert.equal(row.estado, 'ausente');
});

// --- M-07: importacao e proveniencia ---------------------------------------

test('mesmo sha256 de importacao nao e aceito silenciosamente', (t) => {
  const ctx = createMigratedDb(t);

  const sha = 'a'.repeat(64);
  const insert = ctx.db.prepare(
    'INSERT INTO importacao (nome_arquivo, sha256, versao_importador) VALUES (?, ?, ?)'
  );
  insert.run('controle-de-pagamento.xlsx', sha, '0.1.0');

  assert.throws(
    () => insert.run('controle-de-pagamento-copia.xlsx', sha, '0.1.0'),
    /UNIQUE constraint failed/i
  );

  const total = ctx.db.prepare('SELECT COUNT(*) AS total FROM importacao').get();
  assert.equal(total.total, 1, 'a segunda importacao nao pode ter sido gravada');
});

test('proveniencia guarda valor bruto e liga a celula a entidade produzida', (t) => {
  const ctx = createMigratedDb(t);

  const importacaoId = ctx.db
    .prepare('INSERT INTO importacao (nome_arquivo, sha256, versao_importador) VALUES (?, ?, ?)')
    .run('controle-de-pagamento.xlsx', 'b'.repeat(64), '0.1.0').lastInsertRowid;

  const celulaId = ctx.db
    .prepare(
      'INSERT INTO legacy_cell (importacao_id, aba, endereco, linha, coluna, valor_bruto, estilo) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(importacaoId, '2024', 'D14', 14, 4, 'f15 c', JSON.stringify({ fill: 'FFFF00' }))
    .lastInsertRowid;

  const associadoId = ctx.db
    .prepare('INSERT INTO associado (nome) VALUES (?)')
    .run('Sicrana de Teste').lastInsertRowid;

  ctx.db
    .prepare(
      'INSERT INTO legacy_cell_link (legacy_cell_id, entidade_tipo, entidade_id) VALUES (?, ?, ?)'
    )
    .run(celulaId, 'associado', associadoId);

  const celula = ctx.db.prepare('SELECT * FROM legacy_cell WHERE id = ?').get(celulaId);
  assert.equal(celula.valor_bruto, 'f15 c', 'valor bruto nao pode ser normalizado');
  assert.equal(celula.classificacao, null, 'nenhuma classificacao automatica');
  assert.equal(celula.estado_revisao, 'nao_revisado');

  const vinculos = ctx.db
    .prepare('SELECT COUNT(*) AS total FROM legacy_cell_link WHERE legacy_cell_id = ?')
    .get(celulaId);
  assert.equal(vinculos.total, 1);
});

// --- T-07: transacoes -------------------------------------------------------

test('withTransaction faz rollback de operacoes financeiras multi-registro', (t) => {
  const ctx = createMigratedDb(t);

  const competenciaId = ctx.db
    .prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)')
    .run(2028, 1).lastInsertRowid;

  assert.throws(() =>
    withTransaction(ctx.db, (db) => {
      db.prepare('INSERT INTO movimento_financeiro (data, valor_centavos, tipo) VALUES (?, ?, ?)').run(
        '2028-01-05',
        2500,
        'credito'
      );
      // valor_centavos <= 0 viola o CHECK e derruba a transacao inteira.
      db.prepare(
        'INSERT INTO alocacao (movimento_id, competencia_id, valor_centavos) VALUES (?, ?, ?)'
      ).run(1, competenciaId, 0);
    })
  );

  assert.equal(ctx.db.inTransaction, false);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM movimento_financeiro').get().t, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM alocacao').get().t, 0);
});

// --- audit_log --------------------------------------------------------------

test('audit_log aceita estado anterior e posterior', (t) => {
  const ctx = createMigratedDb(t);

  ctx.db
    .prepare(
      'INSERT INTO audit_log (ator, acao, entidade_tipo, entidade_id, estado_anterior, estado_posterior, metadados) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(
      'tester',
      'atualizar',
      'associado',
      '1',
      JSON.stringify({ nome: 'antes' }),
      JSON.stringify({ nome: 'depois' }),
      JSON.stringify({ origem: 'teste' })
    );

  const row = ctx.db.prepare('SELECT * FROM audit_log').get();
  assert.equal(row.acao, 'atualizar');
  assert.equal(JSON.parse(row.estado_posterior).nome, 'depois');
  assert.ok(row.criado_em, 'timestamp deve ser preenchido automaticamente');
});
