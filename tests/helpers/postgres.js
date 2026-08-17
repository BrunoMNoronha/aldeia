'use strict';

/**
 * Helper de testes PostgreSQL (ADR-003).
 *
 * Regra que governa este arquivo inteiro: FALHAR FECHADO. Teste de integracao
 * cria e derruba schema; se houver qualquer duvida sobre para onde a conexao
 * aponta, o correto e PULAR o teste, nunca "tentar assim mesmo".
 *
 * Por isso:
 *  - so `TEST_DATABASE_URL` habilita esses testes. `DATABASE_URL` NUNCA e usada
 *    como fallback, nem quando esta definida e a de teste nao;
 *  - o isolamento e por SCHEMA dedicado, criado e derrubado pelo proprio teste.
 *    Nenhum teste executa DROP DATABASE, DROP SCHEMA public, TRUNCATE ou DELETE
 *    em massa: mesmo que a URL de teste apontasse para um banco compartilhado,
 *    o raio de acao seria o schema que o proprio teste criou.
 */

const { createPool } = require('../../src/db/postgresql/connection');
const { resolveDatabaseUrl, resolveTestDatabaseUrl } = require('../../src/config');

/** Nomes de banco que jamais sao aceitos como destino de teste. */
const NOMES_PROIBIDOS = new Set([
  'postgres',
  'template0',
  'template1',
  'prod',
  'producao',
  'production',
  'acasa',
]);

/**
 * Decide se a URL pode receber operacoes de teste.
 *
 * @param {string | null} url
 * @param {string | null} urlOficial
 * @returns {{ seguro: boolean, motivo: string }}
 */
function avaliarBancoDeTeste(url, urlOficial = resolveDatabaseUrl()) {
  if (url === null) {
    return { seguro: false, motivo: 'TEST_DATABASE_URL nao definida' };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { seguro: false, motivo: 'TEST_DATABASE_URL nao e uma URL valida' };
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    return { seguro: false, motivo: `protocolo inesperado: ${parsed.protocol}` };
  }

  if (urlOficial !== null && url === urlOficial) {
    return {
      seguro: false,
      motivo: 'TEST_DATABASE_URL e identica a DATABASE_URL (o banco oficial nao e banco de teste)',
    };
  }

  const nomeBanco = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (nomeBanco === '') {
    return { seguro: false, motivo: 'TEST_DATABASE_URL nao nomeia um banco' };
  }
  if (NOMES_PROIBIDOS.has(nomeBanco.toLowerCase())) {
    return { seguro: false, motivo: `nome de banco proibido para teste: ${nomeBanco}` };
  }
  // Ultima barreira, e a mais simples de auditar: o banco precisa se declarar
  // banco de teste no proprio nome.
  if (!/test/i.test(nomeBanco)) {
    return {
      seguro: false,
      motivo: `nome de banco nao contem "test": ${nomeBanco}`,
    };
  }

  return { seguro: true, motivo: 'ok' };
}

/**
 * @returns {{ disponivel: boolean, url: string | null, motivo: string }}
 */
function bancoDeTeste() {
  const url = resolveTestDatabaseUrl();
  const { seguro, motivo } = avaliarBancoDeTeste(url);
  return { disponivel: seguro, url: seguro ? url : null, motivo };
}

/**
 * Mensagem de skip. Os testes de integracao usam `{ skip: motivoSkip() }` para
 * que o pulo apareca no relatorio do `node --test` — silenciar a ausencia de
 * PostgreSQL seria confundir "nao testado" com "testado e verde".
 *
 * @returns {string | false}
 */
function motivoSkip() {
  const { disponivel, motivo } = bancoDeTeste();
  return disponivel ? false : `PostgreSQL indisponivel para teste: ${motivo}`;
}

let contadorDeSchema = 0;

/**
 * Cria um schema dedicado para o teste e devolve um pool com `search_path`
 * apontando para ele. O schema e derrubado ao fim do teste.
 *
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{ pool: import('pg').Pool, schema: string, url: string }>}
 */
async function schemaIsolado(t) {
  const { disponivel, url, motivo } = bancoDeTeste();
  if (!disponivel) throw new Error(`schemaIsolado exige banco de teste seguro: ${motivo}`);

  contadorDeSchema += 1;
  // Identificador previsivel e sem caracteres especiais: nada aqui vem de fora.
  const schema = `pgtest_${process.pid}_${contadorDeSchema}`;

  const admin = createPool({ connectionString: url, max: 2 });
  await admin.query(`CREATE SCHEMA ${schema}`);

  // `search_path` no proprio parametro de conexao: todo client do pool ja nasce
  // apontando para o schema do teste, inclusive os criados depois.
  const pool = createPool({
    connectionString: url,
    max: 4,
    options: `-c search_path=${schema}`,
  });

  t.after(async () => {
    // `pg` rejeita um segundo `end()`; um teste pode ter encerrado o pool de
    // proposito e isso nao pode quebrar a limpeza do schema.
    if (pool.ended !== true) await pool.end();
    // CASCADE limitado ao schema que ESTE teste criou. `public` nunca e tocado.
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  return { pool, schema, url };
}

module.exports = { avaliarBancoDeTeste, bancoDeTeste, motivoSkip, schemaIsolado, NOMES_PROIBIDOS };
