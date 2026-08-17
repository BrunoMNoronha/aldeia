'use strict';

// Helper transacional PostgreSQL (ADR-003 / PG-1) — T-07.
//
// "Operacoes que alterem multiplos registros financeiros devem ocorrer em uma
// unica transacao": o que isso exige na pratica e que um erro no meio do bloco
// nao deixe METADE do lancamento gravado. Movimento sem alocacao, ou alocacao
// sem movimento, e exatamente o tipo de saldo errado que o ledger nao consegue
// mais explicar depois.

const test = require('node:test');
const assert = require('node:assert/strict');

const { withTransaction } = require('../src/db/postgresql/connection');
const { runMigrations } = require('../src/db/postgresql/migrator');
const { motivoSkip, schemaIsolado } = require('./helpers/postgres');

const skip = motivoSkip();

async function schemaMigrado(t) {
  const ctx = await schemaIsolado(t);
  await runMigrations(ctx.pool);
  return ctx;
}

async function contar(pool, tabela) {
  const { rows } = await pool.query(`SELECT COUNT(*) AS total FROM ${tabela}`);
  return Number(rows[0].total);
}

test('sucesso faz COMMIT e o dado permanece visivel fora da transacao', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const id = await withTransaction(pool, async (client) => {
    const { rows } = await client.query(
      "INSERT INTO associado (nome) VALUES ('Comitado') RETURNING id"
    );
    return rows[0].id;
  });

  const { rows } = await pool.query('SELECT nome FROM associado WHERE id = $1', [id]);
  assert.equal(rows[0].nome, 'Comitado');
});

test('erro faz ROLLBACK e o erro original chega a quem chamou', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  await assert.rejects(
    () =>
      withTransaction(pool, async (client) => {
        await client.query("INSERT INTO associado (nome) VALUES ('Desfeito')");
        throw new Error('regra de negocio recusou');
      }),
    /regra de negocio recusou/,
    'o erro do bloco nao pode ser trocado pelo erro do ROLLBACK'
  );

  assert.equal(await contar(pool, 'associado'), 0, 'nada pode ter sobrado');
});

test('erro do proprio PostgreSQL tambem desfaz tudo', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  await assert.rejects(() =>
    withTransaction(pool, async (client) => {
      await client.query("INSERT INTO associado (nome) VALUES ('Antes')");
      // Viola o CHECK de valor positivo: a recusa vem do banco.
      await client.query(
        "INSERT INTO movimento_financeiro (data, valor_centavos, tipo) VALUES ('2026-01-01', -1, 'credito')"
      );
    })
  );

  assert.equal(await contar(pool, 'associado'), 0);
  assert.equal(await contar(pool, 'movimento_financeiro'), 0);
});

test('gravacao financeira multi-registro e atomica (T-07)', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const { rows: comp } = await pool.query(
    'INSERT INTO competencia (ano, mes) VALUES (2026, 1) RETURNING id'
  );
  const competenciaId = comp[0].id;

  // Movimento + duas alocacoes: se a segunda falhar, a primeira e o movimento
  // precisam desaparecer junto.
  await assert.rejects(() =>
    withTransaction(pool, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO movimento_financeiro (data, valor_centavos, tipo)
         VALUES ('2026-01-10', 5000, 'credito') RETURNING id`
      );
      const movimentoId = rows[0].id;

      await client.query(
        'INSERT INTO alocacao (movimento_id, competencia_id, valor_centavos) VALUES ($1, $2, 2500)',
        [movimentoId, competenciaId]
      );
      // Segunda alocacao ATIVA para a mesma competencia: barrada por ux_alocacao_ativa.
      await client.query(
        'INSERT INTO alocacao (movimento_id, competencia_id, valor_centavos) VALUES ($1, $2, 2500)',
        [movimentoId, competenciaId]
      );
    })
  );

  assert.equal(await contar(pool, 'movimento_financeiro'), 0, 'o movimento nao pode ter ficado');
  assert.equal(await contar(pool, 'alocacao'), 0, 'a primeira alocacao tambem precisa sumir');
});

test('o dado so fica visivel para fora DEPOIS do commit', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  await withTransaction(pool, async (client) => {
    await client.query("INSERT INTO associado (nome) VALUES ('Em voo')");

    // Consulta por FORA da transacao, em outra conexao do pool: nao pode
    // enxergar o que ainda nao foi commitado.
    assert.equal(await contar(pool, 'associado'), 0);

    // Pelo client da transacao, o proprio bloco enxerga o que gravou.
    const { rows } = await client.query('SELECT COUNT(*) AS total FROM associado');
    assert.equal(Number(rows[0].total), 1);
  });

  assert.equal(await contar(pool, 'associado'), 1);
});

test('o client volta ao pool no sucesso e no erro', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const antes = pool.totalCount;

  await withTransaction(pool, async (client) => client.query('SELECT 1'));
  assert.equal(pool.idleCount, pool.totalCount, 'apos o commit nenhum client fica retido');

  await assert.rejects(() =>
    withTransaction(pool, async () => {
      throw new Error('falhou');
    })
  );
  assert.equal(pool.idleCount, pool.totalCount, 'apos o rollback nenhum client fica retido');
  assert.equal(pool.waitingCount, 0);

  // Nenhuma conexao extra foi aberta: os clients foram reaproveitados.
  assert.ok(pool.totalCount <= antes + 1);
});

test('transacoes sucessivas nao vazam client (o pool nao esgota)', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  // O pool do helper tem max: 4. Vinte transacoes, metade delas falhando,
  // travariam aqui se `release()` nao estivesse no `finally`.
  for (let i = 0; i < 20; i += 1) {
    if (i % 2 === 0) {
      await withTransaction(pool, async (client) =>
        client.query('INSERT INTO associado (nome) VALUES ($1)', [`A${i}`])
      );
    } else {
      await assert.rejects(() =>
        withTransaction(pool, async () => {
          throw new Error(`falha ${i}`);
        })
      );
    }
  }

  assert.equal(await contar(pool, 'associado'), 10);
});
