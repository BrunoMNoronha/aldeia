'use strict';

// Fase 3A - leitura cadastral de associados.
// O foco destes testes e duplo: o contrato de busca/filtro E a garantia de que
// o legado atravessa o servico VERBATIM, sem ganhar semantica financeira.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LIMITE_PADRAO,
  listarAssociados,
  obterAssociado,
  obterAssociadoPorLegacyId,
} = require('../src/services/associados');
const ledger = require('../src/services/ledger');
const { formatarCentavos } = require('../src/web/html');
const { createMigratedDb } = require('./helpers/temp-db');

function inserir(db, { legacyId = null, nome, statusCadastral, legacyStatusCode = null, observacoes = null }) {
  const sql =
    statusCadastral === undefined
      ? 'INSERT INTO associado (legacy_id, nome, legacy_status_code, observacoes) VALUES (?, ?, ?, ?)'
      : 'INSERT INTO associado (legacy_id, nome, legacy_status_code, observacoes, status_cadastral) VALUES (?, ?, ?, ?, ?)';
  const parametros = [legacyId, nome, legacyStatusCode, observacoes];
  if (statusCadastral !== undefined) parametros.push(statusCadastral);
  return Number(db.prepare(sql).run(...parametros).lastInsertRowid);
}

function nomes(resultado) {
  return resultado.itens.map((item) => item.nome);
}

// --- helpers do ledger individual (Fase 3B) ----------------------------------

/** Movimento direto no banco: permite montar cenarios que a API nao cria. */
function inserirMovimento(db, { data, valorCentavos, associadoId = null, ...resto }) {
  const estado = resto.estadoIdentificacao ?? (associadoId === null ? 'nao_identificado' : 'identificado');
  return Number(
    db
      .prepare(
        `INSERT INTO movimento_financeiro
           (data, valor_centavos, tipo, origem, associado_id, observacao, estado_identificacao)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        data,
        valorCentavos,
        resto.tipo ?? 'credito',
        resto.origem ?? 'pagamento',
        associadoId,
        resto.observacao ?? null,
        estado
      ).lastInsertRowid
  );
}

function inserirCompetencia(db, ano, mes) {
  return Number(db.prepare('INSERT INTO competencia (ano, mes) VALUES (?, ?)').run(ano, mes).lastInsertRowid);
}

function inserirAlocacao(db, movimentoId, competenciaId, valorCentavos) {
  return Number(
    db
      .prepare('INSERT INTO alocacao (movimento_id, competencia_id, valor_centavos) VALUES (?, ?, ?)')
      .run(movimentoId, competenciaId, valorCentavos).lastInsertRowid
  );
}

function rotulos(movimento) {
  return movimento.alocacoes.map((alocacao) => alocacao.competencia.rotulo);
}

// --- S1 / S2: listagem base ---------------------------------------------------

test('S1: lista associados em ordem deterministica por nome e id', (t) => {
  const { db } = createMigratedDb(t);
  inserir(db, { legacyId: '3', nome: 'carlos Dias' });
  inserir(db, { legacyId: '1', nome: 'Ana Lima' });
  inserir(db, { legacyId: '2', nome: 'Bruno Sa' });

  const resultado = listarAssociados(db);

  assert.deepEqual(nomes(resultado), ['Ana Lima', 'Bruno Sa', 'carlos Dias']);
  assert.equal(resultado.total, 3);
  assert.equal(resultado.truncado, false);
  assert.deepEqual(resultado.filtros, { nome: null, legacyId: null });
  // Repetir a consulta nao pode reordenar nada.
  assert.deepEqual(nomes(listarAssociados(db)), nomes(resultado));
});

test('S2: banco vazio devolve lista vazia e total zero, sem lancar', (t) => {
  const { db } = createMigratedDb(t);

  const resultado = listarAssociados(db);

  assert.deepEqual(resultado.itens, []);
  assert.equal(resultado.total, 0);
  assert.equal(resultado.truncado, false);
  assert.notEqual(resultado, null);
});

// --- S3 / S4 / S5: busca por nome ---------------------------------------------

test('S3: busca por nome e parcial', (t) => {
  const { db } = createMigratedDb(t);
  inserir(db, { legacyId: '1', nome: 'Maria Aparecida Souza' });
  inserir(db, { legacyId: '2', nome: 'Joao Pedro Souza' });
  inserir(db, { legacyId: '3', nome: 'Carla Menezes' });

  assert.deepEqual(nomes(listarAssociados(db, { nome: 'Souza' })), [
    'Joao Pedro Souza',
    'Maria Aparecida Souza',
  ]);
  assert.deepEqual(nomes(listarAssociados(db, { nome: 'Aparecida' })), ['Maria Aparecida Souza']);
});

test('S4: busca por nome ignora caixa e espacos das bordas', (t) => {
  const { db } = createMigratedDb(t);
  inserir(db, { legacyId: '1', nome: 'Mariana Souza' });

  assert.deepEqual(nomes(listarAssociados(db, { nome: 'mariana' })), ['Mariana Souza']);
  assert.deepEqual(nomes(listarAssociados(db, { nome: 'MARIANA' })), ['Mariana Souza']);
  assert.deepEqual(nomes(listarAssociados(db, { nome: '  mariana  ' })), ['Mariana Souza']);
  // String vazia (ou so espacos) nao e filtro.
  assert.equal(listarAssociados(db, { nome: '   ' }).filtros.nome, null);
  assert.equal(listarAssociados(db, { nome: '   ' }).total, 1);
});

test('S5: busca sem resultado devolve lista vazia e preserva o filtro', (t) => {
  const { db } = createMigratedDb(t);
  inserir(db, { legacyId: '1', nome: 'Mariana Souza' });

  const resultado = listarAssociados(db, { nome: 'Ninguem' });

  assert.deepEqual(resultado.itens, []);
  assert.equal(resultado.total, 0);
  assert.equal(resultado.filtros.nome, 'Ninguem');
});

// --- S6 / S7 / S8: filtro por legacy_id ---------------------------------------

test('S6: filtro por legacy_id e igualdade exata', (t) => {
  const { db } = createMigratedDb(t);
  inserir(db, { legacyId: '10', nome: 'Dez' });
  inserir(db, { legacyId: '100', nome: 'Cem' });

  assert.deepEqual(nomes(listarAssociados(db, { legacyId: '10' })), ['Dez']);
  assert.deepEqual(nomes(listarAssociados(db, { legacyId: ' 100 ' })), ['Cem']);
});

test('S7: legacy_id inexistente devolve lista vazia', (t) => {
  const { db } = createMigratedDb(t);
  inserir(db, { legacyId: '10', nome: 'Dez' });

  const resultado = listarAssociados(db, { legacyId: '999' });

  assert.deepEqual(resultado.itens, []);
  assert.equal(resultado.total, 0);
  assert.equal(resultado.filtros.legacyId, '999');
});

test('S8: "007" nao se confunde com "7"', (t) => {
  const { db } = createMigratedDb(t);
  inserir(db, { legacyId: '007', nome: 'Zero Zero Sete' });
  inserir(db, { legacyId: '7', nome: 'Sete' });

  assert.deepEqual(nomes(listarAssociados(db, { legacyId: '007' })), ['Zero Zero Sete']);
  assert.deepEqual(nomes(listarAssociados(db, { legacyId: '7' })), ['Sete']);
  assert.equal(obterAssociadoPorLegacyId(db, '007').nome, 'Zero Zero Sete');
  assert.equal(obterAssociadoPorLegacyId(db, '7').nome, 'Sete');
  // O legacy_id devolvido preserva os zeros a esquerda.
  assert.equal(obterAssociadoPorLegacyId(db, '007').legacyId, '007');
});

// --- S9 / S10: combinacao e literalidade dos filtros --------------------------

test('S9: nome e legacy_id combinam com AND, nao com OR', (t) => {
  const { db } = createMigratedDb(t);
  inserir(db, { legacyId: '1', nome: 'Ana Lima' });
  inserir(db, { legacyId: '2', nome: 'Bruno Lima' });

  assert.deepEqual(nomes(listarAssociados(db, { nome: 'Lima', legacyId: '1' })), ['Ana Lima']);
  // Combinacao incoerente nao pode "cair" para um dos lados.
  assert.deepEqual(listarAssociados(db, { nome: 'Ana', legacyId: '2' }).itens, []);
});

test('S10: %, _ e \\ sao caracteres literais na busca por nome', (t) => {
  const { db } = createMigratedDb(t);
  inserir(db, { legacyId: '1', nome: 'Ana%Paula' });
  inserir(db, { legacyId: '2', nome: 'Ana_Paula' });
  inserir(db, { legacyId: '3', nome: 'Ana\\Paula' });
  inserir(db, { legacyId: '4', nome: 'AnaXPaula' });

  assert.deepEqual(nomes(listarAssociados(db, { nome: 'Ana%Paula' })), ['Ana%Paula']);
  assert.deepEqual(nomes(listarAssociados(db, { nome: 'Ana_Paula' })), ['Ana_Paula']);
  assert.deepEqual(nomes(listarAssociados(db, { nome: 'Ana\\Paula' })), ['Ana\\Paula']);
  // '%' e '_' sozinhos sao texto: nao podem virar curinga "tudo"/"um caractere".
  assert.deepEqual(nomes(listarAssociados(db, { nome: '%' })), ['Ana%Paula']);
  assert.deepEqual(nomes(listarAssociados(db, { nome: '_' })), ['Ana_Paula']);
  assert.deepEqual(nomes(listarAssociados(db, { nome: 'Ana_' })), ['Ana_Paula']);
});

// --- S11 / S12 / S13 / S14: detalhe -------------------------------------------

test('S11: detalhe por id existente devolve o cadastro mapeado', (t) => {
  const { db } = createMigratedDb(t);
  const id = inserir(db, {
    legacyId: '42',
    nome: 'Associado Detalhe',
    legacyStatusCode: 'i',
    observacoes: 'anotacao livre',
  });

  const associado = obterAssociado(db, id);

  assert.equal(associado.id, id);
  assert.equal(associado.legacyId, '42');
  assert.equal(associado.nome, 'Associado Detalhe');
  assert.equal(associado.statusCadastral, 'indefinido');
  assert.equal(associado.legacyStatusCode, 'i');
  assert.equal(associado.observacoes, 'anotacao livre');
  assert.equal(typeof associado.criadoEm, 'string');
  assert.equal(typeof associado.atualizadoEm, 'string');
});

test('S12: id inexistente devolve null em vez de lancar', (t) => {
  const { db } = createMigratedDb(t);

  assert.equal(obterAssociado(db, 999), null);
});

test('S13: id invalido devolve null', (t) => {
  const { db } = createMigratedDb(t);
  inserir(db, { legacyId: '1', nome: 'Alguem' });

  for (const invalido of ['abc', '', '  ', 0, '0', -1, '-1', 1.5, '1.5', null, undefined, {}, ['1']]) {
    assert.equal(obterAssociado(db, invalido), null, `esperava null para ${JSON.stringify(invalido)}`);
  }
});

test('S14: busca por legacy_id existente e inexistente', (t) => {
  const { db } = createMigratedDb(t);
  inserir(db, { legacyId: 'A-12', nome: 'Codigo Nao Numerico' });

  assert.equal(obterAssociadoPorLegacyId(db, 'A-12').nome, 'Codigo Nao Numerico');
  assert.equal(obterAssociadoPorLegacyId(db, 'A-13'), null);
  assert.equal(obterAssociadoPorLegacyId(db, '   '), null);
  assert.equal(obterAssociadoPorLegacyId(db, ''), null);
  assert.equal(obterAssociadoPorLegacyId(db, null), null);
});

// --- S15 / S16: o dado atravessa o servico intacto ----------------------------

test('S15: acentos e caracteres especiais voltam verbatim', (t) => {
  const { db } = createMigratedDb(t);
  const nome = 'José "Zé" Gonçalves & Cia <irmãos>';
  const id = inserir(db, { legacyId: '1', nome, observacoes: "aspas ' e < > &" });

  const associado = obterAssociado(db, id);

  assert.equal(associado.nome, nome);
  assert.equal(associado.observacoes, "aspas ' e < > &");
  assert.deepEqual(nomes(listarAssociados(db, { nome: 'Gonçalves' })), [nome]);
});

test('S16: string parecida com SQL injection e apenas dado', (t) => {
  const { db } = createMigratedDb(t);
  const malicioso = "'; DROP TABLE associado; --";
  inserir(db, { legacyId: malicioso, nome: malicioso });

  assert.deepEqual(nomes(listarAssociados(db, { nome: malicioso })), [malicioso]);
  assert.deepEqual(nomes(listarAssociados(db, { legacyId: malicioso })), [malicioso]);
  // A tabela continua de pe e o registro continua la.
  assert.equal(db.prepare('SELECT COUNT(*) AS t FROM associado').get().t, 1);
});

// --- S17 / S18: nenhuma interpretacao financeira ------------------------------

test('S17: o objeto de associado nao possui campo financeiro derivado', (t) => {
  const { db } = createMigratedDb(t);
  const id = inserir(db, { legacyId: '1', nome: 'Sem Financeiro', legacyStatusCode: 'a' });

  const associado = obterAssociado(db, id);

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
});

test('S18: legacy_status_code permanece bruto e nao contamina o status cadastral', (t) => {
  const { db } = createMigratedDb(t);
  const idA = inserir(db, { legacyId: '1', nome: 'Codigo A', legacyStatusCode: 'a' });
  const idI = inserir(db, { legacyId: '2', nome: 'Codigo I', legacyStatusCode: 'i' });
  const idD = inserir(db, { legacyId: '3', nome: 'Codigo Desligado', legacyStatusCode: 'DESLIGADO' });
  const idNulo = inserir(db, { legacyId: '4', nome: 'Sem Codigo' });

  assert.equal(obterAssociado(db, idA).legacyStatusCode, 'a');
  assert.equal(obterAssociado(db, idI).legacyStatusCode, 'i');
  assert.equal(obterAssociado(db, idD).legacyStatusCode, 'DESLIGADO');
  assert.equal(obterAssociado(db, idNulo).legacyStatusCode, null);

  // 'a' NAO vira 'ativo': o status cadastral segue no default do schema.
  for (const id of [idA, idI, idD, idNulo]) {
    assert.equal(obterAssociado(db, id).statusCadastral, 'indefinido');
  }
});

// --- S19: truncamento explicito -----------------------------------------------

test('S19: limite menor que o universo corta e sinaliza truncado', (t) => {
  const { db } = createMigratedDb(t);
  inserir(db, { legacyId: '1', nome: 'Ana' });
  inserir(db, { legacyId: '2', nome: 'Bruno' });
  inserir(db, { legacyId: '3', nome: 'Carla' });

  const resultado = listarAssociados(db, { limite: 2 });

  assert.deepEqual(nomes(resultado), ['Ana', 'Bruno']);
  assert.equal(resultado.total, 2);
  assert.equal(resultado.truncado, true);

  // Limite exatamente igual ao universo nao e truncamento.
  const exato = listarAssociados(db, { limite: 3 });
  assert.equal(exato.total, 3);
  assert.equal(exato.truncado, false);

  // Limite invalido cai no padrao em vez de virar 0 linhas.
  assert.equal(listarAssociados(db, { limite: 0 }).total, 3);
  assert.equal(listarAssociados(db, { limite: -1 }).total, 3);
  assert.equal(listarAssociados(db, { limite: 'muitos' }).total, 3);
  assert.equal(LIMITE_PADRAO, 500);
});

// =============================================================================
// Fase 3B - ledger individual do associado (ledger.listarMovimentosDoAssociado)
// =============================================================================

// --- S20 / S21 / S22: quem pertence ao extrato --------------------------------

test('S20: associado sem movimentos devolve lista vazia', (t) => {
  const { db } = createMigratedDb(t);
  const id = inserir(db, { legacyId: '1', nome: 'Sem Movimento' });

  assert.deepEqual(ledger.listarMovimentosDoAssociado(db, id), []);
});

test('S21: um movimento vinculado aparece com os campos do modelo', (t) => {
  const { db } = createMigratedDb(t);
  const id = inserir(db, { legacyId: '1', nome: 'Com Movimento' });
  const movimentoId = inserirMovimento(db, {
    data: '2026-03-05',
    valorCentavos: 4050,
    associadoId: id,
    observacao: 'deposito conferido',
  });

  const movimentos = ledger.listarMovimentosDoAssociado(db, id);

  assert.equal(movimentos.length, 1);
  assert.equal(movimentos[0].id, movimentoId);
  assert.equal(movimentos[0].data, '2026-03-05');
  assert.equal(movimentos[0].valorCentavos, 4050);
  assert.equal(movimentos[0].tipo, 'credito');
  assert.equal(movimentos[0].origem, 'pagamento');
  assert.equal(movimentos[0].estadoIdentificacao, 'identificado');
  assert.equal(movimentos[0].observacao, 'deposito conferido');
  assert.equal(movimentos[0].ativo, true);
  assert.deepEqual(movimentos[0].alocacoes, []);
});

test('S22: movimento do associado A nao aparece no associado B', (t) => {
  const { db } = createMigratedDb(t);
  const a = inserir(db, { legacyId: '1', nome: 'Associado A' });
  const b = inserir(db, { legacyId: '2', nome: 'Associado B' });
  const doA = inserirMovimento(db, { data: '2026-03-05', valorCentavos: 4000, associadoId: a });
  const doB = inserirMovimento(db, { data: '2026-03-06', valorCentavos: 2500, associadoId: b });

  assert.deepEqual(
    ledger.listarMovimentosDoAssociado(db, a).map((m) => m.id),
    [doA]
  );
  assert.deepEqual(
    ledger.listarMovimentosDoAssociado(db, b).map((m) => m.id),
    [doB]
  );
});

test('S23: movimento sem associado nao aparece em nenhum extrato individual', (t) => {
  const { db } = createMigratedDb(t);
  const a = inserir(db, { legacyId: '1', nome: 'Associado A' });
  const b = inserir(db, { legacyId: '2', nome: 'Associado B' });
  // Mesmo valor e mesma data do movimento do associado A: nada disso e pista.
  inserirMovimento(db, { data: '2026-03-05', valorCentavos: 4000, associadoId: a });
  inserirMovimento(db, { data: '2026-03-05', valorCentavos: 4000, associadoId: null });

  assert.equal(ledger.listarMovimentosDoAssociado(db, a).length, 1);
  assert.equal(ledger.listarMovimentosDoAssociado(db, b).length, 0);
  // O nao identificado continua na fila, intocado.
  assert.equal(ledger.listarMovimentosNaoIdentificados(db).paginacao.total, 1);
});

test('S24: apos a identificacao estruturada o movimento entra no extrato', (t) => {
  const { db } = createMigratedDb(t);
  const id = inserir(db, { legacyId: '1', nome: 'Identificado Depois' });
  const movimento = ledger.registrarMovimento(db, {
    data: '2026-03-05',
    valorCentavos: 4000,
    origem: 'deposito',
  });

  assert.deepEqual(ledger.listarMovimentosDoAssociado(db, id), []);

  ledger.identificarMovimento(db, {
    movimentoId: movimento.id,
    associadoId: id,
    motivo: 'associado confirmou o deposito por telefone',
  });

  const movimentos = ledger.listarMovimentosDoAssociado(db, id);
  assert.equal(movimentos.length, 1);
  assert.equal(movimentos[0].id, movimento.id);
  assert.equal(movimentos[0].estadoIdentificacao, 'identificado');
  // E sai da fila de nao identificados.
  assert.equal(ledger.listarMovimentosNaoIdentificados(db).paginacao.total, 0);
});

// --- S25 / S26 / S27 / S28: movimentos x alocacoes (M-02) ---------------------

test('S25: movimento sem alocacao continua presente no extrato', (t) => {
  const { db } = createMigratedDb(t);
  const id = inserir(db, { legacyId: '1', nome: 'Sem Alocacao' });
  inserirMovimento(db, { data: '2026-03-05', valorCentavos: 8000, associadoId: id });

  const movimentos = ledger.listarMovimentosDoAssociado(db, id);

  assert.equal(movimentos.length, 1);
  assert.deepEqual(movimentos[0].alocacoes, []);
  assert.equal(movimentos[0].valorCentavos, 8000);
});

test('S26: uma alocacao traz competencia e valor alocado corretos', (t) => {
  const { db } = createMigratedDb(t);
  const id = inserir(db, { legacyId: '1', nome: 'Uma Alocacao' });
  const movimentoId = inserirMovimento(db, { data: '2026-03-05', valorCentavos: 4000, associadoId: id });
  const competenciaId = inserirCompetencia(db, 2026, 3);
  inserirAlocacao(db, movimentoId, competenciaId, 4000);

  const [movimento] = ledger.listarMovimentosDoAssociado(db, id);

  assert.equal(movimento.alocacoes.length, 1);
  assert.equal(movimento.alocacoes[0].valorCentavos, 4000);
  assert.equal(movimento.alocacoes[0].competencia.id, competenciaId);
  assert.equal(movimento.alocacoes[0].competencia.ano, 2026);
  assert.equal(movimento.alocacoes[0].competencia.mes, 3);
  assert.equal(movimento.alocacoes[0].competencia.rotulo, '2026-03');
  assert.equal(movimento.alocacoes[0].ativo, true);
});

test('S27: movimento com varias alocacoes nao e duplicado', (t) => {
  const { db } = createMigratedDb(t);
  const id = inserir(db, { legacyId: '1', nome: 'Multi Competencia' });
  const movimentoId = inserirMovimento(db, { data: '2026-02-01', valorCentavos: 8000, associadoId: id });
  inserirAlocacao(db, movimentoId, inserirCompetencia(db, 2026, 1), 4000);
  inserirAlocacao(db, movimentoId, inserirCompetencia(db, 2026, 2), 4000);

  const movimentos = ledger.listarMovimentosDoAssociado(db, id);

  assert.equal(movimentos.length, 1, 'um movimento com duas competencias continua sendo UM movimento');
  assert.equal(movimentos[0].valorCentavos, 8000);
  assert.deepEqual(rotulos(movimentos[0]), ['2026-01', '2026-02']);
  assert.deepEqual(
    movimentos[0].alocacoes.map((a) => a.valorCentavos),
    [4000, 4000]
  );
});

test('S28: uma competencia recebe varios movimentos, que seguem distintos', (t) => {
  const { db } = createMigratedDb(t);
  const id = inserir(db, { legacyId: '1', nome: 'Duas Parcelas' });
  const competenciaId = inserirCompetencia(db, 2026, 2);
  const primeiro = inserirMovimento(db, { data: '2026-02-05', valorCentavos: 2000, associadoId: id });
  const segundo = inserirMovimento(db, { data: '2026-02-20', valorCentavos: 2000, associadoId: id });
  inserirAlocacao(db, primeiro, competenciaId, 2000);
  inserirAlocacao(db, segundo, competenciaId, 2000);

  const movimentos = ledger.listarMovimentosDoAssociado(db, id);

  assert.equal(movimentos.length, 2);
  assert.deepEqual(
    movimentos.map((m) => m.id),
    [segundo, primeiro],
    'ordenacao data DESC, id DESC'
  );
  // Nenhum dos dois foi agregado no outro.
  for (const movimento of movimentos) {
    assert.deepEqual(rotulos(movimento), ['2026-02']);
    assert.equal(movimento.alocacoes[0].valorCentavos, 2000);
  }
});

test('M-02: cenario completo N:N — A em 2026-01 e 2026-02, B em 2026-02', (t) => {
  const { db } = createMigratedDb(t);
  const id = inserir(db, { legacyId: '1', nome: 'Cenario N a N' });
  const janeiro = inserirCompetencia(db, 2026, 1);
  const fevereiro = inserirCompetencia(db, 2026, 2);

  const movimentoA = inserirMovimento(db, { data: '2026-01-10', valorCentavos: 8000, associadoId: id });
  inserirAlocacao(db, movimentoA, janeiro, 4000);
  inserirAlocacao(db, movimentoA, fevereiro, 4000);

  const movimentoB = inserirMovimento(db, { data: '2026-02-10', valorCentavos: 4000, associadoId: id });
  inserirAlocacao(db, movimentoB, fevereiro, 4000);

  const movimentos = ledger.listarMovimentosDoAssociado(db, id);

  assert.equal(movimentos.length, 2, 'dois movimentos, nem mais nem menos');
  const porId = new Map(movimentos.map((m) => [m.id, m]));
  assert.deepEqual(rotulos(porId.get(movimentoA)), ['2026-01', '2026-02']);
  assert.deepEqual(rotulos(porId.get(movimentoB)), ['2026-02']);
  // A competencia de fevereiro aparece nos dois movimentos, sem fusao.
  assert.equal(porId.get(movimentoA).valorCentavos, 8000);
  assert.equal(porId.get(movimentoB).valorCentavos, 4000);
});

// --- S29 / S30 / S31: dinheiro, dado bruto e ordenacao ------------------------

test('S29: valores permanecem inteiros em centavos no service', (t) => {
  const { db } = createMigratedDb(t);
  const id = inserir(db, { legacyId: '1', nome: 'Valores' });
  // `movimento_financeiro` tem CHECK (valor_centavos > 0): 0 e negativo NAO sao
  // representaveis neste modelo, entao nao ha cenario de service para eles.
  const valores = [1, 40, 4000, 4050];
  valores.forEach((valor, indice) => {
    inserirMovimento(db, { data: `2026-03-0${indice + 1}`, valorCentavos: valor, associadoId: id });
  });

  const movimentos = ledger.listarMovimentosDoAssociado(db, id);

  for (const movimento of movimentos) {
    assert.equal(Number.isInteger(movimento.valorCentavos), true);
    assert.equal(typeof movimento.valorCentavos, 'number');
  }
  assert.deepEqual(
    movimentos.map((m) => m.valorCentavos).sort((a, b) => a - b),
    valores
  );
  // Nenhum campo em reais foi introduzido no objeto de dominio.
  for (const proibido of ['valor', 'valorReais', 'valorFormatado', 'saldo', 'total']) {
    assert.equal(proibido in movimentos[0], false, `campo de apresentacao proibido: ${proibido}`);
  }
});

test('S29b: formatarCentavos e conversao de APRESENTACAO, exata e sem float', () => {
  assert.equal(formatarCentavos(0), 'R$ 0,00');
  assert.equal(formatarCentavos(1), 'R$ 0,01');
  assert.equal(formatarCentavos(40), 'R$ 0,40');
  assert.equal(formatarCentavos(4000), 'R$ 40,00');
  assert.equal(formatarCentavos(4050), 'R$ 40,50');
  assert.equal(formatarCentavos(-2500), '-R$ 25,00');
  assert.equal(formatarCentavos(123456789), 'R$ 1.234.567,89');
  assert.equal(formatarCentavos(Number.MAX_SAFE_INTEGER), 'R$ 90.071.992.547.409,91');
  // Valor fracionario e defeito de dado, nao numero a arredondar.
  assert.throws(() => formatarCentavos(150.35), TypeError);
  assert.throws(() => formatarCentavos('4000'), TypeError);
  assert.throws(() => formatarCentavos(null), TypeError);
});

test('S30: observacao maliciosa atravessa o service verbatim', (t) => {
  const { db } = createMigratedDb(t);
  const id = inserir(db, { legacyId: '1', nome: 'Observacao Bruta' });
  const payload = '<script>alert(1)</script> & "aspas" \'simples\'';
  inserirMovimento(db, {
    data: '2026-03-05',
    valorCentavos: 4000,
    associadoId: id,
    observacao: payload,
    origem: 'pagamento',
  });

  const [movimento] = ledger.listarMovimentosDoAssociado(db, id);

  assert.equal(movimento.observacao, payload, 'o service nao sanitiza: escaping e da view');
});

test('S31: ordenacao deterministica por data DESC e id DESC', (t) => {
  const { db } = createMigratedDb(t);
  const id = inserir(db, { legacyId: '1', nome: 'Ordenacao' });
  const antigo = inserirMovimento(db, { data: '2026-01-10', valorCentavos: 1000, associadoId: id });
  const mesmoDiaA = inserirMovimento(db, { data: '2026-03-01', valorCentavos: 2000, associadoId: id });
  const mesmoDiaB = inserirMovimento(db, { data: '2026-03-01', valorCentavos: 3000, associadoId: id });
  const recente = inserirMovimento(db, { data: '2026-05-20', valorCentavos: 4000, associadoId: id });

  const esperado = [recente, mesmoDiaB, mesmoDiaA, antigo];
  assert.deepEqual(
    ledger.listarMovimentosDoAssociado(db, id).map((m) => m.id),
    esperado
  );
  // Repetir a consulta devolve exatamente a mesma sequencia.
  assert.deepEqual(
    ledger.listarMovimentosDoAssociado(db, id).map((m) => m.id),
    esperado
  );
});

test('S32: associadoId invalido e recusado; movimento inativado nao some', (t) => {
  const { db } = createMigratedDb(t);
  const id = inserir(db, { legacyId: '1', nome: 'Historico' });

  for (const invalido of [0, -1, 1.5, 'abc', null, undefined]) {
    assert.throws(
      () => ledger.listarMovimentosDoAssociado(db, invalido),
      (erro) => erro instanceof ledger.LedgerError && erro.codigo === 'id_invalido',
      `esperava id_invalido para ${JSON.stringify(invalido)}`
    );
  }

  // M-09: inativacao e auditavel e o registro permanece visivel no extrato.
  const movimentoId = inserirMovimento(db, { data: '2026-03-05', valorCentavos: 4000, associadoId: id });
  db.prepare(
    `UPDATE movimento_financeiro
        SET ativo = 0, inativado_em = '2026-04-01T00:00:00Z', motivo_inativacao = 'lancamento em duplicidade'
      WHERE id = ?`
  ).run(movimentoId);

  const [movimento] = ledger.listarMovimentosDoAssociado(db, id);
  assert.equal(movimento.id, movimentoId);
  assert.equal(movimento.ativo, false);
  assert.equal(movimento.inativadoEm, '2026-04-01T00:00:00Z');
  assert.equal(movimento.motivoInativacao, 'lancamento em duplicidade');
});
