'use strict';

// Lifecycle transacional de `withReadSnapshot` (ADR-003 / PG-2C1R2).
//
// A PG-2C1R entregou a SEMANTICA do snapshot (REPEATABLE READ + READ ONLY, sem
// lock) e os testes S1-S7 continuam sendo os donos dessa parte. O que ESTE
// arquivo protege e outra coisa: a SEQUENCIA de comandos que o helper emite em
// cada caminho de erro, incluindo o caminho que ninguem costuma exercitar — o
// `COMMIT` que falha.
//
// COMO ISSO E DETERMINISTICO. Nada de `sleep`, de derrubar PostgreSQL ou de
// timeout arbitrario. A quase totalidade dos casos usa um pool INSTRUMENTADO:
// um duble que registra, em ordem, cada comando pedido e cada `release`. Isso
// permite afirmar a sequencia exata — e nao apenas "deu erro no fim" —, que e
// justamente o que distingue um cleanup executado de um cleanup esquecido.
//
// O unico teste que usa PostgreSQL real e o que verifica o que a versao
// instalada de `pg` faz com um client cuja conexao morreu durante o `COMMIT`.
// Comportamento de biblioteca nao se supoe: se verifica.

const test = require('node:test');
const assert = require('node:assert/strict');

const { withReadSnapshot, createPool } = require('../src/db/postgresql/connection');
const { motivoSkip, schemaIsolado } = require('./helpers/postgres');

const skip = motivoSkip();

// ---------------------------------------------------------------------------
// Pool instrumentado
// ---------------------------------------------------------------------------

/**
 * Reduz o SQL emitido pelo helper a um rotulo estavel. O `BEGIN` do snapshot e
 * uma frase longa (`BEGIN TRANSACTION ISOLATION LEVEL ...`) e comparar a string
 * inteira transformaria este arquivo em teste de pontuacao; o que importa aqui e
 * QUAL comando transacional foi emitido e em que ordem.
 */
function rotular(sql) {
  const texto = String(sql).trim().toUpperCase();
  if (texto.startsWith('BEGIN')) return 'BEGIN';
  if (texto.startsWith('COMMIT')) return 'COMMIT';
  if (texto.startsWith('ROLLBACK')) return 'ROLLBACK';
  return texto;
}

/**
 * Duble de pool com UM client, registrando a sequencia real de chamadas.
 *
 * `falhas` mapeia rotulo -> erro a lancar naquele comando. `release` imita o
 * `_releaseOnce` do `pg-pool`: a segunda liberacao do mesmo client LANCA, como
 * lanca na biblioteca de verdade. Assim um double release nao passa despercebido
 * como um detalhe cosmetico do log — ele quebra o teste, igual quebraria a
 * aplicacao.
 *
 * @param {{ falhas?: Record<string, Error> }} [opcoes]
 */
function poolInstrumentado({ falhas = {} } = {}) {
  const log = [];
  let liberado = false;

  const client = {
    query: async (sql) => {
      const rotulo = rotular(sql);
      log.push(rotulo);
      const falha = falhas[rotulo];
      if (falha !== undefined) throw falha;
      return { rows: [], rowCount: 0 };
    },
    release: (erro) => {
      if (liberado) {
        // REGISTRA antes de lancar. Se apenas lancasse, a segunda liberacao
        // sumiria do log e um `release` duplicado poderia passar como "uma vez
        // so" — que e exatamente o que L7 precisa enxergar.
        log.push('release-DUPLICADO');
        // Mesma mensagem do `pg-pool`: `throwOnDoubleRelease()`.
        throw new Error('Release called on client which has already been released to the pool.');
      }
      liberado = true;
      log.push(erro === undefined ? 'release' : 'release(err)');
    },
  };

  return {
    log,
    client,
    pool: {
      connect: async () => {
        log.push('connect');
        return client;
      },
    },
  };
}

/** Captura o erro de uma promise sem deixar o teste passar caso ela resolva. */
async function capturarErro(promessa, mensagem) {
  try {
    await promessa;
  } catch (erro) {
    return erro;
  }
  assert.fail(mensagem);
}

// ---------------------------------------------------------------------------
// L1 — sucesso
// ---------------------------------------------------------------------------

test('PG L1: sucesso percorre BEGIN, fn, COMMIT e libera o client uma unica vez', async () => {
  const { pool, log } = poolInstrumentado();

  const resultado = await withReadSnapshot(pool, async (client) => {
    await client.query('SELECT 1');
    return 'valor de retorno';
  });

  assert.equal(resultado, 'valor de retorno', 'o retorno de fn e o retorno do helper');
  assert.deepEqual(log, ['connect', 'BEGIN', 'SELECT 1', 'COMMIT', 'release']);
});

// ---------------------------------------------------------------------------
// L2 — fn falha, ROLLBACK funciona
// ---------------------------------------------------------------------------

test('PG L2: erro em fn dispara ROLLBACK e devolve o erro original', async () => {
  const { pool, log } = poolInstrumentado();
  const erroA = new Error('erro A — regra de dominio recusou');

  const capturado = await capturarErro(
    withReadSnapshot(pool, async () => {
      throw erroA;
    }),
    'fn lancou: o helper tinha de rejeitar'
  );

  assert.equal(capturado, erroA, 'o erro de fn chega intacto a quem chamou');
  assert.deepEqual(log, ['connect', 'BEGIN', 'ROLLBACK', 'release']);
  assert.equal(log.filter((e) => e === 'COMMIT').length, 0, 'transacao abortada nao commita');
});

// ---------------------------------------------------------------------------
// L3 — fn falha E o ROLLBACK tambem falha
// ---------------------------------------------------------------------------

test('PG L3: falha no ROLLBACK nao mascara o erro que abortou fn', async () => {
  const erroRollback = new Error('erro de cleanup — ROLLBACK indisponivel');
  const { pool, log } = poolInstrumentado({ falhas: { ROLLBACK: erroRollback } });
  const erroA = new Error('erro A — regra de dominio recusou');

  const capturado = await capturarErro(
    withReadSnapshot(pool, async () => {
      throw erroA;
    }),
    'o helper tinha de rejeitar'
  );

  // O diagnostico util e a CAUSA, nao o sintoma do encerramento.
  assert.equal(capturado, erroA, 'o erro original prevalece sobre o erro do cleanup');
  assert.notEqual(capturado, erroRollback);
  assert.deepEqual(log, ['connect', 'BEGIN', 'ROLLBACK', 'release']);
  assert.equal(log.filter((e) => e.startsWith('release')).length, 1, 'release exatamente uma vez');
});

// ---------------------------------------------------------------------------
// L4 — COMMIT falha (o gap desta tarefa)
// ---------------------------------------------------------------------------

test('PG L4: falha no COMMIT tenta encerrar a transacao antes de devolver o client', async () => {
  const erroB = new Error('erro B — COMMIT recusado');
  const { pool, log } = poolInstrumentado({ falhas: { COMMIT: erroB } });

  const capturado = await capturarErro(
    withReadSnapshot(pool, async (client) => {
      await client.query('SELECT 1');
      return 'nunca entregue';
    }),
    'COMMIT falhou: o helper NAO pode resolver com sucesso'
  );

  assert.equal(capturado, erroB, 'o erro do COMMIT e o erro externo');

  // O ponto da PG-2C1R2: um COMMIT que falha deixa a transacao em estado
  // indefinido para ESTE client. Devolve-lo ao pool sem tentar encerrar a
  // transacao arrisca entregar ao proximo consumidor uma conexao com transacao
  // aberta — que e como um snapshot de leitura vira estado preso.
  assert.deepEqual(log, ['connect', 'BEGIN', 'SELECT 1', 'COMMIT', 'ROLLBACK', 'release']);
});

// ---------------------------------------------------------------------------
// L5 — COMMIT falha E o cleanup tambem falha
// ---------------------------------------------------------------------------

test('PG L5: cleanup que falha depois do COMMIT nao substitui o erro do COMMIT', async () => {
  const erroB = new Error('erro B — COMMIT recusado');
  const erroCleanup = new Error('erro de cleanup — conexao ja morta');
  const { pool, log } = poolInstrumentado({
    falhas: { COMMIT: erroB, ROLLBACK: erroCleanup },
  });

  const capturado = await capturarErro(
    withReadSnapshot(pool, async (client) => client.query('SELECT 1')),
    'o helper tinha de rejeitar'
  );

  assert.equal(capturado, erroB, 'erro B continua sendo o erro principal');
  assert.notEqual(capturado, erroCleanup);
  assert.deepEqual(log, ['connect', 'BEGIN', 'SELECT 1', 'COMMIT', 'ROLLBACK', 'release']);
  assert.equal(log.filter((e) => e.startsWith('release')).length, 1, 'release exatamente uma vez');
});

// ---------------------------------------------------------------------------
// L6 — BEGIN falha
// ---------------------------------------------------------------------------

test('PG L6: falha no BEGIN nao emite ROLLBACK de transacao que nunca abriu', async () => {
  const erroBegin = new Error('erro de BEGIN — conexao recusou o comando');
  const { pool, log } = poolInstrumentado({ falhas: { BEGIN: erroBegin } });

  const capturado = await capturarErro(
    withReadSnapshot(pool, async () => {
      assert.fail('fn nao pode ser chamada se o BEGIN falhou');
    }),
    'o helper tinha de rejeitar'
  );

  assert.equal(capturado, erroBegin, 'o erro do BEGIN chega intacto');
  // ROLLBACK sem transacao aberta e ruido: o PostgreSQL responde com WARNING
  // ("there is no transaction in progress") e o log da aplicacao passa a conter
  // um evento que nunca aconteceu.
  assert.deepEqual(log, ['connect', 'BEGIN', 'release']);
  assert.equal(log.filter((e) => e === 'ROLLBACK').length, 0, 'nenhum ROLLBACK indevido');
});

// ---------------------------------------------------------------------------
// L7 — nenhum caminho executa cleanup duas vezes
// ---------------------------------------------------------------------------

test('PG L7: todos os caminhos liberam o client exatamente uma vez, sem cleanup duplicado', async () => {
  const erro = new Error('falha');

  const cenarios = [
    { nome: 'sucesso', falhas: {}, fn: async (c) => c.query('SELECT 1') },
    { nome: 'fn falha', falhas: {}, fn: async () => { throw erro; } },
    {
      nome: 'fn falha e ROLLBACK falha',
      falhas: { ROLLBACK: new Error('cleanup falhou') },
      fn: async () => { throw erro; },
    },
    { nome: 'COMMIT falha', falhas: { COMMIT: erro }, fn: async (c) => c.query('SELECT 1') },
    {
      nome: 'COMMIT falha e cleanup falha',
      falhas: { COMMIT: erro, ROLLBACK: new Error('cleanup falhou') },
      fn: async (c) => c.query('SELECT 1'),
    },
    { nome: 'BEGIN falha', falhas: { BEGIN: erro }, fn: async (c) => c.query('SELECT 1') },
  ];

  for (const cenario of cenarios) {
    const { pool, log } = poolInstrumentado({ falhas: cenario.falhas });

    // O resultado (resolve ou reject) e assunto dos testes L1-L6; aqui o que se
    // afirma e a CONTAGEM de cada evento de encerramento.
    await withReadSnapshot(pool, cenario.fn).catch(() => {});

    const releases = log.filter((e) => e.startsWith('release')).length;
    const rollbacks = log.filter((e) => e === 'ROLLBACK').length;
    const commits = log.filter((e) => e === 'COMMIT').length;
    const connects = log.filter((e) => e === 'connect').length;

    assert.equal(releases, 1, `[${cenario.nome}] release exatamente uma vez — log: ${log.join(' > ')}`);
    assert.ok(rollbacks <= 1, `[${cenario.nome}] no maximo um ROLLBACK — log: ${log.join(' > ')}`);
    assert.ok(commits <= 1, `[${cenario.nome}] no maximo um COMMIT — log: ${log.join(' > ')}`);
    assert.equal(connects, 1, `[${cenario.nome}] um unico client — log: ${log.join(' > ')}`);
    // `release` sempre por ultimo: devolver o client e depois seguir usando-o
    // seria usar uma conexao que ja pode estar com outro consumidor.
    assert.ok(
      log[log.length - 1].startsWith('release'),
      `[${cenario.nome}] release e o ultimo evento — log: ${log.join(' > ')}`
    );
  }
});

// ---------------------------------------------------------------------------
// L8 — client quebrado nao volta a circular (comportamento do `pg` instalado)
// ---------------------------------------------------------------------------

test(
  'PG L8: conexao que morre durante o COMMIT nao e reaproveitada pelo pool',
  { skip },
  async (t) => {
    const { url } = await schemaIsolado(t);

    // Pool proprio com max: 1. Com uma unica conexao permitida, se o client
    // quebrado voltasse a circular a leitura seguinte falharia — nao ha outra
    // conexao para mascarar o problema.
    const pool = createPool({ connectionString: url, max: 1 });
    t.after(async () => {
      if (pool.ended !== true) await pool.end();
    });

    const capturado = await capturarErro(
      withReadSnapshot(pool, async (client) => {
        await client.query('SELECT 1');

        // Enquanto um client esta EMPRESTADO, o `pg-pool` remove o proprio
        // listener de erro (`connect()` faz `removeListener('error', ...)`) e so
        // o reinstala no `release`. Nessa janela, um `error` sem ouvinte vira
        // excecao nao capturada do processo — comportamento do `pg`, anterior a
        // esta tarefa e comum a `withClient`/`withTransaction`. O teste assume
        // esse contrato explicitamente em vez de escondê-lo.
        client.on('error', () => {
          /* a falha real chega pela rejeicao da query; aqui so evita o throw */
        });

        // Mata o SOCKET deste client — nao o servidor, nao o container, nao a
        // rede. O `COMMIT` que o helper emite a seguir falha por conexao morta,
        // de forma imediata e deterministica.
        client.connection.stream.destroy();
        return 'nunca entregue';
      }),
      'o COMMIT sobre conexao morta tinha de falhar'
    );

    assert.ok(capturado instanceof Error, 'a falha chega como Error');

    // EVIDENCIA, nao suposicao: no `pg` 8.23.0 o `_release` do `pg-pool` descarta
    // o client quando `!client._queryable || client._ending`, que e exatamente o
    // estado de um client cuja conexao caiu. Ou seja, `release()` SEM argumento
    // ja e suficiente para impedir o reuso de uma conexao quebrada — passar
    // `release(err)` seria redundante nesta versao.
    assert.equal(pool.idleCount, 0, 'o client quebrado nao ficou ocioso no pool');

    // E o pool continua utilizavel: abre uma conexao nova sob demanda.
    const vivo = await withReadSnapshot(pool, async (client) => {
      const { rows } = await client.query('SELECT 1 AS ok');
      return rows[0].ok;
    });
    assert.equal(vivo, 1, 'o pool se recupera abrindo uma conexao nova');
  }
);
