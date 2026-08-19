'use strict';

// Teste DIFERENCIAL SQLite x PostgreSQL — leitura do ledger (ADR-003, PG-2C1).
//
// As duas suites de contrato provam cada implementacao contra um resultado
// ESCRITO A MAO. Isso deixa um buraco: se as trilhas divergirem num caso que
// ninguem pensou em escrever, nada acusa. Aqui as duas rodam sobre datasets
// SEMANTICAMENTE EQUIVALENTES e os resultados sao comparados um contra o outro:
// o oraculo e a outra implementacao.
//
// O que NAO da para comparar por valor, e por que:
//   ids saem de sequences independentes nos dois bancos — comparamos o ROTULO
//   do registro, o que preserva a identidade relativa (quem aponta para quem);
//   `criado_em`/`atualizado_em` sao gerados por cada banco no momento da
//   insercao, entao comparamos TIPO e FORMATO — que e o contrato observavel —
//   e nao o instante, que nunca poderia coincidir.
//
// Tudo o mais e comparado por valor: ordem, valores, `ativo`, tipo, origem,
// estadoIdentificacao, totais, quantidade, rotulo de competencia e presenca ou
// ausencia de historico inativado.
//
// Fixtures ficticias e minimas, inseridas direto nos dois bancos: a
// implementacao SQLite do ledger nunca escreve no PostgreSQL.

const test = require('node:test');
const assert = require('node:assert/strict');

const sqlite = require('../src/services/ledger');
const postgresql = require('../src/services/ledger-postgresql');
const { runMigrations } = require('../src/db/postgresql/migrator');
const { createMigratedDb } = require('./helpers/temp-db');
const { motivoSkip, schemaIsolado } = require('./helpers/postgres');

const skip = motivoSkip();

const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const INATIVADO_EM = '2026-05-01T00:00:00Z';
const MOTIVO_MOVIMENTO = 'lancamento duplicado';
const MOTIVO_ALOCACAO = 'alocacao corrigida';

/** Duas competencias, para provar rotulo e agrupamento. */
const COMPETENCIAS = [
  { rotulo: 'jan', ano: 2026, mes: 1 },
  { rotulo: 'fev', ano: 2026, mes: 2 },
];

/**
 * Cenario comum, descrito uma vez e materializado nos dois bancos na MESMA
 * ordem. Cobre: identificado, nao identificado, em_revisao, inativo, sem
 * alocacao, parcialmente alocado, integralmente alocado, alocacao inativa,
 * dois movimentos na mesma competencia e datas iguais (desempate de ordem).
 */
const MOVIMENTOS = [
  { rotulo: 'semAlocacao', data: '2026-03-01', valor: 15000, comAssociado: true, estado: 'identificado', ativo: true },
  { rotulo: 'parcial', data: '2026-01-10', valor: 20000, comAssociado: true, estado: 'identificado', ativo: true },
  // Mesma data de `parcial`: exercita o desempate por id no extrato.
  { rotulo: 'integral', data: '2026-01-10', valor: 30000, comAssociado: true, estado: 'identificado', ativo: true },
  { rotulo: 'inativo', data: '2026-02-01', valor: 5000, comAssociado: true, estado: 'identificado', ativo: false },
  { rotulo: 'naoIdentA', data: '2026-01-05', valor: 1000, comAssociado: false, estado: 'nao_identificado', ativo: true },
  // Mesma data de `naoIdentA`: desempate por id na fila.
  { rotulo: 'naoIdentB', data: '2026-01-05', valor: 2000, comAssociado: false, estado: 'nao_identificado', ativo: true },
  { rotulo: 'emRevisao', data: '2026-01-06', valor: 3000, comAssociado: false, estado: 'em_revisao', ativo: true },
  { rotulo: 'inativoSemAssociado', data: '2026-01-04', valor: 4000, comAssociado: false, estado: 'nao_identificado', ativo: false },
];

const ALOCACOES = [
  { rotulo: 'parcialJan', movimento: 'parcial', competencia: 'jan', valor: 8000, ativo: true },
  { rotulo: 'parcialFevInativa', movimento: 'parcial', competencia: 'fev', valor: 5000, ativo: false },
  // `integral` e `parcial` na MESMA competencia: continuam sendo dois movimentos.
  { rotulo: 'integralJan', movimento: 'integral', competencia: 'jan', valor: 10000, ativo: true },
  { rotulo: 'integralFev', movimento: 'integral', competencia: 'fev', valor: 20000, ativo: true },
  { rotulo: 'inativoJan', movimento: 'inativo', competencia: 'jan', valor: 5000, ativo: true },
];

function montarSqlite(t) {
  const { db } = createMigratedDb(t);
  const ids = { associado: null, competencia: new Map(), movimento: new Map(), alocacao: new Map() };

  ids.associado = Number(
    db.prepare('INSERT INTO associado (nome) VALUES (?)').run('Associado Diferencial').lastInsertRowid
  );

  for (const c of COMPETENCIAS) {
    const info = db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)').run(c.ano, c.mes);
    ids.competencia.set(c.rotulo, Number(info.lastInsertRowid));
  }

  for (const m of MOVIMENTOS) {
    const info = db
      .prepare(
        `INSERT INTO movimento_financeiro
           (data, valor_centavos, tipo, origem, associado_id, estado_identificacao,
            ativo, inativado_em, motivo_inativacao)
         VALUES (?, ?, 'credito', 'pagamento', ?, ?, ?, ?, ?)`
      )
      .run(
        m.data,
        m.valor,
        m.comAssociado ? ids.associado : null,
        m.estado,
        m.ativo ? 1 : 0,
        m.ativo ? null : INATIVADO_EM,
        m.ativo ? null : MOTIVO_MOVIMENTO
      );
    ids.movimento.set(m.rotulo, Number(info.lastInsertRowid));
  }

  for (const a of ALOCACOES) {
    const info = db
      .prepare(
        `INSERT INTO alocacao
           (movimento_id, competencia_id, valor_centavos, ativo, inativado_em, motivo_inativacao)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        ids.movimento.get(a.movimento),
        ids.competencia.get(a.competencia),
        a.valor,
        a.ativo ? 1 : 0,
        a.ativo ? null : INATIVADO_EM,
        a.ativo ? null : MOTIVO_ALOCACAO
      );
    ids.alocacao.set(a.rotulo, Number(info.lastInsertRowid));
  }

  return { db, ids };
}

async function montarPostgresql(t) {
  const { pool } = await schemaIsolado(t);
  await runMigrations(pool);
  const ids = { associado: null, competencia: new Map(), movimento: new Map(), alocacao: new Map() };

  const associado = await pool.query('INSERT INTO associado (nome) VALUES ($1) RETURNING id', [
    'Associado Diferencial',
  ]);
  ids.associado = associado.rows[0].id;

  for (const c of COMPETENCIAS) {
    const { rows } = await pool.query(
      'INSERT INTO competencia (ano, mes) VALUES ($1, $2) RETURNING id',
      [c.ano, c.mes]
    );
    ids.competencia.set(c.rotulo, rows[0].id);
  }

  for (const m of MOVIMENTOS) {
    const { rows } = await pool.query(
      `INSERT INTO movimento_financeiro
         (data, valor_centavos, tipo, origem, associado_id, estado_identificacao,
          ativo, inativado_em, motivo_inativacao)
       VALUES ($1, $2, 'credito', 'pagamento', $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        m.data,
        m.valor,
        m.comAssociado ? ids.associado : null,
        m.estado,
        m.ativo,
        m.ativo ? null : new Date(INATIVADO_EM),
        m.ativo ? null : MOTIVO_MOVIMENTO,
      ]
    );
    ids.movimento.set(m.rotulo, rows[0].id);
  }

  for (const a of ALOCACOES) {
    const { rows } = await pool.query(
      `INSERT INTO alocacao
         (movimento_id, competencia_id, valor_centavos, ativo, inativado_em, motivo_inativacao)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        ids.movimento.get(a.movimento),
        ids.competencia.get(a.competencia),
        a.valor,
        a.ativo,
        a.ativo ? null : new Date(INATIVADO_EM),
        a.ativo ? null : MOTIVO_ALOCACAO,
      ]
    );
    ids.alocacao.set(a.rotulo, rows[0].id);
  }

  return { pool, ids };
}

async function montarCenario(t) {
  const { db, ids: idsSqlite } = montarSqlite(t);
  const { pool, ids: idsPostgresql } = await montarPostgresql(t);
  return { db, pool, idsSqlite, idsPostgresql };
}

/** Rotulo estavel no lugar do id: as sequences dos dois bancos sao independentes. */
function rotuloDe(mapa, id) {
  if (id === null || id === undefined) return id;
  for (const [rotulo, valor] of mapa) if (valor === id) return rotulo;
  return `desconhecido(${id})`;
}

/** Instante: comparamos TIPO e FORMATO, nunca o valor. */
function formaDoInstante(valor) {
  if (valor === null) return null;
  return { tipo: typeof valor, formatoValido: TIMESTAMP_RE.test(valor) };
}

function normalizarAlocacao(alocacao, ids) {
  if (alocacao === null || alocacao === undefined) return alocacao;
  const base = {
    id: rotuloDe(ids.alocacao, alocacao.id),
    movimentoId: rotuloDe(ids.movimento, alocacao.movimentoId),
    competenciaId: rotuloDe(ids.competencia, alocacao.competenciaId),
    valorCentavos: alocacao.valorCentavos,
    observacao: alocacao.observacao,
    ativo: alocacao.ativo,
    criadoEm: formaDoInstante(alocacao.criadoEm),
    atualizadoEm: formaDoInstante(alocacao.atualizadoEm),
  };
  // Presentes apenas no read model do extrato (`...ComInativacao` + competencia).
  if ('inativadoEm' in alocacao) {
    base.inativadoEm = formaDoInstante(alocacao.inativadoEm);
    base.motivoInativacao = alocacao.motivoInativacao;
  }
  if ('competencia' in alocacao) {
    base.competencia = {
      id: rotuloDe(ids.competencia, alocacao.competencia.id),
      ano: alocacao.competencia.ano,
      mes: alocacao.competencia.mes,
      rotulo: alocacao.competencia.rotulo,
    };
  }
  return base;
}

function normalizarMovimento(movimento, ids) {
  if (movimento === null || movimento === undefined) return movimento;
  const base = {
    id: rotuloDe(ids.movimento, movimento.id),
    data: movimento.data,
    valorCentavos: movimento.valorCentavos,
    tipo: movimento.tipo,
    origem: movimento.origem,
    associadoId: movimento.associadoId === null ? null : 'associado',
    observacao: movimento.observacao,
    estadoIdentificacao: movimento.estadoIdentificacao,
    ativo: movimento.ativo,
    criadoEm: formaDoInstante(movimento.criadoEm),
    atualizadoEm: formaDoInstante(movimento.atualizadoEm),
  };
  if ('inativadoEm' in movimento) {
    base.inativadoEm = formaDoInstante(movimento.inativadoEm);
    base.motivoInativacao = movimento.motivoInativacao;
  }
  if ('alocacoes' in movimento) {
    base.alocacoes = movimento.alocacoes.map((a) => normalizarAlocacao(a, ids));
  }
  if ('resumo' in movimento) {
    base.resumo = normalizarResumo(movimento.resumo, ids);
  }
  return base;
}

function normalizarResumo(resumo, ids) {
  return { ...resumo, movimentoId: rotuloDe(ids.movimento, resumo.movimentoId) };
}

test('DIFERENCIAL PG-2C1: obterMovimento concorda em todos os movimentos', { skip }, async (t) => {
  const { db, pool, idsSqlite, idsPostgresql } = await montarCenario(t);

  for (const m of MOVIMENTOS) {
    const esperado = normalizarMovimento(
      sqlite.obterMovimento(db, idsSqlite.movimento.get(m.rotulo)),
      idsSqlite
    );
    const obtido = normalizarMovimento(
      await postgresql.obterMovimento(pool, idsPostgresql.movimento.get(m.rotulo)),
      idsPostgresql
    );
    assert.deepEqual(obtido, esperado, `obterMovimento divergiu em '${m.rotulo}'`);
  }

  // E o inexistente responde igual nos dois: `null`, nao erro.
  assert.equal(sqlite.obterMovimento(db, 999999), null);
  assert.equal(await postgresql.obterMovimento(pool, 999999), null);
});

test('DIFERENCIAL PG-2C1: alocacoes com e sem historico inativado', { skip }, async (t) => {
  const { db, pool, idsSqlite, idsPostgresql } = await montarCenario(t);

  for (const rotulo of ['parcial', 'integral', 'semAlocacao', 'inativo']) {
    for (const opcoes of [undefined, { incluirInativas: false }, { incluirInativas: true }]) {
      const esperado = sqlite
        .listarAlocacoesDoMovimento(db, idsSqlite.movimento.get(rotulo), opcoes)
        .map((a) => normalizarAlocacao(a, idsSqlite));
      const obtido = (
        await postgresql.listarAlocacoesDoMovimento(
          pool,
          idsPostgresql.movimento.get(rotulo),
          opcoes
        )
      ).map((a) => normalizarAlocacao(a, idsPostgresql));

      assert.deepEqual(
        obtido,
        esperado,
        `alocacoes divergiram em '${rotulo}' com ${JSON.stringify(opcoes)}`
      );
    }
  }

  // O caso que importa: a inativa aparece SO quando pedida.
  const soAtivas = await postgresql.listarAlocacoesDoMovimento(
    pool,
    idsPostgresql.movimento.get('parcial')
  );
  const todas = await postgresql.listarAlocacoesDoMovimento(
    pool,
    idsPostgresql.movimento.get('parcial'),
    { incluirInativas: true }
  );
  assert.equal(soAtivas.length, 1);
  assert.equal(todas.length, 2);
});

test('DIFERENCIAL PG-2C1: resumo do movimento', { skip }, async (t) => {
  const { db, pool, idsSqlite, idsPostgresql } = await montarCenario(t);

  for (const m of MOVIMENTOS) {
    const esperado = normalizarResumo(
      sqlite.calcularResumoDoMovimento(db, idsSqlite.movimento.get(m.rotulo)),
      idsSqlite
    );
    const obtido = normalizarResumo(
      await postgresql.calcularResumoDoMovimento(pool, idsPostgresql.movimento.get(m.rotulo)),
      idsPostgresql
    );
    assert.deepEqual(obtido, esperado, `resumo divergiu em '${m.rotulo}'`);
  }

  // O oraculo tambem precisa estar certo: a alocacao inativa de `parcial` nao soma.
  const parcial = await postgresql.calcularResumoDoMovimento(
    pool,
    idsPostgresql.movimento.get('parcial')
  );
  assert.deepEqual(parcial, {
    movimentoId: idsPostgresql.movimento.get('parcial'),
    totalCentavos: 20000,
    alocadoCentavos: 8000,
    naoAlocadoCentavos: 12000,
    quantidadeAlocacoes: 1,
    integralmenteAlocado: false,
  });

  // Movimento inexistente: mesmo erro e mesmo codigo nos dois.
  let erroSqlite;
  try {
    sqlite.calcularResumoDoMovimento(db, 999999);
  } catch (erro) {
    erroSqlite = erro;
  }
  let erroPg;
  try {
    await postgresql.calcularResumoDoMovimento(pool, 999999);
  } catch (erro) {
    erroPg = erro;
  }
  assert.equal(erroPg.name, erroSqlite.name);
  assert.equal(erroPg.codigo, erroSqlite.codigo);
  assert.equal(erroPg.codigo, 'movimento_inexistente');
});

test('DIFERENCIAL PG-2C1: fila de nao identificados, com paginacao', { skip }, async (t) => {
  const { db, pool, idsSqlite, idsPostgresql } = await montarCenario(t);

  for (const opcoes of [undefined, { limite: 1 }, { limite: 1, offset: 1 }, { limite: 50, offset: 10 }]) {
    const esperado = sqlite.listarMovimentosNaoIdentificados(db, opcoes);
    const obtido = await postgresql.listarMovimentosNaoIdentificados(pool, opcoes);

    assert.deepEqual(
      obtido.itens.map((m) => normalizarMovimento(m, idsPostgresql)),
      esperado.itens.map((m) => normalizarMovimento(m, idsSqlite)),
      `fila divergiu com ${JSON.stringify(opcoes)}`
    );
    assert.deepEqual(obtido.paginacao, esperado.paginacao, 'paginacao divergiu');
  }

  // O oraculo: so os dois elegiveis entram, em ordem cronologica com desempate.
  const { itens, paginacao } = await postgresql.listarMovimentosNaoIdentificados(pool);
  assert.deepEqual(
    itens.map((m) => rotuloDe(idsPostgresql.movimento, m.id)),
    ['naoIdentA', 'naoIdentB']
  );
  assert.equal(paginacao.total, 2, 'em_revisao e inativo ficam de fora');
});

test('DIFERENCIAL PG-2C1: extrato do associado', { skip }, async (t) => {
  const { db, pool, idsSqlite, idsPostgresql } = await montarCenario(t);

  const esperado = sqlite
    .listarMovimentosDoAssociado(db, idsSqlite.associado)
    .map((m) => normalizarMovimento(m, idsSqlite));
  const obtido = (await postgresql.listarMovimentosDoAssociado(pool, idsPostgresql.associado)).map(
    (m) => normalizarMovimento(m, idsPostgresql)
  );

  assert.deepEqual(obtido, esperado, 'extrato divergiu');

  // O oraculo: ordem data DESC/id DESC, com o inativo presente e a alocacao
  // inativa preservada dentro do movimento parcial.
  assert.deepEqual(
    obtido.map((m) => m.id),
    // data DESC: 2026-03-01, 2026-02-01, e por fim os dois de 2026-01-10, que
    // empatam na data e desempatam por id DESC (integral foi criado depois).
    ['semAlocacao', 'inativo', 'integral', 'parcial']
  );
  const parcial = obtido.find((m) => m.id === 'parcial');
  assert.deepEqual(
    parcial.alocacoes.map((a) => [a.id, a.ativo, a.competencia.rotulo]),
    [
      ['parcialJan', true, '2026-01'],
      ['parcialFevInativa', false, '2026-02'],
    ]
  );

  // Associado sem movimento: vazio nos dois.
  assert.deepEqual(sqlite.listarMovimentosDoAssociado(db, 999999), []);
  assert.deepEqual(await postgresql.listarMovimentosDoAssociado(pool, 999999), []);
});
