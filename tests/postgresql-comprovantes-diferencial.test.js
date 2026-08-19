'use strict';

// Teste DIFERENCIAL SQLite x PostgreSQL - leitura de comprovante (ADR-003, PG-2B1).
//
// As duas suites de contrato provam cada implementacao contra um resultado
// ESCRITO A MAO. Isso deixa um buraco: se as trilhas divergirem num caso que
// ninguem pensou em escrever, nada acusa. Aqui as duas rodam sobre datasets
// SEMANTICAMENTE EQUIVALENTES e os resultados sao comparados um contra o outro:
// o oraculo e a outra implementacao.
//
// O que NAO da para comparar por valor, e por que:
//   `criado_em` / `atualizado_em` sao gerados por cada banco no momento da
//   insercao, entao os dois relogios nunca coincidiriam. Comparamos TIPO e
//   FORMATO (o contrato observavel), que e onde um cutover quebraria, e nao o
//   instante, que nunca poderia ser igual. Os ids tambem vem de sequences
//   independentes: comparamos a POSICAO relativa, normalizando id -> rotulo.
//
// Fixtures ficticias e minimas. As linhas sao inseridas direto nos dois bancos:
// a implementacao SQLite do ledger nunca escreve no PostgreSQL.

const test = require('node:test');
const assert = require('node:assert/strict');

const sqlite = require('../src/services/comprovantes');
const postgresql = require('../src/services/comprovantes-postgresql');
const { runMigrations } = require('../src/db/postgresql/migrator');
const { createMigratedDb } = require('./helpers/temp-db');
const { motivoSkip, schemaIsolado } = require('./helpers/postgres');
const { ID_MAXIMO_INT4 } = require('../src/db/postgresql/tipos');

const skip = motivoSkip();

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/**
 * Cenario comum, descrito uma vez e materializado nos dois bancos na MESMA
 * ordem, para que os ids gerados coincidam e a comparacao de ordem tenha
 * sentido.
 *
 * Cobre: os quatro estados, movimento sem registro, movimento INATIVADO,
 * comprovante INDEPENDENTE (sem movimento) e datas iguais com ids diferentes.
 */
const MOVIMENTOS = [
  { rotulo: 'pendente', data: '2026-02-01', valor: 15000, ativo: true, estado: 'pendente', obs: 'aguardando envio' },
  { rotulo: 'ausente', data: '2026-01-01', valor: 22050, ativo: true, estado: 'ausente', obs: 'ok, recebido' },
  { rotulo: 'presente', data: '2026-03-01', valor: 1, ativo: true, estado: 'presente', obs: 'faltando' },
  { rotulo: 'naoAplicavel', data: '2026-01-15', valor: 999999, ativo: true, estado: 'nao_aplicavel', obs: null },
  { rotulo: 'semRegistro', data: '2026-01-20', valor: 500, ativo: true, estado: null, obs: null },
  { rotulo: 'inativado', data: '2026-02-01', valor: 7777, ativo: false, estado: 'ausente', obs: 'lancamento duplicado' },
  { rotulo: 'mesmaDataA', data: '2026-04-01', valor: 100, ativo: true, estado: 'pendente', obs: null },
  { rotulo: 'mesmaDataB', data: '2026-04-01', valor: 200, ativo: true, estado: 'pendente', obs: null },
];

const INATIVADO_EM = '2026-05-01T00:00:00Z';
const MOTIVO_INATIVACAO = 'lancamento duplicado';

function montarSqlite(t) {
  const { db } = createMigratedDb(t);
  const ids = new Map();

  for (const m of MOVIMENTOS) {
    const info = db
      .prepare(
        `INSERT INTO movimento_financeiro
           (data, valor_centavos, tipo, origem, estado_identificacao, ativo, inativado_em, motivo_inativacao)
         VALUES (?, ?, 'credito', 'pagamento', 'nao_identificado', ?, ?, ?)`
      )
      .run(m.data, m.valor, m.ativo ? 1 : 0, m.ativo ? null : INATIVADO_EM, m.ativo ? null : MOTIVO_INATIVACAO);
    const id = Number(info.lastInsertRowid);
    ids.set(m.rotulo, id);

    if (m.estado !== null) {
      db.prepare('INSERT INTO comprovante (movimento_id, estado, observacao) VALUES (?, ?, ?)').run(
        id,
        m.estado,
        m.obs
      );
    }
  }

  // Comprovante INDEPENDENTE (M-04): existe, mas nao pertence a movimento algum.
  db.prepare('INSERT INTO comprovante (movimento_id, estado, observacao) VALUES (NULL, ?, NULL)').run(
    'pendente'
  );

  return { db, ids };
}

async function montarPostgresql(t) {
  const { pool } = await schemaIsolado(t);
  await runMigrations(pool);
  const ids = new Map();

  for (const m of MOVIMENTOS) {
    const { rows } = await pool.query(
      `INSERT INTO movimento_financeiro
         (data, valor_centavos, tipo, origem, estado_identificacao, ativo, inativado_em, motivo_inativacao)
       VALUES ($1, $2, 'credito', 'pagamento', 'nao_identificado', $3, $4, $5)
       RETURNING id`,
      [m.data, m.valor, m.ativo, m.ativo ? null : INATIVADO_EM, m.ativo ? null : MOTIVO_INATIVACAO]
    );
    const id = rows[0].id;
    ids.set(m.rotulo, id);

    if (m.estado !== null) {
      await pool.query(
        'INSERT INTO comprovante (movimento_id, estado, observacao) VALUES ($1, $2, $3)',
        [id, m.estado, m.obs]
      );
    }
  }

  await pool.query(
    'INSERT INTO comprovante (movimento_id, estado, observacao) VALUES (NULL, $1, NULL)',
    ['pendente']
  );

  return { pool, ids };
}

async function montarCenario(t) {
  const { db, ids: idsSqlite } = montarSqlite(t);
  const { pool, ids: idsPostgresql } = await montarPostgresql(t);
  return { db, pool, idsSqlite, idsPostgresql };
}

/** Executa `fn` e devolve o erro lancado. `assert.throws` nao devolve o erro. */
function capturar(fn) {
  try {
    fn();
  } catch (erro) {
    return erro;
  }
  return assert.fail('esperava um erro, mas nada foi lancado');
}

/** Rotulo estavel no lugar do id: as sequences dos dois bancos sao independentes. */
function rotuloDe(ids, id) {
  for (const [rotulo, valor] of ids) if (valor === id) return rotulo;
  return `desconhecido(${id})`;
}

/**
 * Forma comparavel da evidencia individual. `registro.criadoEm/atualizadoEm`
 * viram TIPO e conformidade de FORMATO: os relogios nunca poderiam bater.
 */
function normalizarEvidencia(evidencia) {
  const { registro } = evidencia;
  return {
    registrado: evidencia.registrado,
    estado: evidencia.estado,
    estadoTecnico: evidencia.estadoTecnico,
    pendenteDeEvidencia: evidencia.pendenteDeEvidencia,
    observacao: evidencia.observacao,
    registro:
      registro === null
        ? null
        : {
            estado: registro.estado,
            observacao: registro.observacao,
            referenciaExterna: registro.referenciaExterna,
            data: registro.data,
            tipoCriadoEm: typeof registro.criadoEm,
            formatoCriadoEm: TIMESTAMP_RE.test(registro.criadoEm),
            tipoAtualizadoEm: typeof registro.atualizadoEm,
            formatoAtualizadoEm: TIMESTAMP_RE.test(registro.atualizadoEm),
          },
  };
}

function normalizarItemDaFila(item, ids) {
  return {
    rotulo: rotuloDe(ids, item.movimentoId),
    estado: item.estado,
    observacao: item.observacao,
    tipoCriadoEm: typeof item.criadoEm,
    formatoCriadoEm: TIMESTAMP_RE.test(item.criadoEm),
    movimento: {
      data: item.movimento.data,
      tipoData: typeof item.movimento.data,
      valorCentavos: item.movimento.valorCentavos,
      tipoValor: typeof item.movimento.valorCentavos,
      valorInteiro: Number.isInteger(item.movimento.valorCentavos),
      associadoId: item.movimento.associadoId,
      estadoIdentificacao: item.movimento.estadoIdentificacao,
      ativo: item.movimento.ativo,
      tipoAtivo: typeof item.movimento.ativo,
    },
  };
}

// =============================================================================

test('DIFERENCIAL A: evidencia individual identica nos dois bancos', { skip }, async (t) => {
  const { db, pool, idsSqlite, idsPostgresql } = await montarCenario(t);

  for (const { rotulo } of MOVIMENTOS) {
    const esperado = normalizarEvidencia(
      sqlite.obterComprovanteDoMovimento(db, idsSqlite.get(rotulo))
    );
    const obtido = normalizarEvidencia(
      await postgresql.obterComprovanteDoMovimento(pool, idsPostgresql.get(rotulo))
    );

    assert.deepEqual(obtido, esperado, `evidencia divergiu para "${rotulo}"`);
  }

  // Ancora: sem registro NAO e 'ausente', nas duas trilhas.
  const semRegistroSqlite = sqlite.obterComprovanteDoMovimento(db, idsSqlite.get('semRegistro'));
  const semRegistroPg = await postgresql.obterComprovanteDoMovimento(
    pool,
    idsPostgresql.get('semRegistro')
  );
  for (const e of [semRegistroSqlite, semRegistroPg]) {
    assert.equal(e.estado, null);
    assert.equal(e.estadoTecnico, 'sem_registro');
    assert.notEqual(e.estadoTecnico, 'ausente');
    assert.equal(e.pendenteDeEvidencia, false);
  }

  // Movimento inexistente: mesmo erro e mesmo codigo nas duas.
  const inexistenteSqlite = capturar(() => sqlite.obterComprovanteDoMovimento(db, 999999));
  await assert.rejects(
    () => postgresql.obterComprovanteDoMovimento(pool, 999999),
    (erro) => {
      assert.equal(erro.name, inexistenteSqlite.name);
      assert.equal(erro.codigo, inexistenteSqlite.codigo);
      assert.equal(erro.codigo, 'movimento_inexistente');
      return true;
    }
  );

  // Id invalido: mesmo codigo.
  for (const invalido of [0, -1, 1.5, '1', null, undefined]) {
    const erroSqlite = capturar(() => sqlite.obterComprovanteDoMovimento(db, invalido));
    await assert.rejects(
      () => postgresql.obterComprovanteDoMovimento(pool, invalido),
      (erro) => erro.codigo === erroSqlite.codigo && erro.codigo === 'id_invalido'
    );
  }
});

test('DIFERENCIAL B: consulta em lote identica nos dois bancos', { skip }, async (t) => {
  const { db, pool, idsSqlite, idsPostgresql } = await montarCenario(t);

  // Mistura deliberada: com comprovante, sem comprovante e inativado.
  const rotulos = ['presente', 'semRegistro', 'pendente', 'inativado', 'naoAplicavel'];

  const mapaSqlite = sqlite.obterComprovantesDeMovimentos(
    db,
    rotulos.map((r) => idsSqlite.get(r))
  );
  const mapaPg = await postgresql.obterComprovantesDeMovimentos(
    pool,
    rotulos.map((r) => idsPostgresql.get(r))
  );

  assert.equal(mapaPg.size, mapaSqlite.size, 'o lote devolve uma entrada por id pedido');
  assert.equal(mapaPg.size, rotulos.length);

  for (const rotulo of rotulos) {
    const esperado = normalizarEvidencia(mapaSqlite.get(idsSqlite.get(rotulo)));
    const obtido = normalizarEvidencia(mapaPg.get(idsPostgresql.get(rotulo)));
    assert.deepEqual(obtido, esperado, `lote divergiu para "${rotulo}"`);
  }

  // Lista vazia: Map vazio nas duas.
  assert.equal(sqlite.obterComprovantesDeMovimentos(db, []).size, 0);
  assert.equal((await postgresql.obterComprovantesDeMovimentos(pool, [])).size, 0);
});

test('DIFERENCIAL C: fila de pendencia identica nos dois bancos', { skip }, async (t) => {
  const { db, pool, idsSqlite, idsPostgresql } = await montarCenario(t);

  const cenarios = [
    { rotulo: 'padrao', opcoes: {} },
    { rotulo: 'so pendente', opcoes: { estado: 'pendente' } },
    { rotulo: 'so ausente', opcoes: { estado: 'ausente' } },
    { rotulo: 'primeira pagina', opcoes: { limite: 2, offset: 0 } },
    { rotulo: 'segunda pagina', opcoes: { limite: 2, offset: 2 } },
    { rotulo: 'alem do fim', opcoes: { limite: 2, offset: 50 } },
    { rotulo: 'limite 1', opcoes: { limite: 1, offset: 1 } },
  ];

  for (const { rotulo, opcoes } of cenarios) {
    const filaSqlite = sqlite.listarPendenciasDeComprovante(db, opcoes);
    const filaPg = await postgresql.listarPendenciasDeComprovante(pool, opcoes);

    assert.deepEqual(
      filaPg.itens.map((i) => normalizarItemDaFila(i, idsPostgresql)),
      filaSqlite.itens.map((i) => normalizarItemDaFila(i, idsSqlite)),
      `itens da fila divergiram no cenario "${rotulo}"`
    );
    assert.deepEqual(filaPg.paginacao, filaSqlite.paginacao, `paginacao divergiu em "${rotulo}"`);
    assert.deepEqual(filaPg.estados, filaSqlite.estados, `estados divergiram em "${rotulo}"`);
  }

  // Ancoras de comportamento, caso as DUAS mudem juntas.
  const fila = sqlite.listarPendenciasDeComprovante(db);
  assert.deepEqual(
    fila.itens.map((i) => rotuloDe(idsSqlite, i.movimentoId)),
    // Ordem: data ASC, id ASC. 'pendente' e 'inativado' compartilham 2026-02-01
    // e sao desempatados pelo id; 'presente', 'naoAplicavel' e 'semRegistro'
    // nao entram; o comprovante independente tambem nao.
    ['ausente', 'pendente', 'inativado', 'mesmaDataA', 'mesmaDataB']
  );
  assert.equal(fila.paginacao.total, 5);

  // O inativado permanece elegivel (M-09) e chega como boolean nas duas.
  const inativado = fila.itens.find((i) => rotuloDe(idsSqlite, i.movimentoId) === 'inativado');
  assert.equal(inativado.movimento.ativo, false);
  assert.equal(typeof inativado.movimento.ativo, 'boolean');

  const filaPg = await postgresql.listarPendenciasDeComprovante(pool);
  const inativadoPg = filaPg.itens.find(
    (i) => rotuloDe(idsPostgresql, i.movimentoId) === 'inativado'
  );
  assert.equal(inativadoPg.movimento.ativo, false);
  assert.equal(typeof inativadoPg.movimento.ativo, 'boolean');

  // Estado invalido: mesmo codigo de erro nas duas trilhas.
  for (const estado of ['presente', 'nao_aplicavel', 'sem_registro', 'OK']) {
    const erroSqlite = capturar(() => sqlite.listarPendenciasDeComprovante(db, { estado }));
    await assert.rejects(
      () => postgresql.listarPendenciasDeComprovante(pool, { estado }),
      (erro) => erro.codigo === erroSqlite.codigo && erro.codigo === 'estado_comprovante_invalido'
    );
  }
});

test('DIFERENCIAL D: nenhuma das trilhas escreve ao ler', { skip }, async (t) => {
  const { db, pool, idsSqlite, idsPostgresql } = await montarCenario(t);

  const contarSqlite = (tabela) => db.prepare(`SELECT COUNT(*) AS t FROM ${tabela}`).get().t;
  const contarPg = async (tabela) => {
    const { rows } = await pool.query(`SELECT COUNT(*) AS t FROM ${tabela}`);
    return Number(rows[0].t);
  };

  const antes = {
    comprovanteSqlite: contarSqlite('comprovante'),
    auditSqlite: contarSqlite('audit_log'),
    movimentoSqlite: contarSqlite('movimento_financeiro'),
    comprovantePg: await contarPg('comprovante'),
    auditPg: await contarPg('audit_log'),
    movimentoPg: await contarPg('movimento_financeiro'),
  };

  for (let i = 0; i < 2; i += 1) {
    for (const { rotulo } of MOVIMENTOS) {
      sqlite.obterComprovanteDoMovimento(db, idsSqlite.get(rotulo));
      await postgresql.obterComprovanteDoMovimento(pool, idsPostgresql.get(rotulo));
    }
    sqlite.obterComprovantesDeMovimentos(db, [...idsSqlite.values()]);
    await postgresql.obterComprovantesDeMovimentos(pool, [...idsPostgresql.values()]);
    sqlite.listarPendenciasDeComprovante(db);
    await postgresql.listarPendenciasDeComprovante(pool);
  }

  assert.equal(contarSqlite('comprovante'), antes.comprovanteSqlite);
  assert.equal(contarSqlite('audit_log'), antes.auditSqlite);
  assert.equal(contarSqlite('movimento_financeiro'), antes.movimentoSqlite);
  assert.equal(await contarPg('comprovante'), antes.comprovantePg);
  assert.equal(await contarPg('audit_log'), antes.auditPg, 'leitura nunca gera audit_log');
  assert.equal(await contarPg('movimento_financeiro'), antes.movimentoPg);
});

test('DIFERENCIAL E: ids no limite do int4 respondem igual nos dois bancos', { skip }, async (t) => {
  const { db, pool } = await montarCenario(t);

  // O PostgreSQL guarda a chave em `int4`; o SQLite, em 64 bits. A validacao de
  // entrada aceita qualquer inteiro seguro do JavaScript porque essa e regra de
  // dominio, nao do banco. Sem tratamento na persistencia PostgreSQL, os dois
  // ultimos ids abaixo divergiam: o SQLite respondia "nao existe" e o PostgreSQL
  // vazava `22003 value out of range for type integer`.
  const IDS = [ID_MAXIMO_INT4, ID_MAXIMO_INT4 + 1, Number.MAX_SAFE_INTEGER];

  for (const id of IDS) {
    const erroSqlite = capturar(() => sqlite.obterComprovanteDoMovimento(db, id));
    await assert.rejects(
      () => postgresql.obterComprovanteDoMovimento(pool, id),
      (erro) => {
        assert.equal(erro.name, erroSqlite.name, `name divergiu para o id ${id}`);
        assert.equal(erro.codigo, erroSqlite.codigo, `codigo divergiu para o id ${id}`);
        assert.equal(erro.codigo, 'movimento_inexistente');
        return true;
      },
      `evidencia individual divergiu para o id ${id}`
    );
  }

  // No lote, o contrato e nao lancar: cada id pedido recebe sua entrada.
  const esperado = [...sqlite.obterComprovantesDeMovimentos(db, IDS).values()].map(
    normalizarEvidencia
  );
  const obtido = [...(await postgresql.obterComprovantesDeMovimentos(pool, IDS)).values()].map(
    normalizarEvidencia
  );
  assert.deepEqual(obtido, esperado, 'lote divergiu no limite do int4');

  // E um id fora da faixa nao pode derrubar os validos que vao com ele: antes da
  // correcao, o lote INTEIRO era recusado por causa de um vizinho.
  const misturado = [idsSqliteValido(db), ID_MAXIMO_INT4 + 1];
  const mapaSqlite = sqlite.obterComprovantesDeMovimentos(db, misturado);
  const mapaPg = await postgresql.obterComprovantesDeMovimentos(pool, [
    misturado[0],
    ID_MAXIMO_INT4 + 1,
  ]);
  assert.equal(mapaPg.size, mapaSqlite.size);
  assert.equal(mapaPg.size, 2);
});

/** Primeiro id real do cenario SQLite, para o caso misturado acima. */
function idsSqliteValido(db) {
  return db.prepare('SELECT MIN(id) AS id FROM movimento_financeiro').get().id;
}

// =============================================================================
// ESCRITA (PG-2B2) — a mesma sequencia de negocio nos dois bancos
// =============================================================================
//
// A leitura ja e comparada acima. A gravacao tem uma superficie propria que so
// aparece quando alguem ESCREVE: o resultado declarado (`alteracao`), o que
// conta como reenvio identico e o conteudo da trilha de auditoria. Aqui as duas
// trilhas executam a MESMA sequencia e os resultados sao comparados entre si.

/** Sequencia de negocio: criar -> reenviar igual -> mudar estado -> mudar observacao. */
const SEQUENCIA = [
  { estado: 'pendente', observacao: 'Comprovante solicitado ao associado.' },
  { estado: 'pendente', observacao: 'Comprovante solicitado ao associado.' },
  { estado: 'presente', observacao: 'Comprovante solicitado ao associado.' },
  { estado: 'presente', observacao: 'Recebido por e-mail.' },
];

const SQL_MOVIMENTO_SOLO = `
  INSERT INTO movimento_financeiro
    (data, valor_centavos, tipo, origem, estado_identificacao, ativo)
  VALUES ('2026-06-01', 12345, 'credito', 'pagamento', 'nao_identificado', `;

/** Estado serializado na trilha, sem o que os dois bancos nao podem ter igual. */
function normalizarEstadoAuditado(texto) {
  if (texto === null || texto === undefined) return null;
  const estado = JSON.parse(texto);
  return {
    estado: estado.estado,
    observacao: estado.observacao,
    referenciaExterna: estado.referenciaExterna,
    data: estado.data,
    formatoCriadoEm: TIMESTAMP_RE.test(estado.criadoEm),
    formatoAtualizadoEm: TIMESTAMP_RE.test(estado.atualizadoEm),
  };
}

/**
 * Entrada de auditoria comparavel. `entidade_id` e o id do comprovante, que as
 * duas sequences geram de forma independente: comparamos se ele APONTA para o
 * comprovante certo, nao o numero.
 */
function normalizarAuditoria(linha, comprovanteId, movimentoId) {
  return {
    ator: linha.ator,
    acao: linha.acao,
    entidadeTipo: linha.entidade_tipo,
    entidadeIdApontaParaOComprovante: linha.entidade_id === String(comprovanteId),
    estadoAnterior: normalizarEstadoAuditado(linha.estado_anterior),
    estadoPosterior: normalizarEstadoAuditado(linha.estado_posterior),
    metadados: { ...JSON.parse(linha.metadados), movimentoId: linha.metadados === null ? null : '<movimento>' },
    metadadosApontaParaOMovimento: JSON.parse(linha.metadados).movimentoId === movimentoId,
  };
}

test('DIFERENCIAL PG-2B2: criar, reenviar, alterar estado e alterar observacao', { skip }, async (t) => {
  const { db } = createMigratedDb(t);
  const movimentoSqlite = Number(
    db.prepare(`${SQL_MOVIMENTO_SOLO}1)`).run().lastInsertRowid
  );

  const { pool } = await schemaIsolado(t);
  await runMigrations(pool);
  const { rows } = await pool.query(`${SQL_MOVIMENTO_SOLO}true) RETURNING id`);
  const movimentoPg = rows[0].id;

  const resultadosSqlite = SEQUENCIA.map((passo) =>
    sqlite.definirComprovanteDoMovimento(db, { movimentoId: movimentoSqlite, ...passo })
  );
  const resultadosPg = [];
  for (const passo of SEQUENCIA) {
    // Em serie de proposito: a sequencia e um historico, nao uma disputa.
    resultadosPg.push(
      await postgresql.definirComprovanteDoMovimento(pool, { movimentoId: movimentoPg, ...passo })
    );
  }

  // 1. O que ACONTECEU em cada passo tem de ser identico.
  assert.deepEqual(
    resultadosPg.map((r) => r.alteracao),
    resultadosSqlite.map((r) => r.alteracao),
    'a sequencia de resultados declarados divergiu'
  );
  assert.deepEqual(
    resultadosSqlite.map((r) => r.alteracao),
    ['registrado', 'sem_mudanca', 'alterado', 'alterado'],
    'e a sequencia esperada e esta — o oraculo tambem precisa estar certo'
  );

  // 2. A evidencia resultante de cada passo, campo a campo.
  for (let i = 0; i < SEQUENCIA.length; i += 1) {
    assert.deepEqual(
      normalizarEvidencia(resultadosPg[i]),
      normalizarEvidencia(resultadosSqlite[i]),
      `evidencia divergiu no passo ${i + 1}`
    );
  }

  // 3. Uma linha de comprovante em cada banco: alterar nunca cria uma segunda.
  const totalSqlite = db.prepare('SELECT COUNT(*) AS total FROM comprovante').get().total;
  const totalPg = Number((await pool.query('SELECT COUNT(*) AS total FROM comprovante')).rows[0].total);
  assert.equal(totalPg, totalSqlite);
  assert.equal(totalPg, 1);

  // 4. A trilha: mesma quantidade e mesmo conteudo semantico.
  const auditSqlite = db.prepare('SELECT * FROM audit_log ORDER BY id ASC').all();
  const auditPg = (await pool.query('SELECT * FROM audit_log ORDER BY id ASC')).rows;

  assert.equal(auditPg.length, auditSqlite.length, 'quantidade de auditorias divergiu');
  assert.equal(auditSqlite.length, 3, 'o reenvio identico nao gera trilha');

  const comprovanteSqlite = resultadosSqlite[0].registro.id;
  const comprovantePg = resultadosPg[0].registro.id;
  for (let i = 0; i < auditSqlite.length; i += 1) {
    assert.deepEqual(
      normalizarAuditoria(auditPg[i], comprovantePg, movimentoPg),
      normalizarAuditoria(auditSqlite[i], comprovanteSqlite, movimentoSqlite),
      `auditoria ${i + 1} divergiu`
    );
  }
});

test('DIFERENCIAL PG-2B2: recusas de gravacao usam o mesmo codigo nos dois bancos', { skip }, async (t) => {
  const { db } = createMigratedDb(t);
  const movimentoSqlite = Number(db.prepare(`${SQL_MOVIMENTO_SOLO}1)`).run().lastInsertRowid);

  const { pool } = await schemaIsolado(t);
  await runMigrations(pool);
  const { rows } = await pool.query(`${SQL_MOVIMENTO_SOLO}true) RETURNING id`);
  const movimentoPg = rows[0].id;

  const casos = [
    { descricao: 'id invalido', entrada: () => ({ movimentoId: 0, estado: 'pendente' }) },
    { descricao: 'estado fora do vocabulario', entrada: (id) => ({ movimentoId: id, estado: 'OK' }) },
    { descricao: 'estado tecnico como dominio', entrada: (id) => ({ movimentoId: id, estado: 'sem_registro' }) },
    { descricao: 'observacao nao textual', entrada: (id) => ({ movimentoId: id, estado: 'pendente', observacao: 42 }) },
    { descricao: 'movimento inexistente', entrada: () => ({ movimentoId: 987654, estado: 'pendente' }) },
  ];

  for (const caso of casos) {
    const erroSqlite = capturar(() =>
      sqlite.definirComprovanteDoMovimento(db, caso.entrada(movimentoSqlite))
    );
    let erroPg;
    try {
      await postgresql.definirComprovanteDoMovimento(pool, caso.entrada(movimentoPg));
      assert.fail(`PostgreSQL aceitou o que o SQLite recusou: ${caso.descricao}`);
    } catch (erro) {
      erroPg = erro;
    }

    assert.equal(erroPg.name, erroSqlite.name, `${caso.descricao}: tipo de erro divergiu`);
    assert.equal(erroPg.codigo, erroSqlite.codigo, `${caso.descricao}: codigo divergiu`);
  }

  // Recusa nao escreve — nos dois bancos.
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM comprovante').get().total, 0);
  assert.equal(
    Number((await pool.query('SELECT COUNT(*) AS total FROM comprovante')).rows[0].total),
    0
  );
});
