'use strict';

// Fase 3A - superficie HTML de associados.
// Aqui se verifica transporte e RENDERIZACAO: status, content-type, escaping e
// ausencia de qualquer inferencia financeira no HTML entregue ao navegador.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createApp } = require('../src/web/app');
const { inativarMovimento, inativarAlocacao } = require('../src/services/ledger');
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

function inserir(db, { legacyId = null, nome, legacyStatusCode = null, observacoes = null }) {
  return Number(
    db
      .prepare(
        'INSERT INTO associado (legacy_id, nome, legacy_status_code, observacoes) VALUES (?, ?, ?, ?)'
      )
      .run(legacyId, nome, legacyStatusCode, observacoes).lastInsertRowid
  );
}

async function obterHtml(baseUrl, rota) {
  const response = await fetch(`${baseUrl}${rota}`);
  return { response, html: await response.text() };
}

// --- helpers do ledger individual (Fase 3B) ----------------------------------

function inserirMovimento(db, { data, valorCentavos, associadoId = null, observacao = null, origem = 'pagamento' }) {
  return Number(
    db
      .prepare(
        `INSERT INTO movimento_financeiro
           (data, valor_centavos, tipo, origem, associado_id, observacao, estado_identificacao)
         VALUES (?, ?, 'credito', ?, ?, ?, ?)`
      )
      .run(data, valorCentavos, origem, associadoId, observacao, associadoId === null ? 'nao_identificado' : 'identificado')
      .lastInsertRowid
  );
}

function inserirCompetencia(db, ano, mes) {
  return Number(db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)').run(ano, mes).lastInsertRowid);
}

function inserirAlocacao(db, movimentoId, competenciaId, valorCentavos) {
  db.prepare('INSERT INTO alocacao (movimento_id, competencia_id, valor_centavos) VALUES (?, ?, ?)').run(
    movimentoId,
    competenciaId,
    valorCentavos
  );
}

/** Quantas vezes um texto aparece no HTML — usado para provar nao duplicacao. */
function ocorrencias(html, texto) {
  return html.split(texto).length - 1;
}

// --- H1 / H2 / H3: listagem ---------------------------------------------------

test('H1: GET /associados responde 200 text/html', async (t) => {
  const ctx = await subir(t);
  inserir(ctx.db, { legacyId: '1', nome: 'Ana Lima' });

  const { response, html } = await obterHtml(ctx.baseUrl, '/associados');

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8$/);
  assert.match(html, /<!doctype html>/i);
  assert.ok(html.includes('ACASA · Controle de Pagamentos'));
  assert.ok(html.includes('<h1>Associados</h1>'));
});

test('H2: a lista mostra nome e legacy_id de cada associado', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '007', nome: 'Ana Lima' });
  inserir(ctx.db, { legacyId: 'A-12', nome: 'Bruno Sa' });

  const { html } = await obterHtml(ctx.baseUrl, '/associados');

  assert.ok(html.includes('Ana Lima'));
  assert.ok(html.includes('007'));
  assert.ok(html.includes('Bruno Sa'));
  assert.ok(html.includes('A-12'));
  // O nome leva ao detalhe.
  assert.ok(html.includes(`href="/associados/${id}"`));
});

test('H3: o formulario GET expoe os campos nome e legacy_id', async (t) => {
  const ctx = await subir(t);

  const { html } = await obterHtml(ctx.baseUrl, '/associados');

  assert.ok(html.includes('method="get"'));
  assert.ok(html.includes('name="nome"'));
  assert.ok(html.includes('name="legacy_id"'));
  assert.ok(html.includes('Buscar'));
  assert.ok(html.includes('Limpar filtros'));
});

// --- H4 / H5: vazio nao e erro ------------------------------------------------

test('H4: base vazia responde 200 com mensagem de cadastro vazio', async (t) => {
  const ctx = await subir(t);

  const { response, html } = await obterHtml(ctx.baseUrl, '/associados');

  assert.equal(response.status, 200);
  assert.ok(html.includes('Nenhum associado cadastrado.'));
});

test('H5: filtro sem resultado responde 200, nunca 404', async (t) => {
  const ctx = await subir(t);
  inserir(ctx.db, { legacyId: '1', nome: 'Ana Lima' });

  const porNome = await obterHtml(ctx.baseUrl, '/associados?nome=Ninguem');
  const porLegacy = await obterHtml(ctx.baseUrl, '/associados?legacy_id=999');

  assert.equal(porNome.response.status, 200);
  assert.equal(porLegacy.response.status, 200);
  assert.ok(porNome.html.includes('Nenhum associado corresponde à busca.'));
  assert.ok(porLegacy.html.includes('Nenhum associado corresponde à busca.'));
  assert.equal(porNome.html.includes('Nenhum associado cadastrado.'), false);
});

// --- H6 / H7: filtros ---------------------------------------------------------

test('H6: filtro por nome recorta a lista', async (t) => {
  const ctx = await subir(t);
  inserir(ctx.db, { legacyId: '1', nome: 'Ana Lima' });
  inserir(ctx.db, { legacyId: '2', nome: 'Bruno Sa' });

  const { response, html } = await obterHtml(ctx.baseUrl, '/associados?nome=ana');

  assert.equal(response.status, 200);
  assert.ok(html.includes('Ana Lima'));
  assert.equal(html.includes('Bruno Sa'), false);
  // O filtro volta preenchido no formulario.
  assert.ok(html.includes('value="ana"'));
});

test('H7: filtro por legacy_id e exato e distingue 007 de 7', async (t) => {
  const ctx = await subir(t);
  inserir(ctx.db, { legacyId: '007', nome: 'Zero Zero Sete' });
  inserir(ctx.db, { legacyId: '7', nome: 'Sete Puro' });

  const zeros = await obterHtml(ctx.baseUrl, '/associados?legacy_id=007');
  const sete = await obterHtml(ctx.baseUrl, '/associados?legacy_id=7');

  assert.ok(zeros.html.includes('Zero Zero Sete'));
  assert.equal(zeros.html.includes('Sete Puro'), false);
  assert.ok(sete.html.includes('Sete Puro'));
  assert.equal(sete.html.includes('Zero Zero Sete'), false);
});

// --- H8 / H9 / H10: detalhe ---------------------------------------------------

test('H8: detalhe de associado existente responde 200 com o cadastro', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, {
    legacyId: '42',
    nome: 'Associado Detalhe',
    legacyStatusCode: 'i',
    observacoes: 'anotacao livre',
  });

  const { response, html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.ok(html.includes('Associado Detalhe'));
  assert.ok(html.includes('42'));
  assert.ok(html.includes('anotacao livre'));
  assert.ok(html.includes('Status cadastral'));
  assert.ok(html.includes('indefinido'));
});

test('H9: detalhe inexistente responde 404 HTML', async (t) => {
  const ctx = await subir(t);

  const { response, html } = await obterHtml(ctx.baseUrl, '/associados/999');

  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.ok(html.includes('Associado não encontrado'));
  assert.ok(html.includes('href="/associados"'));
});

test('H10: id malformado responde 404 HTML controlado', async (t) => {
  const ctx = await subir(t);

  for (const rota of ['/associados/abc', '/associados/0', '/associados/-1', '/associados/1.5']) {
    const { response, html } = await obterHtml(ctx.baseUrl, rota);
    assert.equal(response.status, 404, `esperava 404 em ${rota}`);
    assert.match(response.headers.get('content-type'), /text\/html/, `esperava HTML em ${rota}`);
    assert.ok(html.includes('Associado não encontrado'), `esperava pagina de erro em ${rota}`);
  }
});

test('H10b: /associados/legacy/:legacyId redireciona ou responde 404 HTML', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '007', nome: 'Zero Zero Sete' });

  const encontrado = await fetch(`${ctx.baseUrl}/associados/legacy/007`, { redirect: 'manual' });
  assert.equal(encontrado.status, 302);
  assert.equal(encontrado.headers.get('location'), `/associados/${id}`);

  const ausente = await fetch(`${ctx.baseUrl}/associados/legacy/999`, { redirect: 'manual' });
  assert.equal(ausente.status, 404);
  assert.match(ausente.headers.get('content-type'), /text\/html/);
});

// --- H11 / H12 / H13: escaping ------------------------------------------------

test('H11: nome com <script> aparece escapado e nunca como tag executavel', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: '<script>alert(1)</script>' });
  inserir(ctx.db, { legacyId: '<img src=x onerror=alert(1)>', nome: 'Imagem Maliciosa' });

  const lista = await obterHtml(ctx.baseUrl, '/associados');
  const detalhe = await obterHtml(ctx.baseUrl, `/associados/${id}`);

  for (const html of [lista.html, detalhe.html]) {
    assert.equal(html.includes('<script>alert(1)</script>'), false);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  }
  assert.equal(lista.html.includes('<img src=x onerror=alert(1)>'), false);
  assert.ok(lista.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('H12: &, ", \', < e > sao escapados corretamente', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Maria "Zé" & Cia <\'>' });

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);

  assert.ok(html.includes('Maria &quot;Zé&quot; &amp; Cia &lt;&#39;&gt;'));
  assert.equal(html.includes('Maria "Zé" & Cia'), false);
});

test('H13: query refletida maliciosa tambem e escapada', async (t) => {
  const ctx = await subir(t);
  const payload = '<script>alert(1)</script>';

  const { response, html } = await obterHtml(
    ctx.baseUrl,
    `/associados?nome=${encodeURIComponent(payload)}&legacy_id=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`
  );

  assert.equal(response.status, 200);
  assert.equal(html.includes(payload), false);
  assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;'));
});

// --- H14 / H15 / H16: o legado nao ganha semantica ----------------------------

test('H14: o codigo legado aparece rotulado explicitamente como legado', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Ana Lima', legacyStatusCode: 'a' });

  const lista = await obterHtml(ctx.baseUrl, '/associados');
  const detalhe = await obterHtml(ctx.baseUrl, `/associados/${id}`);

  assert.ok(lista.html.includes('Código legado'));
  assert.ok(
    lista.html.includes(
      'Código legado: valor preservado da planilha, sem interpretação. Não indica situação financeira nem adimplência.'
    )
  );
  assert.ok(detalhe.html.includes('Código legado'));
  assert.ok(
    detalhe.html.includes('Dado bruto do legado, sem interpretação. Não é situação financeira.')
  );
});

test('H15: legacy_status_code = "a" nao vira inferencia financeira no HTML', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Ana Lima', legacyStatusCode: 'a' });
  inserir(ctx.db, { legacyId: '2', nome: 'Bruno Sa', legacyStatusCode: 'i' });
  inserir(ctx.db, { legacyId: '3', nome: 'Carla Dias', legacyStatusCode: 'DESLIGADO' });

  const lista = await obterHtml(ctx.baseUrl, '/associados');
  const detalhe = await obterHtml(ctx.baseUrl, `/associados/${id}`);

  const proibidos = [
    'adimplente',
    'inadimplente',
    'em dia',
    'quitado',
    'devendo',
    'devedor',
    'pago',
    'atrasado',
    'r$',
  ];
  for (const html of [lista.html, detalhe.html]) {
    const minusculo = html.toLowerCase();
    for (const termo of proibidos) {
      assert.equal(minusculo.includes(termo), false, `HTML nao pode conter "${termo}"`);
    }
  }

  // O codigo bruto continua visivel exatamente como esta no banco.
  assert.ok(lista.html.includes('DESLIGADO'));
  assert.ok(detalhe.html.includes('<dd>a</dd>'));
});

test('H16: o detalhe reserva as secoes futuras sem inventar numeros', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Ana Lima' });

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);

  for (const secao of [
    'Situação financeira',
    'Competências',
    'Movimentos',
    'Pendências',
    'Comprovantes',
  ]) {
    assert.ok(html.includes(`<h2>${secao}</h2>`), `secao ausente: ${secao}`);
  }
  assert.ok(html.includes('Indisponível nesta versão.'));
  assert.ok(html.includes('Aguardando integração com o ledger.'));

  // Ausencia de integracao nao pode ser apresentada como ausencia de dado.
  for (const numeroInventado of ['0,00', '0 movimentos', '0 pendências', 'nenhuma dívida']) {
    assert.equal(html.includes(numeroInventado), false, `HTML nao pode conter "${numeroInventado}"`);
  }
});

// --- H17: erro nao vaza detalhe tecnico ---------------------------------------

test('H17: erro interno responde 500 HTML sem SQL, caminho ou stack', async (t) => {
  const ctx = await subir(t);
  t.mock.method(console, 'error', () => {});
  // Quebra a leitura por baixo do servico, sem tocar em nenhuma rota.
  ctx.db.exec('DROP TABLE legacy_cell_link');
  ctx.db.exec('DROP TABLE associado');

  const { response, html } = await obterHtml(ctx.baseUrl, '/associados');

  assert.equal(response.status, 500);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.ok(html.includes('Erro interno'));
  for (const vazamento of ['SELECT', 'D:\\', 'stack', 'at Object', 'associado.js', 'sqlite']) {
    assert.equal(html.includes(vazamento), false, `HTML nao pode conter "${vazamento}"`);
  }
});

// --- H18: nenhuma regressao no namespace JSON ---------------------------------

test('H18: /health e as rotas JSON de movimentos continuam intactas', async (t) => {
  const ctx = await subir(t);

  const health = await fetch(`${ctx.baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.match(health.headers.get('content-type'), /application\/json/);
  assert.equal((await health.json()).status, 'ok');

  const criado = await fetch(`${ctx.baseUrl}/api/movimentos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: '2026-06-01', valorCentavos: 15035, origem: 'pagamento' }),
  });
  assert.equal(criado.status, 201);
  const { movimento } = await criado.json();

  const porId = await fetch(`${ctx.baseUrl}/api/movimentos/${movimento.id}`);
  assert.equal(porId.status, 200);
  assert.equal((await porId.json()).movimento.valorCentavos, 15035);

  const fila = await fetch(`${ctx.baseUrl}/api/movimentos?estado=nao_identificado`);
  assert.equal(fila.status, 200);
  const corpoFila = await fila.json();
  assert.equal(corpoFila.status, 'ok');
  assert.equal(corpoFila.paginacao.total, 1);
  assert.equal(corpoFila.itens.length, 1);

  // O catch-all JSON continua respondendo por rotas fora dos dois namespaces.
  const inexistente = await fetch(`${ctx.baseUrl}/rota-que-nao-existe`);
  assert.equal(inexistente.status, 404);
  assert.match(inexistente.headers.get('content-type'), /application\/json/);
});

// =============================================================================
// Fase 3B - secao "Movimentos" do detalhe do associado
// =============================================================================

// --- H19 / H20 / H21 / H22 / H23: quem aparece no extrato ---------------------

test('H19: associado sem movimentos mostra a secao vazia, sem numero inventado', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Sem Movimento' });

  const { response, html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);

  assert.equal(response.status, 200);
  assert.ok(html.includes('<h2>Movimentos</h2>'));
  assert.ok(html.includes('Nenhum movimento registrado para este associado.'));
  for (const inventado of ['R$ 0,00', '0 movimentos', 'Sem alocação registrada']) {
    assert.equal(html.includes(inventado), false, `HTML nao pode conter "${inventado}"`);
  }
});

test('H20: um movimento aparece com o valor formatado a partir dos centavos', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Com Movimento' });
  const movimentoId = inserirMovimento(ctx.db, {
    data: '2026-03-05',
    valorCentavos: 4050,
    associadoId: id,
    observacao: 'deposito conferido',
  });

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);

  assert.ok(html.includes('R$ 40,50'));
  assert.ok(html.includes('2026-03-05'));
  assert.ok(html.includes(`<dd>#${movimentoId}</dd>`));
  assert.ok(html.includes('deposito conferido'));
  // Tipo e estado saem crus, sem traducao ou interpretacao.
  assert.ok(html.includes('<dd>credito</dd>'));
  assert.ok(html.includes('<dd>identificado</dd>'));
  // 4050 centavos nunca aparece como 40.5 nem 4050.
  assert.equal(html.includes('40.5'), false);
});

test('H21: movimento de outro associado nao aparece', async (t) => {
  const ctx = await subir(t);
  const a = inserir(ctx.db, { legacyId: '1', nome: 'Associado A' });
  const b = inserir(ctx.db, { legacyId: '2', nome: 'Associado B' });
  inserirMovimento(ctx.db, { data: '2026-03-05', valorCentavos: 4000, associadoId: a, observacao: 'marca-do-A' });
  inserirMovimento(ctx.db, { data: '2026-03-06', valorCentavos: 2500, associadoId: b, observacao: 'marca-do-B' });

  const paginaA = await obterHtml(ctx.baseUrl, `/associados/${a}`);
  const paginaB = await obterHtml(ctx.baseUrl, `/associados/${b}`);

  assert.ok(paginaA.html.includes('marca-do-A'));
  assert.equal(paginaA.html.includes('marca-do-B'), false);
  assert.ok(paginaB.html.includes('marca-do-B'));
  assert.equal(paginaB.html.includes('marca-do-A'), false);
});

test('H22: movimento nao identificado nao aparece em nenhum detalhe', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Associado A' });
  inserirMovimento(ctx.db, {
    data: '2026-03-05',
    valorCentavos: 4000,
    associadoId: null,
    observacao: 'deposito-sem-dono',
  });

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);

  assert.equal(html.includes('deposito-sem-dono'), false);
  assert.ok(html.includes('Nenhum movimento registrado para este associado.'));
  // A fila JSON continua enxergando o movimento.
  const fila = await fetch(`${ctx.baseUrl}/api/movimentos?estado=nao_identificado`);
  assert.equal((await fila.json()).paginacao.total, 1);
});

test('H23: apos POST /api/movimentos/:id/identificacao o movimento aparece no associado', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Identificado Depois' });

  const criado = await fetch(`${ctx.baseUrl}/api/movimentos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: '2026-03-05', valorCentavos: 4000, origem: 'deposito' }),
  });
  const { movimento } = await criado.json();

  const antes = await obterHtml(ctx.baseUrl, `/associados/${id}`);
  assert.ok(antes.html.includes('Nenhum movimento registrado para este associado.'));

  const identificacao = await fetch(`${ctx.baseUrl}/api/movimentos/${movimento.id}/identificacao`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ associadoId: id, motivo: 'associado confirmou o deposito' }),
  });
  assert.equal(identificacao.status, 200);

  const depois = await obterHtml(ctx.baseUrl, `/associados/${id}`);
  assert.equal(depois.html.includes('Nenhum movimento registrado para este associado.'), false);
  assert.ok(depois.html.includes('R$ 40,00'));
  assert.ok(depois.html.includes(`#${movimento.id}`));
  assert.ok(depois.html.includes('<dd>identificado</dd>'));
});

// --- H24 / H25 / H26 / H27: movimentos x alocacoes (M-02) ---------------------

test('H24: movimento sem alocacao continua visivel e declara a ausencia', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Sem Alocacao' });
  inserirMovimento(ctx.db, { data: '2026-03-05', valorCentavos: 8000, associadoId: id });

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);

  assert.ok(html.includes('R$ 80,00'));
  assert.ok(html.includes('Sem alocação registrada.'));
  // Ausencia de alocacao nao vira credito, saldo nem adiantamento.
  for (const rotulo of ['saldo', 'adiantamento', 'excedente', 'crédito em aberto']) {
    assert.equal(html.toLowerCase().includes(rotulo), false, `HTML nao pode conter "${rotulo}"`);
  }
});

test('H25: movimento com uma alocacao mostra competencia e valor alocado', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Uma Alocacao' });
  const movimentoId = inserirMovimento(ctx.db, { data: '2026-03-05', valorCentavos: 4000, associadoId: id });
  inserirAlocacao(ctx.db, movimentoId, inserirCompetencia(ctx.db, 2026, 3), 4000);

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);

  assert.ok(html.includes('Competência'));
  assert.ok(html.includes('2026-03'));
  assert.ok(html.includes('R$ 40,00'));
  assert.equal(html.includes('Sem alocação registrada.'), false);
});

test('H26: movimento com duas competencias aparece UMA vez com as duas alocacoes', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Multi Competencia' });
  const movimentoId = inserirMovimento(ctx.db, { data: '2026-02-01', valorCentavos: 8000, associadoId: id });
  inserirAlocacao(ctx.db, movimentoId, inserirCompetencia(ctx.db, 2026, 1), 4000);
  inserirAlocacao(ctx.db, movimentoId, inserirCompetencia(ctx.db, 2026, 2), 4000);

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);

  assert.equal(ocorrencias(html, '<li class="movimento">'), 1, 'o movimento nao pode ser duplicado');
  assert.equal(ocorrencias(html, `<dd>#${movimentoId}</dd>`), 1);
  assert.ok(html.includes('2026-01'));
  assert.ok(html.includes('2026-02'));
  assert.ok(html.includes('R$ 80,00'), 'o valor do movimento continua sendo o total');
  assert.equal(ocorrencias(html, '<td>R$ 40,00</td>'), 2, 'duas alocacoes de R$ 40,00');
});

test('H27: dois movimentos na mesma competencia continuam distintos (M-02)', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Cenario N a N' });
  const janeiro = inserirCompetencia(ctx.db, 2026, 1);
  const fevereiro = inserirCompetencia(ctx.db, 2026, 2);

  const movimentoA = inserirMovimento(ctx.db, { data: '2026-01-10', valorCentavos: 8000, associadoId: id });
  inserirAlocacao(ctx.db, movimentoA, janeiro, 4000);
  inserirAlocacao(ctx.db, movimentoA, fevereiro, 4000);

  const movimentoB = inserirMovimento(ctx.db, { data: '2026-02-10', valorCentavos: 4000, associadoId: id });
  inserirAlocacao(ctx.db, movimentoB, fevereiro, 4000);

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);

  assert.equal(ocorrencias(html, '<li class="movimento">'), 2, 'dois movimentos, nem mais nem menos');
  assert.equal(ocorrencias(html, `<dd>#${movimentoA}</dd>`), 1);
  assert.equal(ocorrencias(html, `<dd>#${movimentoB}</dd>`), 1);
  // 2026-02 aparece nos dois movimentos, sem fusao nem sobrescrita.
  assert.equal(ocorrencias(html, '<td>2026-02</td>'), 2);
  assert.equal(ocorrencias(html, '<td>2026-01</td>'), 1);
  assert.ok(html.includes('R$ 80,00'));
});

// --- H28 / H29 / H30: escaping e ausencia de inferencia -----------------------

test('H28: observacao com HTML/script aparece escapada no extrato', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Observacao Maliciosa' });
  inserirMovimento(ctx.db, {
    data: '2026-03-05',
    valorCentavos: 4000,
    associadoId: id,
    observacao: '<script>alert(1)</script> & "aspas" \'simples\'',
    origem: 'pagamento',
  });

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);

  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&amp; &quot;aspas&quot; &#39;simples&#39;'));
});

test('H29: a pagina com movimentos nao produz inferencia de situacao financeira', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Ana Lima', legacyStatusCode: 'a' });
  const movimentoId = inserirMovimento(ctx.db, {
    data: '2026-03-05',
    valorCentavos: 4000,
    associadoId: id,
    observacao: 'deposito conferido',
  });
  inserirAlocacao(ctx.db, movimentoId, inserirCompetencia(ctx.db, 2026, 3), 4000);
  inserirMovimento(ctx.db, { data: '2026-04-05', valorCentavos: 2500, associadoId: id });

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);
  const minusculo = html.toLowerCase();

  for (const termo of [
    'adimplente',
    'inadimplente',
    'em dia',
    'quitado',
    'atrasado',
    'saldo devedor',
    'mensalidade',
    'valor esperado',
    'vencimento',
  ]) {
    assert.equal(minusculo.includes(termo), false, `a UI nao pode produzir "${termo}"`);
  }
  // O codigo legado continua bruto e sem virar proxy de situacao financeira.
  assert.ok(html.includes('<dd>a</dd>'));
});

test('H29b: texto bruto do operador nao e censurado, apenas escapado', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Texto Bruto' });
  // Palavra digitada por uma pessoa no campo livre: e dado, e permanece.
  inserirMovimento(ctx.db, {
    data: '2026-03-05',
    valorCentavos: 4000,
    associadoId: id,
    observacao: 'operador anotou: associado alegou estar inadimplente <b>',
  });

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);

  assert.ok(
    html.includes('operador anotou: associado alegou estar inadimplente &lt;b&gt;'),
    'o dado bruto e preservado verbatim e escapado, nunca removido'
  );
});

test('H30: as demais secoes continuam marcadas como indisponiveis', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Secoes' });
  inserirMovimento(ctx.db, { data: '2026-03-05', valorCentavos: 4000, associadoId: id });

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);

  for (const secao of ['Situação financeira', 'Competências', 'Pendências', 'Comprovantes']) {
    assert.ok(html.includes(`<h2>${secao}</h2>`), `secao ausente: ${secao}`);
  }
  assert.equal(
    ocorrencias(html, 'Indisponível nesta versão. Aguardando integração com o ledger.'),
    4,
    'exatamente as quatro secoes ainda nao implementadas'
  );
  // "Movimentos" deixou de ser reservada.
  assert.ok(html.includes('<h2>Movimentos</h2>'));
  assert.equal(html.includes('0 pendências'), false);
});

// --- H32 / H33 / H34: historico inativado e ordem NA PAGINA (Fase 3C) --------
// A Fase 3B protegia estes comportamentos apenas no servico. Aqui eles sao
// verificados no HTML realmente entregue ao navegador.

test('H32: movimento inativado continua no extrato, com registro, timestamp e motivo', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Movimento Inativado' });
  const movimentoId = inserirMovimento(ctx.db, {
    data: '2026-03-05',
    valorCentavos: 15035,
    associadoId: id,
  });

  inativarMovimento(ctx.db, {
    movimentoId,
    motivo: 'lançamento duplicado <b>conferido</b>',
    ator: 'operador',
  });

  const { response, html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);
  const inativadoEm = ctx.db
    .prepare('SELECT inativado_em FROM movimento_financeiro WHERE id = ?')
    .get(movimentoId).inativado_em;

  assert.equal(response.status, 200);
  // M-09: inativar corrige, nao esconde — o movimento continua no extrato.
  assert.equal(ocorrencias(html, `<dd>#${movimentoId}</dd>`), 1);
  assert.ok(html.includes('R$ 150,35'), 'o valor original continua visivel');

  assert.ok(html.includes('<dt>Registro</dt><dd>inativado</dd>'));
  assert.ok(html.includes('<dt>Inativado em</dt>'));
  assert.ok(html.includes(`<dd>${inativadoEm}</dd>`), 'o timestamp real aparece na pagina');
  assert.ok(html.includes('<dt>Motivo da inativação</dt>'));
  assert.ok(html.includes('lançamento duplicado &lt;b&gt;conferido&lt;/b&gt;'));
  assert.equal(html.includes('<b>conferido</b>'), false, 'o motivo nunca vira marcacao');
});

test('H33: alocacao inativada aparece marcada, com motivo escapado e timestamp', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Alocacao Inativada' });
  const movimentoId = inserirMovimento(ctx.db, {
    data: '2026-03-05',
    valorCentavos: 8000,
    associadoId: id,
  });
  const marco = inserirCompetencia(ctx.db, 2026, 3);
  const abril = inserirCompetencia(ctx.db, 2026, 4);
  inserirAlocacao(ctx.db, movimentoId, marco, 4000);
  inserirAlocacao(ctx.db, movimentoId, abril, 4000);

  const alocacaoId = ctx.db
    .prepare('SELECT id FROM alocacao WHERE movimento_id = ? AND competencia_id = ?')
    .get(movimentoId, marco).id;

  inativarAlocacao(ctx.db, { alocacaoId, motivo: 'competência <script>errada</script>' });

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);
  const inativadoEm = ctx.db.prepare('SELECT inativado_em FROM alocacao WHERE id = ?').get(alocacaoId)
    .inativado_em;

  // As duas alocacoes continuam na pagina, distinguiveis uma da outra.
  assert.ok(html.includes('<td>2026-03</td>'));
  assert.ok(html.includes('<td>2026-04</td>'));
  assert.equal(ocorrencias(html, '<td>ativa</td>'), 1, 'apenas a vizinha continua ativa');
  assert.ok(html.includes(`<td>inativada em ${inativadoEm} — motivo:`), 'estado + quando na mesma celula');
  assert.ok(html.includes('competência &lt;script&gt;errada&lt;/script&gt;'));
  assert.equal(html.includes('<script>errada</script>'), false);

  // O movimento dono continua ativo: inativar alocacao nao inativa movimento.
  assert.ok(html.includes('<dt>Registro</dt><dd>ativo</dd>'));
  assert.equal(html.includes('<dt>Inativado em</dt>'), false, 'movimento ativo nao ganha timestamp');
});

test('H34: o extrato renderiza data DESC com id DESC como desempate', async (t) => {
  const ctx = await subir(t);
  const id = inserir(ctx.db, { legacyId: '1', nome: 'Ordem do Extrato' });

  // Inseridos fora de ordem de proposito; os ids crescem na ordem de insercao.
  const antigo = inserirMovimento(ctx.db, { data: '2026-01-10', valorCentavos: 1000, associadoId: id });
  const recenteA = inserirMovimento(ctx.db, { data: '2026-05-01', valorCentavos: 2000, associadoId: id });
  const meio = inserirMovimento(ctx.db, { data: '2026-03-01', valorCentavos: 3000, associadoId: id });
  const recenteB = inserirMovimento(ctx.db, { data: '2026-05-01', valorCentavos: 4000, associadoId: id });

  assert.ok(recenteB > recenteA, 'o desempate so faz sentido com ids crescentes');

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${id}`);
  const posicao = (movimentoId) => html.indexOf(`<dd>#${movimentoId}</dd>`);

  for (const movimentoId of [antigo, recenteA, meio, recenteB]) {
    assert.notEqual(posicao(movimentoId), -1, `movimento ${movimentoId} ausente da pagina`);
  }

  // data DESC; entre os dois de 2026-05-01, id DESC.
  assert.ok(posicao(recenteB) < posicao(recenteA), 'mesma data: id maior aparece primeiro');
  assert.ok(posicao(recenteA) < posicao(meio), 'data mais recente antes da mais antiga');
  assert.ok(posicao(meio) < posicao(antigo));
  assert.equal(ocorrencias(html, '<li class="movimento">'), 4);
});

// --- H31: nenhuma regressao nas rotas JSON ------------------------------------

test('H31: as seis rotas JSON preexistentes continuam cumprindo o contrato', async (t) => {
  const ctx = await subir(t);
  const associadoId = inserir(ctx.db, { legacyId: '1', nome: 'Regressao' });
  const competenciaId = inserirCompetencia(ctx.db, 2026, 6);

  const health = await fetch(`${ctx.baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');

  const criado = await fetch(`${ctx.baseUrl}/api/movimentos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: '2026-06-01', valorCentavos: 8000, origem: 'deposito' }),
  });
  assert.equal(criado.status, 201);
  const { movimento } = await criado.json();
  assert.equal(movimento.valorCentavos, 8000);

  const fila = await fetch(`${ctx.baseUrl}/api/movimentos?estado=nao_identificado`);
  assert.equal(fila.status, 200);
  assert.equal((await fila.json()).paginacao.total, 1);

  const identificacao = await fetch(`${ctx.baseUrl}/api/movimentos/${movimento.id}/identificacao`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ associadoId, motivo: 'confirmado com o associado' }),
  });
  assert.equal(identificacao.status, 200);
  assert.equal((await identificacao.json()).movimento.associadoId, associadoId);

  const alocacao = await fetch(`${ctx.baseUrl}/api/movimentos/${movimento.id}/alocacoes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ competenciaId, valorCentavos: 4000 }),
  });
  assert.equal(alocacao.status, 201);
  assert.equal((await alocacao.json()).alocacao.valorCentavos, 4000);

  const porId = await fetch(`${ctx.baseUrl}/api/movimentos/${movimento.id}`);
  assert.equal(porId.status, 200);
  const corpo = await porId.json();
  assert.equal(corpo.movimento.alocacoes.length, 1);
  assert.equal(corpo.movimento.resumo.naoAlocadoCentavos, 4000);

  // A fila esvaziou e o extrato HTML passou a mostrar o mesmo movimento.
  const filaDepois = await fetch(`${ctx.baseUrl}/api/movimentos?estado=nao_identificado`);
  assert.equal((await filaDepois.json()).paginacao.total, 0);

  const { html } = await obterHtml(ctx.baseUrl, `/associados/${associadoId}`);
  assert.ok(html.includes('R$ 80,00'));
  assert.ok(html.includes('<td>2026-06</td>'));
  assert.ok(html.includes('<td>R$ 40,00</td>'));
});
