'use strict';

/**
 * Contrato do workflow de producao (ADR-004/ADR-005).
 *
 * O YAML nao roda em `node --test`, mas as garantias que dependem dele sao
 * verificaveis por inspecao: quem pode alcancar a VPS, e o que reprova a
 * validacao. Sao exatamente as regressoes que um "ajuste rapido" no workflow
 * poderia reintroduzir sem ninguem notar.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = path.resolve(__dirname, '..', '.github', 'workflows', 'deploy-production.yml');
const yaml = fs.readFileSync(WORKFLOW, 'utf8');

/** Divide o YAML nos blocos de step (`      - name:` / `      - uses:`). */
function steps() {
  return yaml
    .split(/\n(?= {6}- (?:name|uses|run):)/)
    .filter((bloco) => /^ {6}- /.test(bloco));
}

test('dispara em push na main, serializado e com permissao minima', () => {
  assert.match(yaml, /on:\s*\n\s*push:\s*\n\s*branches:\s*\n\s*- main/);
  assert.match(yaml, /concurrency:\s*\n\s*group: production-deploy\s*\n\s*cancel-in-progress: false/);
  assert.match(yaml, /permissions:\s*\n\s*contents: read/);
  assert.doesNotMatch(yaml, /permissions:[\s\S]*?write/, 'nenhuma permissao de escrita');
});

test('T9: CI reprova quando a suite tem teste pulado', () => {
  const gate = steps().find((s) => /skipped/.test(s));
  assert.ok(gate, 'existe um step que examina a contagem de testes pulados');
  assert.match(gate, /"\$skipped" -ne 0/, 'compara a contagem com zero');
  assert.match(gate, /exit 1/, 'e reprova o job');
  // Fail-closed: resumo ilegivel tambem reprova, em vez de virar "0 pulados".
  assert.match(gate, /-z "\$skipped"[\s\S]*?exit 1/);
  assert.doesNotMatch(gate, /\|\| echo 0/, 'nao pode assumir zero silenciosamente');
  assert.match(gate, /GITHUB_STEP_SUMMARY/, 'preserva o resumo da suite');

  const testes = steps().find((s) => /npm test/.test(s));
  assert.match(testes, /set -o pipefail/, 'sem pipefail o `tee` mascara a falha do npm test');
});

test('T10: somente a main pode alcancar a VPS', () => {
  const recusa = steps().find((s) => /Gate de ref/.test(s));
  assert.ok(recusa, 'existe um gate de ref explicito');
  assert.match(recusa, /vars\.PROD_DEPLOY_ENABLED == 'true' && github\.ref != 'refs\/heads\/main'/);
  assert.match(recusa, /exit 1/, 'disparo manual fora da main reprova, nao faz deploy silencioso');

  const comAcessoRemoto = steps().filter((s) => /secrets\.PROD_SSH|ssh \\|deploy-production\.sh/.test(s));
  assert.ok(comAcessoRemoto.length >= 3, 'os steps que tocam a VPS foram encontrados');
  for (const step of comAcessoRemoto) {
    const nome = (step.match(/- name: (.+)/) || [])[1] || step.slice(0, 40);
    assert.match(step, /if: vars\.PROD_DEPLOY_ENABLED == 'true'/, `step sem gate de deploy: ${nome}`);
    assert.match(step, /github\.ref == 'refs\/heads\/main'/, `step sem gate de main: ${nome}`);
  }
});

test('a VPS recebe apenas o GITHUB_SHA, com host key verificada', () => {
  assert.match(yaml, /StrictHostKeyChecking=yes/);
  assert.doesNotMatch(yaml, /StrictHostKeyChecking=no/);
  assert.match(yaml, /deploy-production\.sh '\$GITHUB_SHA'/, 'unico parametro externo e o SHA');
  assert.match(yaml, /test "\$ativo" = "\$GITHUB_SHA"/, 'confere o SHA que ficou ativo');
});

test('nenhum segredo literal no workflow', () => {
  assert.doesNotMatch(yaml, /BEGIN [A-Z ]*PRIVATE KEY/);
  assert.doesNotMatch(yaml, /postgresql:\/\/(?!aldeia_ci:aldeia_ci@127\.0\.0\.1)/);
  for (const secret of ['PROD_SSH_HOST', 'PROD_SSH_PORT', 'PROD_SSH_USER', 'PROD_SSH_PRIVATE_KEY']) {
    assert.match(yaml, new RegExp(`secrets\\.${secret}`), `${secret} vem de secrets`);
  }
});
