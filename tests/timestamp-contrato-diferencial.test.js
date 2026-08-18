'use strict';

// Teste DIFERENCIAL de contrato — precisao publica de timestamp (PG-2A x PG-2B1 x SQLite).
//
// PG-2A (`associados-contrato.js`) e PG-2B1 (`comprovantes-contrato.js`) recebem,
// cada um, o mesmo `Date` que o driver `pg` entrega para uma coluna TIMESTAMPTZ,
// e cada um tem sua propria funcao `normalizarInstante`/`mapear*`. O SQLite nunca
// produz um `Date` aqui — ele ja guarda TEXT no formato `YYYY-MM-DDTHH:MM:SSZ`
// (`strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`), entao seu lado da comparacao e o
// proprio literal esperado, sem conversao.
//
// O instante e controlado (nao `now()`) para que a comparacao seja por VALOR
// exato, e nao apenas por tipo ou regex — ver AGENTS.md, secao "Correcao de
// entidade financeira" e M-07/M-10 quanto a nao alterar semantica de dado.

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizarInstante: normalizarInstantePg2a, mapearAssociado } = require('../src/services/associados-contrato');
const { normalizarInstante: normalizarInstantePg2b1, mapearComprovante } = require('../src/services/comprovantes-contrato');

// Instante controlado, ver AGENTS.md / pacote da tarefa PG-2B1 (fechamento corretivo).
const INSTANTE = new Date('2026-01-10T12:34:56.000Z');
const ESPERADO_SQLITE = '2026-01-10T12:34:56Z';

test('DIFERENCIAL: precisao publica de timestamp coincide entre SQLite, PG-2A e PG-2B1', () => {
  const pg2a = normalizarInstantePg2a(INSTANTE);
  const pg2b1 = normalizarInstantePg2b1(INSTANTE);

  // Caso A — valor exato, nas tres trilhas.
  assert.equal(pg2a, ESPERADO_SQLITE);
  assert.equal(pg2b1, ESPERADO_SQLITE);

  // Caso E — diferencial real: PG-2A e PG-2B1 tem de concordar entre si, e com
  // o literal que o SQLite ja guarda (nao um regex, o mesmo valor).
  assert.equal(pg2a, pg2b1);
  assert.equal(pg2a, ESPERADO_SQLITE);

  // Caso B — tipo.
  assert.equal(typeof pg2a, 'string');
  assert.equal(typeof pg2b1, 'string');

  // Caso C — sem fracao de milissegundo no contrato publico.
  assert.ok(!pg2a.includes('.000Z'), `PG-2A vazou fracao: ${pg2a}`);
  assert.ok(!pg2b1.includes('.000Z'), `PG-2B1 vazou fracao: ${pg2b1}`);
});

test('DIFERENCIAL: criadoEm/atualizadoEm mapeados coincidem entre PG-2A e PG-2B1', () => {
  // Caso D — os dois campos de auditoria, nos dois mapeadores, com o MESMO Date.
  const associado = mapearAssociado({
    id: 1,
    legacy_id: '1',
    nome: 'Fulano',
    status_cadastral: 'ativo',
    legacy_status_code: null,
    observacoes: null,
    criado_em: INSTANTE,
    atualizado_em: INSTANTE,
  });

  const comprovante = mapearComprovante({
    id: 1,
    movimento_id: 1,
    estado: 'confirmado',
    observacao: null,
    referencia_externa: null,
    data: '2026-01-10',
    criado_em: INSTANTE,
    atualizado_em: INSTANTE,
  });

  assert.equal(associado.criadoEm, ESPERADO_SQLITE);
  assert.equal(associado.atualizadoEm, ESPERADO_SQLITE);
  assert.equal(comprovante.criadoEm, ESPERADO_SQLITE);
  assert.equal(comprovante.atualizadoEm, ESPERADO_SQLITE);

  assert.equal(associado.criadoEm, comprovante.criadoEm);
  assert.equal(associado.atualizadoEm, comprovante.atualizadoEm);

  assert.ok(!associado.criadoEm.includes('.000Z'));
  assert.ok(!comprovante.criadoEm.includes('.000Z'));
});
