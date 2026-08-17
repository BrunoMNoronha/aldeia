'use strict';

// Equivalencia semantica do schema PostgreSQL (ADR-003 / PG-1).
//
// O que se verifica aqui NAO e "o DDL foi traduzido", e sim "as invariantes
// FROZEN continuam sendo aplicadas PELO BANCO". Uma conversao SQLite ->
// PostgreSQL que compile e crie todas as tabelas ainda pode ter perdido um CHECK
// ou trocado um RESTRICT por CASCADE — e o schema so cumpre seu papel se recusar
// o que sempre recusou.

const test = require('node:test');
const assert = require('node:assert/strict');

const { runMigrations } = require('../src/db/postgresql/migrator');
const { motivoSkip, schemaIsolado } = require('./helpers/postgres');

const skip = motivoSkip();

async function schemaMigrado(t) {
  const ctx = await schemaIsolado(t);
  await runMigrations(ctx.pool);
  return ctx;
}

/** Cria um associado e devolve o id (RETURNING, nao `lastInsertRowid`). */
async function criarAssociado(pool, nome = 'Fulano') {
  const { rows } = await pool.query('INSERT INTO associado (nome) VALUES ($1) RETURNING id', [nome]);
  return rows[0].id;
}

async function criarCompetencia(pool, ano, mes) {
  const { rows } = await pool.query(
    'INSERT INTO competencia (ano, mes) VALUES ($1, $2) RETURNING id',
    [ano, mes]
  );
  return rows[0].id;
}

async function criarMovimento(pool, { valor = 2500, associadoId = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO movimento_financeiro (data, valor_centavos, tipo, associado_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    ['2026-01-10', valor, 'credito', associadoId]
  );
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// T-06 — dinheiro
// ---------------------------------------------------------------------------

test('nenhuma coluna monetaria usa tipo de ponto flutuante', { skip }, async (t) => {
  const { pool, schema } = await schemaMigrado(t);

  const { rows } = await pool.query(
    `SELECT table_name, column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = $1 AND column_name LIKE '%centavos%'
      ORDER BY table_name, column_name`,
    [schema]
  );

  assert.ok(rows.length >= 4, 'as colunas de centavos precisam existir');
  for (const coluna of rows) {
    assert.ok(
      ['bigint', 'integer'].includes(coluna.data_type),
      `${coluna.table_name}.${coluna.column_name} deveria ser inteiro, mas e ${coluna.data_type}`
    );
  }
});

test('centavos trafegam como inteiro do JavaScript, sem virar string nem float', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const id = await criarMovimento(pool, { valor: 2500 });
  const { rows } = await pool.query('SELECT valor_centavos FROM movimento_financeiro WHERE id = $1', [
    id,
  ]);

  assert.equal(rows[0].valor_centavos, 2500);
  assert.equal(typeof rows[0].valor_centavos, 'number');
  assert.ok(Number.isInteger(rows[0].valor_centavos));
});

test('valor monetario nao positivo e recusado pelo banco', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  for (const invalido of [0, -1]) {
    await assert.rejects(
      () => criarMovimento(pool, { valor: invalido }),
      /valor_centavos/,
      `deveria recusar valor_centavos = ${invalido}`
    );
  }
});

// ---------------------------------------------------------------------------
// M-05 / M-02 / M-10
// ---------------------------------------------------------------------------

test('deposito nao identificado existe sem associado (M-05)', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const id = await criarMovimento(pool, { associadoId: null });
  const { rows } = await pool.query(
    'SELECT associado_id, estado_identificacao FROM movimento_financeiro WHERE id = $1',
    [id]
  );

  assert.equal(rows[0].associado_id, null);
  assert.equal(rows[0].estado_identificacao, 'nao_identificado');
});

test('competencia futura entra como DADO, sem alterar schema (M-10)', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  await criarCompetencia(pool, 2031, 12);
  await criarCompetencia(pool, 2032, 1);

  const { rows } = await pool.query('SELECT COUNT(*) AS total FROM competencia');
  assert.equal(Number(rows[0].total), 2);

  // A faixa de ano e o mes continuam validados pelo banco.
  await assert.rejects(() => criarCompetencia(pool, 2026, 13), /mes/);
  await assert.rejects(() => criarCompetencia(pool, 1899, 1), /ano/);
});

test('a mesma competencia nao pode ser cadastrada duas vezes', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  await criarCompetencia(pool, 2026, 3);
  await assert.rejects(() => criarCompetencia(pool, 2026, 3), /duplicate key|unique/i);
});

test('uma alocacao ATIVA por movimento + competencia; inativas nao bloqueiam', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const movimentoId = await criarMovimento(pool);
  const competenciaId = await criarCompetencia(pool, 2026, 1);

  const inserirAtiva = () =>
    pool.query(
      'INSERT INTO alocacao (movimento_id, competencia_id, valor_centavos) VALUES ($1, $2, $3) RETURNING id',
      [movimentoId, competenciaId, 2500]
    );

  const primeira = await inserirAtiva();

  await assert.rejects(inserirAtiva, /ux_alocacao_ativa|duplicate key/i);

  // Inativando a primeira (com QUANDO e POR QUE), uma nova alocacao ativa cabe.
  await pool.query(
    `UPDATE alocacao
        SET ativo = FALSE, inativado_em = now(), motivo_inativacao = $2
      WHERE id = $1`,
    [primeira.rows[0].id, 'lancamento corrigido']
  );

  await inserirAtiva();

  const { rows } = await pool.query('SELECT COUNT(*) AS total FROM alocacao');
  assert.equal(Number(rows[0].total), 2, 'a alocacao inativada permanece no historico');
});

// ---------------------------------------------------------------------------
// M-09 — correcao por inativacao, nunca por DELETE
// ---------------------------------------------------------------------------

test('inativar exige QUANDO e POR QUE, nas tres entidades financeiras', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const associadoId = await criarAssociado(pool);
  const movimentoId = await criarMovimento(pool, { associadoId });
  const competenciaId = await criarCompetencia(pool, 2026, 2);

  const { rows: alocacao } = await pool.query(
    'INSERT INTO alocacao (movimento_id, competencia_id, valor_centavos) VALUES ($1, $2, $3) RETURNING id',
    [movimentoId, competenciaId, 2500]
  );
  const { rows: ajuste } = await pool.query(
    `INSERT INTO ajuste_credito_debito (associado_id, tipo, valor_centavos, motivo, data)
     VALUES ($1, 'credito', 500, 'acerto', '2026-02-01') RETURNING id`,
    [associadoId]
  );

  const alvos = [
    ['movimento_financeiro', movimentoId],
    ['alocacao', alocacao[0].id],
    ['ajuste_credito_debito', ajuste[0].id],
  ];

  for (const [tabela, id] of alvos) {
    // sem inativado_em e sem motivo
    await assert.rejects(
      () => pool.query(`UPDATE ${tabela} SET ativo = FALSE WHERE id = $1`, [id]),
      /inativacao_justificada/,
      `${tabela}: inativar sem justificativa deveria ser recusado`
    );

    // com data, mas com motivo em branco
    await assert.rejects(
      () =>
        pool.query(
          `UPDATE ${tabela} SET ativo = FALSE, inativado_em = now(), motivo_inativacao = '   ' WHERE id = $1`,
          [id]
        ),
      /inativacao_justificada/,
      `${tabela}: motivo em branco nao e motivo`
    );

    // com os dois, passa
    await pool.query(
      `UPDATE ${tabela} SET ativo = FALSE, inativado_em = now(), motivo_inativacao = 'erro de digitacao' WHERE id = $1`,
      [id]
    );
  }
});

// ---------------------------------------------------------------------------
// Integridade referencial — historico nao some por exclusao de pai
// ---------------------------------------------------------------------------

test('nenhuma FK de entidade financeira usa ON DELETE CASCADE', { skip }, async (t) => {
  const { pool, schema } = await schemaMigrado(t);

  const { rows } = await pool.query(
    `SELECT tc.constraint_name, tc.table_name, rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.table_schema
      WHERE tc.table_schema = $1 AND tc.constraint_type = 'FOREIGN KEY'`,
    [schema]
  );

  assert.equal(rows.length, 12, 'as 12 foreign keys do schema precisam existir');
  for (const fk of rows) {
    // `RESTRICT` e `NO ACTION` sao regras DISTINTAS no PostgreSQL (ele nao
    // normaliza uma na outra) e as duas preservam o historico: nenhuma apaga
    // filho junto com o pai. Todas as FKs deste schema declaram RESTRICT.
    // O que nao pode existir e CASCADE, SET NULL ou SET DEFAULT — qualquer uma
    // delas faria uma exclusao de pai alterar registro financeiro em silencio.
    assert.equal(
      fk.delete_rule,
      'RESTRICT',
      `${fk.table_name}.${fk.constraint_name} deveria ser RESTRICT, e nao ${fk.delete_rule}`
    );
  }
});

test('excluir um pai referenciado e recusado pelo banco', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const associadoId = await criarAssociado(pool);
  await criarMovimento(pool, { associadoId });

  await assert.rejects(
    () => pool.query('DELETE FROM associado WHERE id = $1', [associadoId]),
    /foreign key|violates/i,
    'apagar o associado nao pode levar o historico financeiro junto'
  );
});

test('FK inexistente e rejeitada pelo banco, nao pela aplicacao', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  await assert.rejects(
    () => criarMovimento(pool, { associadoId: 999999 }),
    /foreign key|violates/i
  );
});

// ---------------------------------------------------------------------------
// M-04 — comprovante
// ---------------------------------------------------------------------------

test('um movimento tem no maximo UM comprovante, mas comprovante solto e livre', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const movimentoId = await criarMovimento(pool);

  await pool.query('INSERT INTO comprovante (estado, movimento_id) VALUES ($1, $2)', [
    'presente',
    movimentoId,
  ]);

  await assert.rejects(
    () =>
      pool.query('INSERT INTO comprovante (estado, movimento_id) VALUES ($1, $2)', [
        'pendente',
        movimentoId,
      ]),
    /ux_comprovante_movimento|duplicate key/i
  );

  // M-04: comprovante existe por si so; varios sem movimento nao colidem.
  await pool.query("INSERT INTO comprovante (estado) VALUES ('pendente')");
  await pool.query("INSERT INTO comprovante (estado) VALUES ('pendente')");

  const { rows } = await pool.query(
    'SELECT COUNT(*) AS total FROM comprovante WHERE movimento_id IS NULL'
  );
  assert.equal(Number(rows[0].total), 2);
});

test('o vocabulario FROZEN de estado do comprovante e aplicado pelo banco', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  for (const estado of ['presente', 'ausente', 'pendente', 'nao_aplicavel']) {
    await pool.query('INSERT INTO comprovante (estado) VALUES ($1)', [estado]);
  }

  await assert.rejects(
    () => pool.query('INSERT INTO comprovante (estado) VALUES ($1)', ['talvez']),
    /estado/
  );
});

// ---------------------------------------------------------------------------
// M-07 / M-08 — proveniencia e ambiguidade
// ---------------------------------------------------------------------------

test('a proveniencia vai de arquivo + hash ate aba, celula e valor bruto', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const sha = 'a'.repeat(64);
  const { rows: importacao } = await pool.query(
    `INSERT INTO importacao (nome_arquivo, sha256, versao_importador)
     VALUES ($1, $2, $3) RETURNING id`,
    ['controle-de-pagamento.xlsx', sha, '1.0.0']
  );

  const { rows: celula } = await pool.query(
    `INSERT INTO legacy_cell (importacao_id, aba, endereco, linha, coluna, valor_bruto,
                              tipo_original, formula, texto_formatado, valor_json)
     VALUES ($1, 'PAGAMENTOS', 'BJ12', 12, 62, '40.02', 'formula', 'SUM(C5:C17)', 'R$ 40,02',
             '{"tipo":"formula","formula":"SUM(C5:C17)","resultado":40.02}')
     RETURNING id`,
    [importacao[0].id]
  );

  const associadoId = await criarAssociado(pool);
  await pool.query(
    `INSERT INTO legacy_cell_link (legacy_cell_id, entidade_tipo, entidade_id)
     VALUES ($1, 'associado', $2)`,
    [celula[0].id, associadoId]
  );

  const { rows } = await pool.query(
    `SELECT i.nome_arquivo, i.sha256, c.aba, c.endereco, c.valor_bruto, c.formula, c.valor_json
       FROM legacy_cell_link l
       JOIN legacy_cell c ON c.id = l.legacy_cell_id
       JOIN importacao  i ON i.id = c.importacao_id
      WHERE l.entidade_tipo = 'associado' AND l.entidade_id = $1`,
    [associadoId]
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].nome_arquivo, 'controle-de-pagamento.xlsx');
  assert.equal(rows[0].sha256, sha);
  assert.equal(rows[0].aba, 'PAGAMENTOS');
  assert.equal(rows[0].endereco, 'BJ12');
  assert.equal(rows[0].valor_bruto, '40.02', 'o valor bruto nunca e substituido por interpretacao');
  assert.equal(rows[0].formula, 'SUM(C5:C17)');
});

test('o mesmo arquivo nao entra duas vezes em silencio', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const sha = 'b'.repeat(64);
  const inserir = () =>
    pool.query(
      'INSERT INTO importacao (nome_arquivo, sha256, versao_importador) VALUES ($1, $2, $3)',
      ['planilha.xlsx', sha, '1.0.0']
    );

  await inserir();
  await assert.rejects(inserir, /duplicate key|unique/i);

  // E o sha256 precisa ter tamanho de sha256.
  await assert.rejects(
    () =>
      pool.query(
        'INSERT INTO importacao (nome_arquivo, sha256, versao_importador) VALUES ($1, $2, $3)',
        ['planilha.xlsx', 'curto', '1.0.0']
      ),
    /sha256/
  );
});

test('celula ambigua tem estado proprio e nao vira dado corrigido', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const { rows: importacao } = await pool.query(
    `INSERT INTO importacao (nome_arquivo, sha256, versao_importador)
     VALUES ('x.xlsx', $1, '1.0.0') RETURNING id`,
    ['c'.repeat(64)]
  );

  for (const estado of ['nao_revisado', 'revisado', 'ambiguo', 'descartado']) {
    await pool.query(
      `INSERT INTO legacy_cell (importacao_id, aba, endereco, estado_revisao)
       VALUES ($1, 'A', $2, $3)`,
      [importacao[0].id, `X${estado}`, estado]
    );
  }

  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO legacy_cell (importacao_id, aba, endereco, estado_revisao)
         VALUES ($1, 'A', 'Z1', 'corrigido_automaticamente')`,
        [importacao[0].id]
      ),
    /estado_revisao/
  );
});

// ---------------------------------------------------------------------------
// Demais CHECKs preservados
// ---------------------------------------------------------------------------

test('status cadastral, tipo, identificacao, prioridade e estado seguem restritos', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  await assert.rejects(
    () => pool.query("INSERT INTO associado (nome, status_cadastral) VALUES ('X', 'sei_la')"),
    /status_cadastral/
  );

  await assert.rejects(
    () =>
      pool.query(
        "INSERT INTO movimento_financeiro (data, valor_centavos, tipo) VALUES ('2026-01-01', 100, 'estorno')"
      ),
    /tipo/
  );

  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO movimento_financeiro (data, valor_centavos, tipo, estado_identificacao)
         VALUES ('2026-01-01', 100, 'credito', 'quem_sabe')`
      ),
    /estado_identificacao/
  );

  await assert.rejects(
    () =>
      pool.query(
        "INSERT INTO pendencia (tipo, descricao, prioridade) VALUES ('x', 'y', 'urgentissima')"
      ),
    /prioridade/
  );

  await assert.rejects(
    () => pool.query("INSERT INTO importacao (nome_arquivo, sha256, versao_importador, status) VALUES ('a', $1, '1', 'meio_feita')", ['d'.repeat(64)]),
    /status/
  );
});

test('pendencia fechada precisa registrar quando foi fechada', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  await assert.rejects(
    () =>
      pool.query("INSERT INTO pendencia (tipo, descricao, estado) VALUES ('x', 'y', 'resolvida')"),
    /ck_pendencia_fechada_tem_data/
  );

  await pool.query(
    "INSERT INTO pendencia (tipo, descricao, estado, resolvida_em) VALUES ('x', 'y', 'resolvida', now())"
  );
});

// ---------------------------------------------------------------------------
// Identidade e indices
// ---------------------------------------------------------------------------

test('ids sao IDENTITY BY DEFAULT: id historico explicito e aceito', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  // A transferencia SQLite -> PostgreSQL (PG-2+) depende disto: os ids legados
  // precisam ser preservados para nao quebrar as FKs ja gravadas.
  await pool.query('INSERT INTO associado (id, nome) VALUES ($1, $2)', [4242, 'Historico']);

  const { rows } = await pool.query('SELECT nome FROM associado WHERE id = 4242');
  assert.equal(rows[0].nome, 'Historico');
});

test('os indices semanticamente relevantes existem', { skip }, async (t) => {
  const { pool, schema } = await schemaMigrado(t);

  const { rows } = await pool.query('SELECT indexname FROM pg_indexes WHERE schemaname = $1', [
    schema,
  ]);
  const indices = rows.map((r) => r.indexname);

  for (const esperado of [
    'ix_associado_nome',
    'ix_associado_status',
    'ix_movimento_data',
    'ix_movimento_associado',
    'ix_movimento_identificacao',
    'ux_alocacao_ativa',
    'ix_alocacao_movimento',
    'ix_alocacao_competencia',
    'ix_ajuste_associado',
    'ix_ajuste_competencia',
    'ix_comprovante_movimento',
    'ix_comprovante_associado',
    'ix_comprovante_estado',
    'ux_comprovante_movimento',
    'ix_pendencia_estado',
    'ix_pendencia_associado',
    'ix_legacy_cell_importacao',
    'ix_legacy_cell_revisao',
    'ix_legacy_cell_link_entidade',
    'ix_audit_entidade',
    'ix_audit_criado_em',
  ]) {
    assert.ok(indices.includes(esperado), `indice ausente: ${esperado}`);
  }
});

test('os dois indices unicos sao PARCIAIS, e nao totais', { skip }, async (t) => {
  const { pool, schema } = await schemaMigrado(t);

  const { rows } = await pool.query(
    `SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = $1 AND indexname IN ('ux_alocacao_ativa', 'ux_comprovante_movimento')`,
    [schema]
  );

  assert.equal(rows.length, 2);
  for (const indice of rows) {
    assert.match(indice.indexdef, /UNIQUE/, `${indice.indexname} precisa ser unico`);
    assert.match(
      indice.indexdef,
      /WHERE/,
      `${indice.indexname} precisa ser PARCIAL: sem o WHERE a regra mudaria`
    );
  }
});
