'use strict';

// Fase 2A - superficie HTTP minima do ledger.
// As regras financeiras sao testadas em tests/ledger.test.js; aqui so se verifica
// que as rotas delegam ao servico e traduzem erro de dominio em status HTTP.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/web/app');
const { createMigratedDb } = require('./helpers/temp-db');

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function subir(t) {
  const ctx = createMigratedDb(t);
  const { server, baseUrl } = await listen(createApp({ db: ctx.db }));
  t.after(() => close(server));
  return { ...ctx, baseUrl };
}

function postJson(baseUrl, rota, corpo) {
  return fetch(`${baseUrl}${rota}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
  });
}

test('POST /api/movimentos registra movimento em centavos e devolve o resumo', async (t) => {
  const ctx = await subir(t);
  const associadoId = Number(
    ctx.db.prepare('INSERT INTO associado (nome) VALUES (?)').run('Associado HTTP').lastInsertRowid
  );

  const response = await postJson(ctx.baseUrl, '/api/movimentos', {
    data: '2026-06-01',
    valorCentavos: 15035,
    origem: 'pagamento',
    associadoId,
  });

  assert.equal(response.status, 201);
  const { movimento } = await response.json();
  assert.equal(movimento.valorCentavos, 15035);
  assert.equal(movimento.resumo.naoAlocadoCentavos, 15035);
  assert.deepEqual(movimento.alocacoes, []);
});

test('POST /api/movimentos recusa valor decimal com 422', async (t) => {
  const ctx = await subir(t);

  const response = await postJson(ctx.baseUrl, '/api/movimentos', {
    data: '2026-06-01',
    valorCentavos: 150.35,
    origem: 'pagamento',
  });

  assert.equal(response.status, 422);
  const corpo = await response.json();
  assert.equal(corpo.status, 'erro');
  assert.equal(corpo.codigo, 'valor_nao_inteiro');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM movimento_financeiro').get().t, 0);
});

test('POST /api/movimentos/:id/alocacoes aloca e recusa excesso com 409', async (t) => {
  const ctx = await subir(t);
  const associadoId = Number(
    ctx.db.prepare('INSERT INTO associado (nome) VALUES (?)').run('Associado HTTP').lastInsertRowid
  );
  const competenciaA = Number(
    ctx.db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)').run(2026, 6).lastInsertRowid
  );
  const competenciaB = Number(
    ctx.db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)').run(2026, 7).lastInsertRowid
  );

  const criado = await (
    await postJson(ctx.baseUrl, '/api/movimentos', {
      data: '2026-06-01',
      valorCentavos: 12000,
      origem: 'pagamento',
      associadoId,
    })
  ).json();
  const movimentoId = criado.movimento.id;

  const ok = await postJson(ctx.baseUrl, `/api/movimentos/${movimentoId}/alocacoes`, {
    competenciaId: competenciaA,
    valorCentavos: 8000,
  });
  assert.equal(ok.status, 201);
  assert.equal((await ok.json()).alocacao.resumo.naoAlocadoCentavos, 4000);

  const excesso = await postJson(ctx.baseUrl, `/api/movimentos/${movimentoId}/alocacoes`, {
    competenciaId: competenciaB,
    valorCentavos: 4001,
  });
  assert.equal(excesso.status, 409);
  assert.equal((await excesso.json()).codigo, 'alocacao_excede_movimento');

  const consulta = await (await fetch(`${ctx.baseUrl}/api/movimentos/${movimentoId}`)).json();
  assert.equal(consulta.movimento.resumo.alocadoCentavos, 8000);
  assert.equal(consulta.movimento.alocacoes.length, 1);
});

test('GET /api/movimentos/:id responde 404 para movimento inexistente', async (t) => {
  const ctx = await subir(t);

  const inexistente = await fetch(`${ctx.baseUrl}/api/movimentos/987654`);
  assert.equal(inexistente.status, 404);

  const invalido = await fetch(`${ctx.baseUrl}/api/movimentos/abc`);
  assert.equal(invalido.status, 422);
  assert.equal((await invalido.json()).codigo, 'id_invalido');
});

test('T17: POST /api/movimentos/:id/identificacao identifica e devolve o estado atualizado', async (t) => {
  const ctx = await subir(t);
  const associadoId = Number(
    ctx.db.prepare('INSERT INTO associado (nome) VALUES (?)').run('Associado HTTP').lastInsertRowid
  );
  const competenciaId = Number(
    ctx.db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)').run(2026, 9).lastInsertRowid
  );

  const criado = await (
    await postJson(ctx.baseUrl, '/api/movimentos', {
      data: '2026-09-01',
      valorCentavos: 20000,
      origem: 'deposito',
    })
  ).json();
  const movimentoId = criado.movimento.id;
  assert.equal(criado.movimento.estadoIdentificacao, 'nao_identificado');

  const resposta = await postJson(ctx.baseUrl, `/api/movimentos/${movimentoId}/identificacao`, {
    associadoId,
    motivo: 'Deposito confirmado manualmente apos conferencia',
  });

  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();
  assert.equal(corpo.status, 'ok');
  assert.equal(corpo.movimento.associadoId, associadoId);
  assert.equal(corpo.movimento.estadoIdentificacao, 'identificado');
  assert.deepEqual(corpo.movimento.alocacoes, []);

  // Identificado, agora aloca pela rota que ja existia.
  const alocacao = await postJson(ctx.baseUrl, `/api/movimentos/${movimentoId}/alocacoes`, {
    competenciaId,
    valorCentavos: 4000,
  });
  assert.equal(alocacao.status, 201);
});

test('T18: identificar movimento ja identificado responde 409 sem alterar nada', async (t) => {
  const ctx = await subir(t);
  const associadoA = Number(
    ctx.db.prepare('INSERT INTO associado (nome) VALUES (?)').run('Associado A').lastInsertRowid
  );
  const associadoB = Number(
    ctx.db.prepare('INSERT INTO associado (nome) VALUES (?)').run('Associado B').lastInsertRowid
  );

  const criado = await (
    await postJson(ctx.baseUrl, '/api/movimentos', {
      data: '2026-09-01',
      valorCentavos: 20000,
      origem: 'deposito',
      associadoId: associadoA,
    })
  ).json();
  const movimentoId = criado.movimento.id;

  const resposta = await postJson(ctx.baseUrl, `/api/movimentos/${movimentoId}/identificacao`, {
    associadoId: associadoB,
    motivo: 'tentativa de troca de titular',
  });

  assert.equal(resposta.status, 409);
  assert.equal((await resposta.json()).codigo, 'movimento_ja_identificado');

  const consulta = await (await fetch(`${ctx.baseUrl}/api/movimentos/${movimentoId}`)).json();
  assert.equal(consulta.movimento.associadoId, associadoA);
});

test('identificacao sem motivo responde 422', async (t) => {
  const ctx = await subir(t);
  const associadoId = Number(
    ctx.db.prepare('INSERT INTO associado (nome) VALUES (?)').run('Associado HTTP').lastInsertRowid
  );

  const criado = await (
    await postJson(ctx.baseUrl, '/api/movimentos', {
      data: '2026-09-01',
      valorCentavos: 20000,
      origem: 'deposito',
    })
  ).json();

  const resposta = await postJson(
    ctx.baseUrl,
    `/api/movimentos/${criado.movimento.id}/identificacao`,
    { associadoId, motivo: '   ' }
  );

  assert.equal(resposta.status, 422);
  assert.equal((await resposta.json()).codigo, 'motivo_obrigatorio');
  assert.equal(
    ctx.db.prepare('SELECT associado_id FROM movimento_financeiro WHERE id = ?').get(criado.movimento.id)
      .associado_id,
    null
  );
});

// --- Fase 2C: fila de movimentos nao identificados (F-06 / F-10) ------------

/** Cria um deposito sem associado direto pelo servico HTTP e devolve o id. */
async function criarDepositoNaoIdentificado(baseUrl, data, valorCentavos = 20000) {
  const criado = await (
    await postJson(baseUrl, '/api/movimentos', { data, valorCentavos, origem: 'deposito' })
  ).json();
  return criado.movimento.id;
}

test('T14: GET /api/movimentos?estado=nao_identificado devolve itens + paginacao', async (t) => {
  const ctx = await subir(t);

  const primeiro = await criarDepositoNaoIdentificado(ctx.baseUrl, '2026-01-05', 15037);
  const segundo = await criarDepositoNaoIdentificado(ctx.baseUrl, '2026-03-01');

  // Ruido: identificado nao entra na fila.
  const associadoId = Number(
    ctx.db.prepare('INSERT INTO associado (nome) VALUES (?)').run('Associado HTTP').lastInsertRowid
  );
  const identificado = await criarDepositoNaoIdentificado(ctx.baseUrl, '2026-02-01');
  await postJson(ctx.baseUrl, `/api/movimentos/${identificado}/identificacao`, {
    associadoId,
    motivo: 'confirmado com o associado',
  });

  const resposta = await fetch(`${ctx.baseUrl}/api/movimentos?estado=nao_identificado`);
  assert.equal(resposta.status, 200);

  const corpo = await resposta.json();
  assert.equal(corpo.status, 'ok');
  assert.deepEqual(
    corpo.itens.map((item) => item.id),
    [primeiro, segundo]
  );
  assert.deepEqual(corpo.paginacao, { limite: 50, offset: 0, total: 2 });

  const item = corpo.itens[0];
  assert.equal(item.valorCentavos, 15037, 'valor continua em centavos inteiros');
  assert.equal(item.estadoIdentificacao, 'nao_identificado');
  assert.equal(item.associadoId, null);
  for (const campo of ['id', 'data', 'tipo', 'origem', 'observacao', 'criadoEm', 'atualizadoEm']) {
    assert.ok(campo in item, `o item da fila deve expor ${campo}`);
  }
});

test('T14b: limite e offset da query paginam a fila', async (t) => {
  const ctx = await subir(t);

  const ids = [];
  for (const dia of ['01', '02', '03']) {
    ids.push(await criarDepositoNaoIdentificado(ctx.baseUrl, `2026-01-${dia}`));
  }

  const pagina = await (
    await fetch(`${ctx.baseUrl}/api/movimentos?estado=nao_identificado&limite=2&offset=1`)
  ).json();

  assert.deepEqual(
    pagina.itens.map((item) => item.id),
    ids.slice(1)
  );
  assert.deepEqual(pagina.paginacao, { limite: 2, offset: 1, total: 3 });

  const alemDoFim = await (
    await fetch(`${ctx.baseUrl}/api/movimentos?estado=nao_identificado&limite=2&offset=99`)
  ).json();
  assert.deepEqual(alemDoFim.itens, []);
  assert.equal(alemDoFim.paginacao.total, 3);
});

test('T15: paginacao invalida na query responde 422', async (t) => {
  const ctx = await subir(t);
  await criarDepositoNaoIdentificado(ctx.baseUrl, '2026-01-05');

  for (const query of ['limite=0', 'limite=201', 'limite=abc', 'limite=1.5', 'offset=-1', 'offset=x']) {
    const resposta = await fetch(`${ctx.baseUrl}/api/movimentos?estado=nao_identificado&${query}`);
    assert.equal(resposta.status, 422, `esperava 422 para ${query}`);
    assert.equal((await resposta.json()).codigo, 'paginacao_invalida', `codigo estavel para ${query}`);
  }
});

test('T16: estado nao suportado nao e reinterpretado como a fila', async (t) => {
  const ctx = await subir(t);

  const elegivel = await criarDepositoNaoIdentificado(ctx.baseUrl, '2026-01-05');
  const emRevisao = await criarDepositoNaoIdentificado(ctx.baseUrl, '2026-01-06');
  ctx.db
    .prepare("UPDATE movimento_financeiro SET estado_identificacao = 'em_revisao' WHERE id = ?")
    .run(emRevisao);

  for (const query of ['', '?estado=', '?estado=em_revisao', '?estado=identificado', '?estado=todos']) {
    const resposta = await fetch(`${ctx.baseUrl}/api/movimentos${query}`);
    assert.equal(resposta.status, 422, `esperava 422 para "${query}"`);
    assert.equal((await resposta.json()).codigo, 'estado_nao_suportado');
  }

  // A fila suportada continua servindo apenas os realmente nao identificados.
  const fila = await (await fetch(`${ctx.baseUrl}/api/movimentos?estado=nao_identificado`)).json();
  assert.deepEqual(
    fila.itens.map((item) => item.id),
    [elegivel]
  );
  assert.equal(
    ctx.db.prepare('SELECT estado_identificacao FROM movimento_financeiro WHERE id = ?').get(emRevisao)
      .estado_identificacao,
    'em_revisao'
  );
});

test('T16b: a consulta HTTP nao altera dado nem gera auditoria', async (t) => {
  const ctx = await subir(t);

  await criarDepositoNaoIdentificado(ctx.baseUrl, '2026-01-05');
  await criarDepositoNaoIdentificado(ctx.baseUrl, '2026-01-06');

  const movimentosAntes = ctx.db.prepare('SELECT * FROM movimento_financeiro ORDER BY id').all();
  const auditoriaAntes = ctx.db.prepare('SELECT COUNT(*) AS t FROM audit_log').get().t;

  await fetch(`${ctx.baseUrl}/api/movimentos?estado=nao_identificado`);
  await fetch(`${ctx.baseUrl}/api/movimentos?estado=nao_identificado&limite=1&offset=1`);
  await fetch(`${ctx.baseUrl}/api/movimentos?estado=em_revisao`);

  assert.deepEqual(
    ctx.db.prepare('SELECT * FROM movimento_financeiro ORDER BY id').all(),
    movimentosAntes
  );
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM audit_log').get().t, auditoriaAntes);
});

// --- Fase 3C: inativacao auditavel por HTTP (M-09 / F-11) -------------------

/** Cenario base: movimento identificado + uma alocacao ativa, tudo por HTTP. */
async function cenarioComAlocacao(ctx, { valorCentavos = 8000, alocado = 8000 } = {}) {
  const associadoId = Number(
    ctx.db.prepare('INSERT INTO associado (nome) VALUES (?)').run('Associado HTTP').lastInsertRowid
  );
  const competenciaId = Number(
    ctx.db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)').run(2026, 4).lastInsertRowid
  );

  const criado = await (
    await postJson(ctx.baseUrl, '/api/movimentos', {
      data: '2026-04-10',
      valorCentavos,
      origem: 'pagamento',
      associadoId,
    })
  ).json();

  const alocacao = await (
    await postJson(ctx.baseUrl, `/api/movimentos/${criado.movimento.id}/alocacoes`, {
      competenciaId,
      valorCentavos: alocado,
    })
  ).json();

  return { movimentoId: criado.movimento.id, alocacaoId: alocacao.alocacao.id, competenciaId };
}

function contarAuditoria(db, acao) {
  return db.prepare('SELECT COUNT(*) AS t FROM audit_log WHERE acao = ?').get(acao).t;
}

test('I25: POST /api/movimentos/:id/inativacao responde 200 e devolve o estado inativado', async (t) => {
  const ctx = await subir(t);

  const criado = await (
    await postJson(ctx.baseUrl, '/api/movimentos', {
      data: '2026-04-10',
      valorCentavos: 15035,
      origem: 'deposito',
    })
  ).json();
  const movimentoId = criado.movimento.id;

  const resposta = await postJson(ctx.baseUrl, `/api/movimentos/${movimentoId}/inativacao`, {
    motivo: 'lancamento duplicado',
    ator: 'operador',
  });

  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();
  assert.equal(corpo.status, 'ok');
  assert.equal(corpo.movimento.ativo, false);
  assert.equal(corpo.movimento.motivoInativacao, 'lancamento duplicado');
  assert.match(corpo.movimento.inativadoEm, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(corpo.movimento.valorCentavos, 15035, 'o valor nao muda ao inativar');

  const linha = ctx.db.prepare('SELECT ativo FROM movimento_financeiro WHERE id = ?').get(movimentoId);
  assert.equal(linha.ativo, 0);
  assert.equal(contarAuditoria(ctx.db, 'movimento_financeiro.inativado'), 1);
  assert.equal(
    ctx.db.prepare('SELECT ator FROM audit_log ORDER BY id DESC').get().ator,
    'operador',
    'o ator informado pelo transporte chega a auditoria'
  );
});

test('I26: inativacao de movimento com id invalido ou motivo vazio responde 422', async (t) => {
  const ctx = await subir(t);

  const criado = await (
    await postJson(ctx.baseUrl, '/api/movimentos', {
      data: '2026-04-10',
      valorCentavos: 8000,
      origem: 'deposito',
    })
  ).json();

  const idInvalido = await postJson(ctx.baseUrl, '/api/movimentos/abc/inativacao', {
    motivo: 'lancamento duplicado',
  });
  assert.equal(idInvalido.status, 422);
  assert.equal((await idInvalido.json()).codigo, 'id_invalido');

  const semMotivo = await postJson(
    ctx.baseUrl,
    `/api/movimentos/${criado.movimento.id}/inativacao`,
    { motivo: '   ' }
  );
  assert.equal(semMotivo.status, 422);
  assert.equal((await semMotivo.json()).codigo, 'motivo_obrigatorio');

  assert.equal(
    ctx.db.prepare('SELECT ativo FROM movimento_financeiro WHERE id = ?').get(criado.movimento.id).ativo,
    1,
    'recusa nao pode alterar o movimento'
  );
  assert.equal(contarAuditoria(ctx.db, 'movimento_financeiro.inativado'), 0);
});

test('I27: inativacao de movimento inexistente responde 404 e ja inativo responde 409', async (t) => {
  const ctx = await subir(t);

  const inexistente = await postJson(ctx.baseUrl, '/api/movimentos/987654/inativacao', {
    motivo: 'lancamento duplicado',
  });
  assert.equal(inexistente.status, 404);
  assert.equal((await inexistente.json()).codigo, 'movimento_inexistente');

  const criado = await (
    await postJson(ctx.baseUrl, '/api/movimentos', {
      data: '2026-04-10',
      valorCentavos: 8000,
      origem: 'deposito',
    })
  ).json();
  const rota = `/api/movimentos/${criado.movimento.id}/inativacao`;

  assert.equal((await postJson(ctx.baseUrl, rota, { motivo: 'lancamento duplicado' })).status, 200);

  const repetida = await postJson(ctx.baseUrl, rota, { motivo: 'tentativa repetida' });
  assert.equal(repetida.status, 409);
  assert.equal((await repetida.json()).codigo, 'movimento_inativo');

  assert.equal(
    ctx.db
      .prepare('SELECT motivo_inativacao FROM movimento_financeiro WHERE id = ?')
      .get(criado.movimento.id).motivo_inativacao,
    'lancamento duplicado',
    'o motivo original permanece'
  );
  assert.equal(contarAuditoria(ctx.db, 'movimento_financeiro.inativado'), 1);
});

test('I28: movimento com alocacao ativa responde 409 e so e inativado apos a alocacao', async (t) => {
  const ctx = await subir(t);

  const { movimentoId, alocacaoId } = await cenarioComAlocacao(ctx);
  const rota = `/api/movimentos/${movimentoId}/inativacao`;

  const recusa = await postJson(ctx.baseUrl, rota, { motivo: 'lancamento duplicado' });
  assert.equal(recusa.status, 409);
  assert.equal((await recusa.json()).codigo, 'movimento_possui_alocacoes_ativas');

  assert.equal(
    ctx.db.prepare('SELECT ativo FROM movimento_financeiro WHERE id = ?').get(movimentoId).ativo,
    1
  );
  assert.equal(ctx.db.prepare('SELECT ativo FROM alocacao WHERE id = ?').get(alocacaoId).ativo, 1);
  assert.equal(contarAuditoria(ctx.db, 'movimento_financeiro.inativado'), 0);

  // Ordem suportada: alocacao primeiro, com o proprio motivo; movimento depois.
  const alocacao = await postJson(ctx.baseUrl, `/api/alocacoes/${alocacaoId}/inativacao`, {
    motivo: 'competencia incorreta',
  });
  assert.equal(alocacao.status, 200);
  assert.equal((await postJson(ctx.baseUrl, rota, { motivo: 'lancamento duplicado' })).status, 200);
});

test('I29: POST /api/alocacoes/:id/inativacao responde 200 e refaz o resumo do movimento', async (t) => {
  const ctx = await subir(t);

  const { movimentoId, alocacaoId } = await cenarioComAlocacao(ctx, { valorCentavos: 12000, alocado: 5000 });

  const resposta = await postJson(ctx.baseUrl, `/api/alocacoes/${alocacaoId}/inativacao`, {
    motivo: 'competencia incorreta',
    ator: 'operador',
  });

  assert.equal(resposta.status, 200);
  const corpo = await resposta.json();
  assert.equal(corpo.status, 'ok');
  assert.equal(corpo.alocacao.ativo, false);
  assert.equal(corpo.alocacao.motivoInativacao, 'competencia incorreta');
  assert.match(corpo.alocacao.inativadoEm, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(corpo.alocacao.valorCentavos, 5000, 'o valor alocado nao e reescrito');
  assert.equal(corpo.alocacao.resumo.alocadoCentavos, 0);
  assert.equal(corpo.alocacao.resumo.naoAlocadoCentavos, 12000);

  // A linha continua no banco e o movimento nao foi tocado.
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM alocacao WHERE id = ?').get(alocacaoId).t, 1);
  assert.equal(
    ctx.db.prepare('SELECT ativo FROM movimento_financeiro WHERE id = ?').get(movimentoId).ativo,
    1
  );
  assert.equal(contarAuditoria(ctx.db, 'alocacao.inativada'), 1);
});

test('I30: inativacao de alocacao com id invalido ou motivo vazio responde 422', async (t) => {
  const ctx = await subir(t);

  const { alocacaoId } = await cenarioComAlocacao(ctx);

  const idInvalido = await postJson(ctx.baseUrl, '/api/alocacoes/abc/inativacao', {
    motivo: 'competencia incorreta',
  });
  assert.equal(idInvalido.status, 422);
  assert.equal((await idInvalido.json()).codigo, 'id_invalido');

  const semMotivo = await postJson(ctx.baseUrl, `/api/alocacoes/${alocacaoId}/inativacao`, {
    motivo: '',
  });
  assert.equal(semMotivo.status, 422);
  assert.equal((await semMotivo.json()).codigo, 'motivo_obrigatorio');

  assert.equal(ctx.db.prepare('SELECT ativo FROM alocacao WHERE id = ?').get(alocacaoId).ativo, 1);
  assert.equal(contarAuditoria(ctx.db, 'alocacao.inativada'), 0);
});

test('I31: alocacao inexistente responde 404 e alocacao ja inativa responde 409', async (t) => {
  const ctx = await subir(t);

  const inexistente = await postJson(ctx.baseUrl, '/api/alocacoes/987654/inativacao', {
    motivo: 'competencia incorreta',
  });
  assert.equal(inexistente.status, 404);
  assert.equal((await inexistente.json()).codigo, 'alocacao_inexistente');

  const { alocacaoId } = await cenarioComAlocacao(ctx);
  const rota = `/api/alocacoes/${alocacaoId}/inativacao`;

  assert.equal((await postJson(ctx.baseUrl, rota, { motivo: 'competencia incorreta' })).status, 200);

  const repetida = await postJson(ctx.baseUrl, rota, { motivo: 'segunda tentativa' });
  assert.equal(repetida.status, 409);
  assert.equal((await repetida.json()).codigo, 'alocacao_inativa');

  assert.equal(
    ctx.db.prepare('SELECT motivo_inativacao FROM alocacao WHERE id = ?').get(alocacaoId)
      .motivo_inativacao,
    'competencia incorreta'
  );
  assert.equal(contarAuditoria(ctx.db, 'alocacao.inativada'), 1);
});

test('I32: a resposta de erro nao vaza SQL, stack nem caminho local', async (t) => {
  const ctx = await subir(t);

  const respostas = await Promise.all([
    postJson(ctx.baseUrl, '/api/movimentos/987654/inativacao', { motivo: 'x' }),
    postJson(ctx.baseUrl, '/api/alocacoes/987654/inativacao', { motivo: 'x' }),
    postJson(ctx.baseUrl, '/api/alocacoes/abc/inativacao', { motivo: 'x' }),
  ]);

  for (const resposta of respostas) {
    const corpo = await resposta.json();
    assert.deepEqual(Object.keys(corpo).sort(), ['codigo', 'erro', 'status']);
    const texto = JSON.stringify(corpo);
    for (const vazamento of ['SELECT', 'UPDATE', 'INSERT', 'sqlite', 'D:\\', '/src/', 'at Object']) {
      assert.equal(texto.includes(vazamento), false, `resposta nao pode conter "${vazamento}"`);
    }
  }
});

test('deposito nao identificado e criado por HTTP e recusa alocacao com 409', async (t) => {
  const ctx = await subir(t);
  const competenciaId = Number(
    ctx.db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)').run(2026, 8).lastInsertRowid
  );

  const criado = await (
    await postJson(ctx.baseUrl, '/api/movimentos', {
      data: '2026-08-01',
      valorCentavos: 20000,
      origem: 'deposito',
    })
  ).json();

  assert.equal(criado.movimento.estadoIdentificacao, 'nao_identificado');
  assert.equal(criado.movimento.associadoId, null);

  const recusa = await postJson(ctx.baseUrl, `/api/movimentos/${criado.movimento.id}/alocacoes`, {
    competenciaId,
    valorCentavos: 4000,
  });

  assert.equal(recusa.status, 409);
  assert.equal((await recusa.json()).codigo, 'movimento_nao_identificado');
});

// --- Fase 3D: POST /api/ajustes ---------------------------------------------
// A rota e FINA: as regras estao em tests/ledger-ajustes.test.js. Aqui so se
// verifica que ela delega ao servico e traduz erro de dominio em status HTTP.

function criarAssociadoHttp(db, rotulo = 'Associado Ajuste') {
  return Number(db.prepare('INSERT INTO associado (nome) VALUES (?)').run(rotulo).lastInsertRowid);
}

test('POST /api/ajustes cria credito com 201 e devolve o ajuste', async (t) => {
  const ctx = await subir(t);
  const associadoId = criarAssociadoHttp(ctx.db);
  const competenciaId = Number(
    ctx.db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)').run(2026, 8).lastInsertRowid
  );

  const response = await postJson(ctx.baseUrl, '/api/ajustes', {
    associadoId,
    tipo: 'credito',
    valorCentavos: 4000,
    motivo: 'ajuste aprovado pela administracao',
    data: '2026-08-16',
    competenciaId,
    observacao: 'referencia interna',
    ator: 'operador',
  });

  assert.equal(response.status, 201);
  const corpo = await response.json();
  assert.equal(corpo.status, 'ok');
  assert.equal(corpo.ajuste.tipo, 'credito');
  assert.equal(corpo.ajuste.valorCentavos, 4000);
  assert.equal(corpo.ajuste.competenciaId, competenciaId);
  assert.equal(corpo.ajuste.observacao, 'referencia interna');
  assert.equal(corpo.ajuste.ativo, true);

  // Nenhum agregado atravessa a rota: sem saldo, sem adimplencia.
  for (const proibido of ['saldo', 'resumo', 'adimplencia', 'totalDevido', 'creditoDisponivel']) {
    assert.equal(proibido in corpo.ajuste, false, `resposta nao pode conter '${proibido}'`);
  }

  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM ajuste_credito_debito').get().t, 1);
  assert.equal(
    ctx.db
      .prepare("SELECT COUNT(*) AS t FROM audit_log WHERE entidade_tipo = 'ajuste_credito_debito'")
      .get().t,
    1
  );
});

test('POST /api/ajustes cria debito com 201, sem competencia', async (t) => {
  const ctx = await subir(t);
  const associadoId = criarAssociadoHttp(ctx.db);

  const response = await postJson(ctx.baseUrl, '/api/ajustes', {
    associadoId,
    tipo: 'debito',
    valorCentavos: 2500,
    motivo: 'correcao financeira aprovada',
    data: '2026-08-16',
  });

  assert.equal(response.status, 201);
  const { ajuste } = await response.json();
  assert.equal(ajuste.tipo, 'debito');
  assert.equal(ajuste.valorCentavos, 2500);
  assert.equal(ajuste.competenciaId, null);
  // Competencia ausente NAO faz a rota criar uma.
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM competencia').get().t, 0);
});

test('POST /api/ajustes recusa entrada invalida com 422 e nao grava nada', async (t) => {
  const ctx = await subir(t);
  const associadoId = criarAssociadoHttp(ctx.db);
  const base = {
    associadoId,
    tipo: 'credito',
    valorCentavos: 4000,
    motivo: 'motivo valido',
    data: '2026-08-16',
  };

  const casos = [
    ['tipo invalido', { ...base, tipo: 'entrada' }, 'tipo_ajuste_invalido'],
    ['tipo acentuado', { ...base, tipo: 'cr\u00e9dito' }, 'tipo_ajuste_invalido'],
    ['valor decimal', { ...base, valorCentavos: 150.35 }, 'valor_nao_inteiro'],
    ['valor string', { ...base, valorCentavos: '4000' }, 'valor_nao_inteiro'],
    ['valor zero', { ...base, valorCentavos: 0 }, 'valor_nao_positivo'],
    ['valor negativo', { ...base, valorCentavos: -100 }, 'valor_nao_positivo'],
    ['motivo vazio', { ...base, motivo: '   ' }, 'motivo_obrigatorio'],
    ['data invalida', { ...base, data: '2026-02-30' }, 'data_invalida'],
    ['associadoId ausente', { ...base, associadoId: undefined }, 'id_invalido'],
    ['associadoId string', { ...base, associadoId: '1' }, 'id_invalido'],
    ['competenciaId invalido', { ...base, competenciaId: '2026-04' }, 'id_invalido'],
  ];

  for (const [rotulo, corpo, codigo] of casos) {
    const response = await postJson(ctx.baseUrl, '/api/ajustes', corpo);
    assert.equal(response.status, 422, `${rotulo} deveria responder 422`);
    const json = await response.json();
    assert.equal(json.status, 'erro');
    assert.equal(json.codigo, codigo, `${rotulo} deveria devolver codigo ${codigo}`);
  }

  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM ajuste_credito_debito').get().t, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM audit_log').get().t, 0);
});

test('POST /api/ajustes responde 404 para associado e competencia inexistentes', async (t) => {
  const ctx = await subir(t);
  const associadoId = criarAssociadoHttp(ctx.db);
  const base = {
    tipo: 'credito',
    valorCentavos: 4000,
    motivo: 'motivo valido',
    data: '2026-08-16',
  };

  const semAssociado = await postJson(ctx.baseUrl, '/api/ajustes', { ...base, associadoId: 987654 });
  assert.equal(semAssociado.status, 404);
  assert.equal((await semAssociado.json()).codigo, 'associado_inexistente');

  const semCompetencia = await postJson(ctx.baseUrl, '/api/ajustes', {
    ...base,
    associadoId,
    competenciaId: 987654,
  });
  assert.equal(semCompetencia.status, 404);
  assert.equal((await semCompetencia.json()).codigo, 'competencia_inexistente');

  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM ajuste_credito_debito').get().t, 0);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM competencia').get().t, 0);
});

test('POST /api/ajustes: erro mantem o formato e nao vaza SQL, stack ou caminho', async (t) => {
  const ctx = await subir(t);
  const injecao = "'); DROP TABLE ajuste_credito_debito; --";

  const respostas = await Promise.all([
    postJson(ctx.baseUrl, '/api/ajustes', {}),
    postJson(ctx.baseUrl, '/api/ajustes', {
      associadoId: 987654,
      tipo: 'credito',
      valorCentavos: 1,
      motivo: 'x',
      data: '2026-08-16',
    }),
    postJson(ctx.baseUrl, '/api/ajustes', {
      associadoId: 1,
      tipo: injecao,
      valorCentavos: 1,
      motivo: 'x',
      data: '2026-08-16',
    }),
  ]);

  for (const resposta of respostas) {
    const corpo = await resposta.json();
    assert.deepEqual(Object.keys(corpo).sort(), ['codigo', 'erro', 'status']);
    const texto = JSON.stringify(corpo);
    for (const vazamento of ['SELECT', 'UPDATE', 'sqlite', 'D:\\', '/src/', 'at Object']) {
      assert.equal(texto.includes(vazamento), false, `resposta nao pode conter "${vazamento}"`);
    }
  }

  // A tabela continua de pe: o texto malicioso foi tratado como dado.
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM ajuste_credito_debito').get().t, 0);
});

test('POST /api/ajustes nao altera movimentos nem alocacoes ja existentes', async (t) => {
  const ctx = await subir(t);
  const associadoId = criarAssociadoHttp(ctx.db);
  const competenciaId = Number(
    ctx.db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)').run(2026, 8).lastInsertRowid
  );

  const criado = await (
    await postJson(ctx.baseUrl, '/api/movimentos', {
      data: '2026-08-01',
      valorCentavos: 20000,
      origem: 'pagamento',
      associadoId,
      alocacoes: [{ competenciaId, valorCentavos: 20000 }],
    })
  ).json();
  assert.equal(criado.movimento.resumo.integralmenteAlocado, true);

  const movimentosAntes = ctx.db.prepare('SELECT * FROM movimento_financeiro ORDER BY id').all();
  const alocacoesAntes = ctx.db.prepare('SELECT * FROM alocacao ORDER BY id').all();

  const ajuste = await postJson(ctx.baseUrl, '/api/ajustes', {
    associadoId,
    tipo: 'debito',
    valorCentavos: 20000,
    motivo: 'ajuste que NAO pode mexer no movimento',
    data: '2026-08-16',
    competenciaId,
  });
  assert.equal(ajuste.status, 201);

  assert.deepEqual(
    ctx.db.prepare('SELECT * FROM movimento_financeiro ORDER BY id').all(),
    movimentosAntes
  );
  assert.deepEqual(ctx.db.prepare('SELECT * FROM alocacao ORDER BY id').all(), alocacoesAntes);

  // O movimento continua integralmente alocado: o debito nao compensou nada.
  const depois = await (await fetch(`${ctx.baseUrl}/api/movimentos/${criado.movimento.id}`)).json();
  assert.deepEqual(depois.movimento.resumo, criado.movimento.resumo);
});

// --- Fase 3E: POST /api/ajustes/:id/inativacao -------------------------------
// Rota fina: as regras estao em tests/ledger-ajustes.test.js. Aqui so se verifica
// delegacao ao servico e traducao de erro de dominio em status HTTP.

/** Cria um ajuste ativo pela propria API, para os cenarios de correcao. */
async function criarAjusteHttp(ctx, extra = {}) {
  const associadoId = criarAssociadoHttp(ctx.db, 'Associado Inativacao');
  const response = await postJson(ctx.baseUrl, '/api/ajustes', {
    associadoId,
    tipo: 'debito',
    valorCentavos: 2500,
    motivo: 'correcao financeira aprovada',
    data: '2026-08-16',
    ...extra,
  });
  assert.equal(response.status, 201);
  return (await response.json()).ajuste;
}

test('H1: POST /api/ajustes/:id/inativacao inativa com 200 e preserva os dados', async (t) => {
  const ctx = await subir(t);
  const ajuste = await criarAjusteHttp(ctx);

  const response = await postJson(ctx.baseUrl, `/api/ajustes/${ajuste.id}/inativacao`, {
    motivo: 'lancamento duplicado',
    ator: 'operador',
  });

  assert.equal(response.status, 200);
  const corpo = await response.json();
  assert.equal(corpo.status, 'ok');
  assert.equal(corpo.ajuste.ativo, false);
  assert.equal(corpo.ajuste.motivoInativacao, 'lancamento duplicado');
  assert.match(corpo.ajuste.inativadoEm, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  // Dados economicos originais intactos; o motivo original nao foi sobrescrito.
  assert.equal(corpo.ajuste.tipo, 'debito');
  assert.equal(corpo.ajuste.valorCentavos, 2500);
  assert.equal(corpo.ajuste.motivo, 'correcao financeira aprovada');
  assert.equal(corpo.ajuste.associadoId, ajuste.associadoId);
  assert.equal(corpo.ajuste.criadoEm, ajuste.criadoEm);

  // Sem exclusao fisica: a linha continua no banco.
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM ajuste_credito_debito').get().t, 1);
});

test('H2: ajuste inexistente responde 404', async (t) => {
  const ctx = await subir(t);

  const response = await postJson(ctx.baseUrl, '/api/ajustes/987654/inativacao', {
    motivo: 'motivo valido',
  });

  assert.equal(response.status, 404);
  assert.equal((await response.json()).codigo, 'ajuste_inexistente');
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM audit_log').get().t, 0);
});

test('H3: segunda inativacao responde 409 sem alterar o historico', async (t) => {
  const ctx = await subir(t);
  const ajuste = await criarAjusteHttp(ctx);

  const primeira = await postJson(ctx.baseUrl, `/api/ajustes/${ajuste.id}/inativacao`, {
    motivo: 'lancamento duplicado',
  });
  assert.equal(primeira.status, 200);

  const linhaDepoisDaPrimeira = ctx.db
    .prepare('SELECT * FROM ajuste_credito_debito WHERE id = ?')
    .get(ajuste.id);
  const auditoriaDepoisDaPrimeira = ctx.db.prepare('SELECT COUNT(*) AS t FROM audit_log').get().t;

  const segunda = await postJson(ctx.baseUrl, `/api/ajustes/${ajuste.id}/inativacao`, {
    motivo: 'outro motivo qualquer',
  });

  assert.equal(segunda.status, 409);
  assert.equal((await segunda.json()).codigo, 'ajuste_inativo');
  assert.deepEqual(
    ctx.db.prepare('SELECT * FROM ajuste_credito_debito WHERE id = ?').get(ajuste.id),
    linhaDepoisDaPrimeira
  );
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM audit_log').get().t, auditoriaDepoisDaPrimeira);
});

test('H4/H5: motivo vazio e id invalido respondem 422 e o ajuste continua ativo', async (t) => {
  const ctx = await subir(t);
  const ajuste = await criarAjusteHttp(ctx);

  const casos = [
    ['motivo ausente', `/api/ajustes/${ajuste.id}/inativacao`, {}, 'motivo_obrigatorio'],
    ['motivo vazio', `/api/ajustes/${ajuste.id}/inativacao`, { motivo: '   ' }, 'motivo_obrigatorio'],
    ['id nao numerico', '/api/ajustes/abc/inativacao', { motivo: 'x' }, 'id_invalido'],
    ['id zero', '/api/ajustes/0/inativacao', { motivo: 'x' }, 'id_invalido'],
    ['id decimal', '/api/ajustes/1.5/inativacao', { motivo: 'x' }, 'id_invalido'],
  ];

  for (const [rotulo, rota, corpo, codigo] of casos) {
    const response = await postJson(ctx.baseUrl, rota, corpo);
    assert.equal(response.status, 422, `${rotulo} deveria responder 422`);
    const json = await response.json();
    assert.equal(json.status, 'erro');
    assert.equal(json.codigo, codigo, `${rotulo} deveria devolver codigo ${codigo}`);
  }

  const linha = ctx.db.prepare('SELECT * FROM ajuste_credito_debito WHERE id = ?').get(ajuste.id);
  assert.equal(linha.ativo, 1);
  assert.equal(linha.inativado_em, null);
  assert.equal(linha.motivo_inativacao, null);
});

test('H6: erro da inativacao de ajuste nao vaza SQL, stack, internals ou caminho', async (t) => {
  const ctx = await subir(t);

  const respostas = await Promise.all([
    postJson(ctx.baseUrl, '/api/ajustes/987654/inativacao', { motivo: 'x' }),
    postJson(ctx.baseUrl, '/api/ajustes/abc/inativacao', { motivo: 'x' }),
    postJson(ctx.baseUrl, '/api/ajustes/1/inativacao', {}),
    postJson(ctx.baseUrl, '/api/ajustes/1/inativacao', {
      motivo: "'); DROP TABLE ajuste_credito_debito; --",
    }),
  ]);

  for (const resposta of respostas) {
    const corpo = await resposta.json();
    assert.deepEqual(Object.keys(corpo).sort(), ['codigo', 'erro', 'status']);
    const texto = JSON.stringify(corpo);
    for (const vazamento of ['SELECT', 'UPDATE', 'sqlite', 'D:\\', '/src/', 'at Object']) {
      assert.equal(texto.includes(vazamento), false, `resposta nao pode conter "${vazamento}"`);
    }
  }
});

test('H7: a rota produz auditoria completa e nao toca movimentos nem alocacoes', async (t) => {
  const ctx = await subir(t);
  const associadoId = criarAssociadoHttp(ctx.db, 'Associado Regressao 3E');
  const competenciaId = Number(
    ctx.db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)').run(2026, 8).lastInsertRowid
  );

  const movimento = await (
    await postJson(ctx.baseUrl, '/api/movimentos', {
      data: '2026-08-01',
      valorCentavos: 20000,
      origem: 'pagamento',
      associadoId,
      alocacoes: [{ competenciaId, valorCentavos: 20000 }],
    })
  ).json();

  const ajuste = await (
    await postJson(ctx.baseUrl, '/api/ajustes', {
      associadoId,
      tipo: 'credito',
      valorCentavos: 4000,
      motivo: 'ajuste a corrigir',
      data: '2026-08-16',
      competenciaId,
    })
  ).json();

  const movimentosAntes = ctx.db.prepare('SELECT * FROM movimento_financeiro ORDER BY id').all();
  const alocacoesAntes = ctx.db.prepare('SELECT * FROM alocacao ORDER BY id').all();

  const response = await postJson(ctx.baseUrl, `/api/ajustes/${ajuste.ajuste.id}/inativacao`, {
    motivo: 'ajuste lancado na competencia errada',
    ator: 'operador',
  });
  assert.equal(response.status, 200);

  // Auditoria da inativacao, com estado anterior e posterior.
  const linha = ctx.db
    .prepare("SELECT * FROM audit_log WHERE acao = 'ajuste_credito_debito.inativado'")
    .get();
  assert.ok(linha, 'a rota precisa produzir auditoria de inativacao');
  assert.equal(linha.entidade_tipo, 'ajuste_credito_debito');
  assert.equal(linha.entidade_id, String(ajuste.ajuste.id));
  assert.equal(linha.ator, 'operador');
  assert.equal(JSON.parse(linha.estado_anterior).ativo, true);
  assert.equal(JSON.parse(linha.estado_posterior).ativo, false);
  assert.equal(JSON.parse(linha.estado_posterior).valorCentavos, 4000);

  // Regressao: movimento e alocacao intactos, nenhum ajuste oposto criado.
  assert.deepEqual(
    ctx.db.prepare('SELECT * FROM movimento_financeiro ORDER BY id').all(),
    movimentosAntes
  );
  assert.deepEqual(ctx.db.prepare('SELECT * FROM alocacao ORDER BY id').all(), alocacoesAntes);
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS t FROM ajuste_credito_debito').get().t, 1);

  const movimentoDepois = await (
    await fetch(`${ctx.baseUrl}/api/movimentos/${movimento.movimento.id}`)
  ).json();
  assert.deepEqual(movimentoDepois.movimento.resumo, movimento.movimento.resumo);
});
