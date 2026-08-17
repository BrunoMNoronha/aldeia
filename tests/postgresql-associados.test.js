'use strict';

// Leitura cadastral de associados em PostgreSQL (ADR-003 / PG-2A) — F-01, F-02.
//
// Estes testes existem para uma finalidade especifica: provar que a
// implementacao PostgreSQL produz o MESMO comportamento observavel da leitura
// SQLite ANTES do cutover (PG-6), e nao depois. Cada teste aqui espelha um teste
// de `tests/associados.test.js`; quando os dois divergirem, e porque a conversao
// mudou uma regra em silencio.
//
// Isolamento: schema dedicado criado e derrubado pelo proprio teste, via
// `tests/helpers/postgres.js`. Somente `TEST_DATABASE_URL` habilita a suite —
// `DATABASE_URL` nunca e usada como fallback. Sem banco de teste seguro, os
// testes sao PULADOS de forma visivel (politica ja estabelecida na PG-1).
//
// Fixtures sao minimas e ficticias. Nenhum dado real de associado entra aqui.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LIMITE_PADRAO,
  listarAssociados,
  obterAssociado,
  obterAssociadoPorLegacyId,
} = require('../src/services/associados-postgresql');
// O teto do int4 e conhecimento do TIPO DA COLUNA, entao mora na persistencia.
const { ID_MAXIMO_INT4 } = require('../src/db/postgresql/associados');
const { runMigrations } = require('../src/db/postgresql/migrator');
const { motivoSkip, schemaIsolado } = require('./helpers/postgres');

const skip = motivoSkip();

async function schemaMigrado(t) {
  const ctx = await schemaIsolado(t);
  await runMigrations(ctx.pool);
  return ctx;
}

/**
 * Insercao direta: o servico e somente leitura, entao o cenario e montado no
 * banco. Espelha o helper `inserir` da suite SQLite.
 */
async function inserir(
  pool,
  { legacyId = null, nome, statusCadastral, legacyStatusCode = null, observacoes = null }
) {
  const sql =
    statusCadastral === undefined
      ? `INSERT INTO associado (legacy_id, nome, legacy_status_code, observacoes)
         VALUES ($1, $2, $3, $4) RETURNING id`
      : `INSERT INTO associado (legacy_id, nome, legacy_status_code, observacoes, status_cadastral)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`;
  const parametros = [legacyId, nome, legacyStatusCode, observacoes];
  if (statusCadastral !== undefined) parametros.push(statusCadastral);

  const { rows } = await pool.query(sql, parametros);
  return rows[0].id;
}

function nomes(resultado) {
  return resultado.itens.map((item) => item.nome);
}

// --- P1 / P2: listagem base ---------------------------------------------------

test('PG P1: lista associados em ordem deterministica por nome e id', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  await inserir(pool, { legacyId: '3', nome: 'carlos Dias' });
  await inserir(pool, { legacyId: '1', nome: 'Ana Lima' });
  await inserir(pool, { legacyId: '2', nome: 'Bruno Sa' });

  const resultado = await listarAssociados(pool);

  // 'carlos' minusculo vem por ULTIMO: a ordenacao ignora a caixa, exatamente
  // como o `COLLATE NOCASE` do SQLite.
  assert.deepEqual(nomes(resultado), ['Ana Lima', 'Bruno Sa', 'carlos Dias']);
  assert.equal(resultado.total, 3);
  assert.equal(resultado.truncado, false);
  assert.deepEqual(resultado.filtros, { nome: null, legacyId: null });

  // Repetir a consulta nao pode reordenar nada.
  assert.deepEqual(nomes(await listarAssociados(pool)), nomes(resultado));
});

test('PG P1b: nomes iguais desempatam pelo id, de forma estavel', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const primeiro = await inserir(pool, { legacyId: '1', nome: 'Homonimo' });
  const segundo = await inserir(pool, { legacyId: '2', nome: 'homonimo' });
  const terceiro = await inserir(pool, { legacyId: '3', nome: 'HOMONIMO' });

  // Tres grafias que a ordenacao considera IGUAIS: sem o desempate por id a
  // ordem seria a que o planner devolvesse, e poderia mudar entre execucoes.
  for (let i = 0; i < 5; i += 1) {
    const resultado = await listarAssociados(pool);
    assert.deepEqual(
      resultado.itens.map((item) => item.id),
      [primeiro, segundo, terceiro]
    );
  }
});

test('PG P2: banco vazio devolve lista vazia e total zero, sem lancar', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  const resultado = await listarAssociados(pool);

  assert.deepEqual(resultado.itens, []);
  assert.equal(resultado.total, 0);
  assert.equal(resultado.truncado, false);
});

// --- P3 / P4 / P5: busca por nome ---------------------------------------------

test('PG P3: busca por nome e parcial', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  await inserir(pool, { legacyId: '1', nome: 'Maria Aparecida Souza' });
  await inserir(pool, { legacyId: '2', nome: 'Joao Pedro Souza' });
  await inserir(pool, { legacyId: '3', nome: 'Carla Menezes' });

  assert.deepEqual(nomes(await listarAssociados(pool, { nome: 'Souza' })), [
    'Joao Pedro Souza',
    'Maria Aparecida Souza',
  ]);
  assert.deepEqual(nomes(await listarAssociados(pool, { nome: 'Aparecida' })), [
    'Maria Aparecida Souza',
  ]);
});

test('PG P4: busca por nome ignora caixa e espacos nas bordas', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  await inserir(pool, { legacyId: '1', nome: 'Mariana Souza' });

  assert.deepEqual(nomes(await listarAssociados(pool, { nome: 'mariana' })), ['Mariana Souza']);
  assert.deepEqual(nomes(await listarAssociados(pool, { nome: 'MARIANA' })), ['Mariana Souza']);
  assert.deepEqual(nomes(await listarAssociados(pool, { nome: '  mariana  ' })), ['Mariana Souza']);

  // So espacos nao e filtro: e filtro AUSENTE, nao filtro que nao casa com nada.
  const soEspacos = await listarAssociados(pool, { nome: '   ' });
  assert.equal(soEspacos.filtros.nome, null);
  assert.equal(soEspacos.total, 1);
});

test('PG P5: nome sem correspondencia devolve vazio e preserva o filtro', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  await inserir(pool, { legacyId: '1', nome: 'Alguem' });

  const resultado = await listarAssociados(pool, { nome: 'Ninguem' });

  assert.deepEqual(resultado.itens, []);
  assert.equal(resultado.total, 0);
  assert.equal(resultado.truncado, false);
  assert.equal(resultado.filtros.nome, 'Ninguem');
});

// --- P6 / P7: legacy_id e TEXTO ------------------------------------------------

test('PG P6: filtro por legacy_id e igualdade exata de texto', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  await inserir(pool, { legacyId: '10', nome: 'Dez' });
  await inserir(pool, { legacyId: '100', nome: 'Cem' });

  assert.deepEqual(nomes(await listarAssociados(pool, { legacyId: '10' })), ['Dez']);
  assert.deepEqual(nomes(await listarAssociados(pool, { legacyId: ' 100 ' })), ['Cem']);

  const inexistente = await listarAssociados(pool, { legacyId: '999' });
  assert.deepEqual(inexistente.itens, []);
  assert.equal(inexistente.filtros.legacyId, '999');
});

test('PG P7: "007" e "7" sao identidades DIFERENTES', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  await inserir(pool, { legacyId: '007', nome: 'Zero Zero Sete' });
  await inserir(pool, { legacyId: '7', nome: 'Sete' });

  // Se houvesse CAST numerico ou parseInt em qualquer ponto, os dois colidiriam.
  assert.deepEqual(nomes(await listarAssociados(pool, { legacyId: '007' })), ['Zero Zero Sete']);
  assert.deepEqual(nomes(await listarAssociados(pool, { legacyId: '7' })), ['Sete']);

  assert.equal((await obterAssociadoPorLegacyId(pool, '007')).nome, 'Zero Zero Sete');
  assert.equal((await obterAssociadoPorLegacyId(pool, '7')).nome, 'Sete');

  // Os zeros a esquerda tambem sobrevivem a VOLTA, nao so a ida.
  assert.equal((await obterAssociadoPorLegacyId(pool, '007')).legacyId, '007');
  assert.equal(typeof (await obterAssociadoPorLegacyId(pool, '007')).legacyId, 'string');
});

// --- P8: combinacao de filtros -------------------------------------------------

test('PG P8: nome e legacy_id combinam com AND, nunca com OR', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  await inserir(pool, { legacyId: '1', nome: 'Ana Lima' });
  await inserir(pool, { legacyId: '2', nome: 'Ana Souza' });
  await inserir(pool, { legacyId: '3', nome: 'Bruno Lima' });

  assert.deepEqual(nomes(await listarAssociados(pool, { nome: 'Lima', legacyId: '1' })), [
    'Ana Lima',
  ]);

  // Com OR isto devolveria 'Ana Lima' e 'Ana Souza'; com AND, nada.
  const semInterseccao = await listarAssociados(pool, { nome: 'Ana', legacyId: '2' });
  assert.deepEqual(nomes(semInterseccao), ['Ana Souza']);
  assert.deepEqual((await listarAssociados(pool, { nome: 'Ana', legacyId: '3' })).itens, []);
});

// --- P9: curingas digitados sao literais ---------------------------------------

test('PG P9: %, _ e \\ digitados pelo usuario sao caracteres literais', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  await inserir(pool, { legacyId: '1', nome: 'Ana%Paula' });
  await inserir(pool, { legacyId: '2', nome: 'Ana_Paula' });
  await inserir(pool, { legacyId: '3', nome: 'Ana\\Paula' });
  await inserir(pool, { legacyId: '4', nome: 'AnaXPaula' });

  // Busca pelo nome inteiro: cada um encontra somente a si mesmo.
  assert.deepEqual(nomes(await listarAssociados(pool, { nome: 'Ana%Paula' })), ['Ana%Paula']);
  assert.deepEqual(nomes(await listarAssociados(pool, { nome: 'Ana_Paula' })), ['Ana_Paula']);
  assert.deepEqual(nomes(await listarAssociados(pool, { nome: 'Ana\\Paula' })), ['Ana\\Paula']);

  // Sozinhos, os metacaracteres NAO viram curinga: '%' nao lista todo mundo e
  // '_' nao casa com qualquer caractere.
  assert.deepEqual(nomes(await listarAssociados(pool, { nome: '%' })), ['Ana%Paula']);
  assert.deepEqual(nomes(await listarAssociados(pool, { nome: '_' })), ['Ana_Paula']);
  assert.deepEqual(nomes(await listarAssociados(pool, { nome: '\\' })), ['Ana\\Paula']);

  // 'Ana_' casaria com os quatro se '_' fosse curinga.
  assert.deepEqual(nomes(await listarAssociados(pool, { nome: 'Ana_' })), ['Ana_Paula']);
  assert.deepEqual(nomes(await listarAssociados(pool, { nome: 'Ana%' })), ['Ana%Paula']);
});

// --- P10: limite e truncamento -------------------------------------------------

test('PG P10: limite menor que o universo corta e sinaliza truncado', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  await inserir(pool, { legacyId: '1', nome: 'Ana' });
  await inserir(pool, { legacyId: '2', nome: 'Bruno' });
  await inserir(pool, { legacyId: '3', nome: 'Carla' });

  const resultado = await listarAssociados(pool, { limite: 2 });

  assert.deepEqual(nomes(resultado), ['Ana', 'Bruno']);
  // `total` conta os itens DESTA resposta, nao o universo.
  assert.equal(resultado.total, 2);
  assert.equal(resultado.truncado, true);

  // Limite exatamente igual ao universo nao e truncamento.
  const exato = await listarAssociados(pool, { limite: 3 });
  assert.equal(exato.total, 3);
  assert.equal(exato.truncado, false);

  // Limite invalido cai no padrao em vez de virar 0 linhas.
  assert.equal((await listarAssociados(pool, { limite: 0 })).total, 3);
  assert.equal((await listarAssociados(pool, { limite: -1 })).total, 3);
  assert.equal((await listarAssociados(pool, { limite: 'muitos' })).total, 3);
  assert.equal(LIMITE_PADRAO, 500);
});

test('PG P10b: o truncamento vale junto com filtro (a numeracao dos $n nao desloca)', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  for (const sufixo of ['A', 'B', 'C']) {
    await inserir(pool, { legacyId: `s-${sufixo}`, nome: `Souza ${sufixo}` });
  }
  await inserir(pool, { legacyId: 'outro', nome: 'Fora do filtro' });

  // Com o filtro de nome presente, o LIMIT e $2 e nao $1. Se a numeracao
  // deslizasse, o banco receberia o padrao LIKE como limite (ou o contrario).
  const resultado = await listarAssociados(pool, { nome: 'Souza', limite: 2 });

  assert.deepEqual(nomes(resultado), ['Souza A', 'Souza B']);
  assert.equal(resultado.total, 2);
  assert.equal(resultado.truncado, true);

  // Mesma verificacao com os DOIS filtros: agora o LIMIT e $3.
  const doisFiltros = await listarAssociados(pool, { nome: 'Souza', legacyId: 's-C', limite: 1 });
  assert.deepEqual(nomes(doisFiltros), ['Souza C']);
  assert.equal(doisFiltros.truncado, false);
});

// --- P11 / P12 / P13: detalhe por id -------------------------------------------

test('PG P11: detalhe por id existente devolve o cadastro mapeado', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const id = await inserir(pool, {
    legacyId: '42',
    nome: 'Associado Detalhe',
    legacyStatusCode: 'i',
    observacoes: 'anotacao livre',
  });

  const associado = await obterAssociado(pool, id);

  assert.equal(associado.id, id);
  assert.equal(associado.legacyId, '42');
  assert.equal(associado.nome, 'Associado Detalhe');
  assert.equal(associado.statusCadastral, 'indefinido');
  assert.equal(associado.legacyStatusCode, 'i');
  assert.equal(associado.observacoes, 'anotacao livre');
  // O contrato dos instantes e STRING nas duas trilhas, apesar de o PostgreSQL
  // guardar TIMESTAMPTZ e o driver entregar `Date`.
  assert.equal(typeof associado.criadoEm, 'string');
  assert.equal(typeof associado.atualizadoEm, 'string');

  // Id tambem aceito como string de digitos, como no SQLite.
  assert.equal((await obterAssociado(pool, String(id))).id, id);
});

test('PG P12: id inexistente devolve null em vez de lancar', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);

  assert.equal(await obterAssociado(pool, 999), null);
});

test('PG P13: id invalido devolve null', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  await inserir(pool, { legacyId: '1', nome: 'Alguem' });

  for (const invalido of ['abc', '', '  ', 0, '0', -1, '-1', 1.5, '1.5', null, undefined, {}, ['1']]) {
    assert.equal(
      await obterAssociado(pool, invalido),
      null,
      `esperava null para ${JSON.stringify(invalido)}`
    );
  }
});

test('PG P13b: id acima do teto do int4 devolve null, nao erro do banco', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  await inserir(pool, { legacyId: '1', nome: 'Alguem' });

  // A coluna e INTEGER: mandar isto ao PostgreSQL levantaria erro de conversao,
  // enquanto o SQLite apenas nao acharia a linha. A resposta observavel precisa
  // ser a mesma nos dois: `null`.
  assert.equal(await obterAssociado(pool, ID_MAXIMO_INT4 + 1), null);
  assert.equal(await obterAssociado(pool, '99999999999999'), null);

  // O teto em si continua sendo um id valido a consultar (so nao existe aqui).
  assert.equal(await obterAssociado(pool, ID_MAXIMO_INT4), null);
});

// --- P14: detalhe por legacy_id ------------------------------------------------

test('PG P14: busca por legacy_id existente, inexistente e invalido', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  await inserir(pool, { legacyId: 'A-12', nome: 'Codigo Nao Numerico' });

  assert.equal((await obterAssociadoPorLegacyId(pool, 'A-12')).nome, 'Codigo Nao Numerico');
  assert.equal(await obterAssociadoPorLegacyId(pool, 'A-13'), null);
  assert.equal(await obterAssociadoPorLegacyId(pool, '   '), null);
  assert.equal(await obterAssociadoPorLegacyId(pool, ''), null);
  assert.equal(await obterAssociadoPorLegacyId(pool, null), null);
  assert.equal(await obterAssociadoPorLegacyId(pool, undefined), null);
  assert.equal(await obterAssociadoPorLegacyId(pool, 12), null);
});

// --- P15 / P16: o dado atravessa o servico intacto -----------------------------

test('PG P15: acentos e caracteres especiais voltam verbatim', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const nome = 'José "Zé" Gonçalves & Cia <irmãos>';
  const id = await inserir(pool, { legacyId: '1', nome, observacoes: "aspas ' e < > &" });

  const associado = await obterAssociado(pool, id);

  assert.equal(associado.nome, nome);
  assert.equal(associado.observacoes, "aspas ' e < > &");
  assert.deepEqual(nomes(await listarAssociados(pool, { nome: 'Gonçalves' })), [nome]);
});

test('PG P16: string parecida com SQL injection e apenas dado', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const malicioso = "'; DROP TABLE associado; --";
  await inserir(pool, { legacyId: malicioso, nome: malicioso });

  assert.deepEqual(nomes(await listarAssociados(pool, { nome: malicioso })), [malicioso]);
  assert.deepEqual(nomes(await listarAssociados(pool, { legacyId: malicioso })), [malicioso]);

  // A tabela continua de pe e o registro continua la.
  const { rows } = await pool.query('SELECT COUNT(*) AS t FROM associado');
  assert.equal(Number(rows[0].t), 1);
});

// --- P17 / P18: nenhuma interpretacao financeira -------------------------------

test('PG P17: o objeto de associado nao possui campo financeiro derivado', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const id = await inserir(pool, { legacyId: '1', nome: 'Sem Financeiro', legacyStatusCode: 'a' });

  const associado = await obterAssociado(pool, id);

  // Conjunto de chaves FECHADO: identico ao da trilha SQLite.
  assert.deepEqual(Object.keys(associado).sort(), [
    'atualizadoEm',
    'criadoEm',
    'id',
    'legacyId',
    'legacyStatusCode',
    'nome',
    'observacoes',
    'statusCadastral',
  ]);

  for (const proibido of [
    'situacao',
    'situacaoFinanceira',
    'adimplente',
    'inadimplente',
    'saldo',
    'emDia',
    'devedor',
  ]) {
    assert.equal(proibido in associado, false, `campo derivado proibido: ${proibido}`);
  }

  // O mesmo vale para os itens da listagem, nao so para o detalhe (M-06).
  const [item] = (await listarAssociados(pool)).itens;
  assert.deepEqual(Object.keys(item).sort(), Object.keys(associado).sort());
});

test('PG P18: legacy_status_code permanece bruto e nao contamina o status cadastral', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  const idA = await inserir(pool, { legacyId: '1', nome: 'Codigo A', legacyStatusCode: 'a' });
  const idI = await inserir(pool, { legacyId: '2', nome: 'Codigo I', legacyStatusCode: 'i' });
  const idD = await inserir(pool, {
    legacyId: '3',
    nome: 'Codigo Desligado',
    legacyStatusCode: 'DESLIGADO',
  });
  const idNulo = await inserir(pool, { legacyId: '4', nome: 'Sem Codigo' });

  // Verbatim: mesma caixa, mesmo texto, sem traducao. C-01 segue TO CONFIRM.
  assert.equal((await obterAssociado(pool, idA)).legacyStatusCode, 'a');
  assert.equal((await obterAssociado(pool, idI)).legacyStatusCode, 'i');
  assert.equal((await obterAssociado(pool, idD)).legacyStatusCode, 'DESLIGADO');
  assert.equal((await obterAssociado(pool, idNulo)).legacyStatusCode, null);

  // 'a' NAO vira 'ativo' e 'i' NAO vira 'inativo': o status cadastral segue no
  // default do schema.
  for (const id of [idA, idI, idD, idNulo]) {
    assert.equal((await obterAssociado(pool, id)).statusCadastral, 'indefinido');
  }
});

test('PG P18b: nenhum codigo legado vira filtro ou ordenacao implicita', { skip }, async (t) => {
  const { pool } = await schemaMigrado(t);
  await inserir(pool, { legacyId: '1', nome: 'Ana', legacyStatusCode: 'DESLIGADO' });
  await inserir(pool, { legacyId: '2', nome: 'Bruno', legacyStatusCode: 'i' });
  await inserir(pool, { legacyId: '3', nome: 'Carla', legacyStatusCode: 'a' });

  // Um servico que "entendesse" C-01 tenderia a esconder o desligado ou a
  // empurra-lo para o fim. A listagem devolve os tres, na ordem por nome.
  const resultado = await listarAssociados(pool);

  assert.deepEqual(nomes(resultado), ['Ana', 'Bruno', 'Carla']);
  assert.deepEqual(
    resultado.itens.map((item) => item.legacyStatusCode),
    ['DESLIGADO', 'i', 'a']
  );
});
