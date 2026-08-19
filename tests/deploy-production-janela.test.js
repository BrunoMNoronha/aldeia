'use strict';

/**
 * Janela de manutencao e fail-safe pos-migration (ADR-006).
 *
 * O que estes testes protegem, em uma frase: codigo antigo nunca atende
 * requests enquanto o schema muda, e nenhuma falha depois do inicio das
 * migrations religa a release anterior.
 *
 * Usam o mesmo harness de tests/helpers/deploy-script.js — o `systemctl` falso
 * mantem o estado do servico e o `curl` falso so responde quando esse estado e
 * `active`, de modo que "parei a aplicacao" e uma observacao, nao uma promessa.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  bashIndisponivel,
  symlinkIndisponivel,
  criarSandbox,
  executarDeploy,
} = require('./helpers/deploy-script');

const pular = bashIndisponivel();
const pularTroca = pular || symlinkIndisponivel();

function comSandbox(fn) {
  return () => {
    const s = criarSandbox();
    try {
      fn(s);
    } finally {
      s.limpar();
    }
  };
}

/** Posicao do primeiro evento que casa com o padrao (-1 se nao ocorreu). */
function primeiro(eventos, padrao) {
  return eventos.findIndex((e) => padrao.test(e));
}
function ultimo(eventos, padrao) {
  return eventos.reduce((acc, e, i) => (padrao.test(e) ? i : acc), -1);
}

/** Deixa o sandbox com uma release ativa e saudavel, e zera os registros. */
function comDeployAnterior(s) {
  const r = executarDeploy(s, s.shaMain);
  assert.equal(r.codigo, 0, r.saida);
  assert.equal(s.servico(), 'active');
  s.limparRegistros();
  return path.join(s.releases, s.shaMain);
}

test('M1: a migration so acontece com a aplicacao ja parada', { skip: pularTroca }, comSandbox((s) => {
  const { codigo, saida } = executarDeploy(s, s.shaMain);
  assert.equal(codigo, 0, saida);

  const e = s.eventos();
  const iBuild = primeiro(e, /^npm run build/);
  const iStop = primeiro(e, /^systemctl stop/);
  const iBackup = primeiro(e, /^backup/);
  const iMigrate = primeiro(e, /migrate:postgresql/);
  const iLn = primeiro(e, /^ln/);
  const iRestart = primeiro(e, /^systemctl restart/);
  const iHealth = ultimo(e, /^curl/);

  for (const [nome, i] of Object.entries({ iBuild, iStop, iBackup, iMigrate, iLn, iRestart, iHealth })) {
    assert.ok(i >= 0, `evento ausente: ${nome}`);
  }
  assert.ok(iBuild < iStop, 'o build acontece FORA da janela, com a aplicacao no ar');
  assert.ok(iStop < iBackup, 'o backup so comeca depois de parar a aplicacao');
  assert.ok(iBackup < iMigrate, 'a migration so comeca depois do backup quiescente');
  assert.ok(iMigrate < iLn, 'a troca de release vem depois da migration');
  assert.ok(iLn < iRestart, 'o restart vem depois da troca');
  assert.ok(iRestart < iHealth, 'o health e o ultimo passo');
  assert.match(s.historico(), /JANELA-INICIO/);
  assert.match(s.historico(), /JANELA-FIM/);
}));

test('M2: migrator ausente reprova sem abrir janela de manutencao', { skip: pular }, comSandbox((s) => {
  const pkg = path.join(s.origem, 'package.json');
  const conteudo = JSON.parse(fs.readFileSync(pkg, 'utf8'));
  delete conteudo.scripts['migrate:postgresql'];
  fs.writeFileSync(pkg, `${JSON.stringify(conteudo, null, 2)}\n`);
  const { spawnSync } = require('node:child_process');
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-aqm', 'sem migrator'], {
    cwd: s.origem,
  });
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: s.origem, encoding: 'utf8' }).stdout.trim();

  const { codigo, saida } = executarDeploy(s, sha);

  assert.equal(codigo, 6, saida);
  assert.equal(primeiro(s.eventos(), /^systemctl stop/), -1, 'o servico nao pode ter sido parado');
  assert.equal(s.log('backup'), '', 'backup nao roda');
  assert.doesNotMatch(s.log('npm'), /migrate:postgresql/, 'migration nao roda');
}));

test('M3: ferramenta de backup ausente reprova antes da indisponibilidade', { skip: pular }, comSandbox((s) => {
  const original = s.env;
  Object.assign(s, { env: { ...original, ALDEIA_BACKUP_CMD: `${original.ALDEIA_BACKUP_CMD}-inexistente` } });
  const { codigo, saida } = executarDeploy(s, s.shaMain);
  Object.assign(s, { env: original });

  assert.equal(codigo, 7, saida);
  assert.match(saida, /Nenhuma janela de manutencao foi aberta/);
  assert.equal(primeiro(s.eventos(), /^systemctl stop/), -1, 'nao para a aplicacao por um gate previsivel');
  assert.doesNotMatch(s.log('npm'), /migrate:postgresql/);
}));

test('M3b: env file ilegivel tambem reprova antes da janela', { skip: pular }, comSandbox((s) => {
  const original = s.env;
  Object.assign(s, { env: { ...original, ALDEIA_ENV_FILE: `${original.ALDEIA_ENV_FILE}-inexistente` } });
  const { codigo, saida } = executarDeploy(s, s.shaMain);
  Object.assign(s, { env: original });

  assert.equal(codigo, 12, saida);
  assert.equal(primeiro(s.eventos(), /^systemctl stop/), -1);
}));

test('M4: backup falho antes da migration religa a release anterior', { skip: pularTroca }, comSandbox((s) => {
  const anterior = comDeployAnterior(s);

  const shaNovo = s.novoCommitMain();
  const { codigo, saida } = executarDeploy(s, shaNovo, { STUB_BACKUP: 'falha' });

  assert.equal(codigo, 7, saida);
  assert.doesNotMatch(s.log('npm'), /migrate:postgresql/, 'nenhuma migration foi executada');
  assert.equal(fs.realpathSync(s.current), fs.realpathSync(anterior), 'current permanece na release anterior');
  assert.equal(s.servico(), 'active', 'a release anterior volta a atender');
  assert.match(s.historico(), /RESTAURADO-PRE-MIGRATION/);
  assert.match(saida, /ANTES de qualquer migration/);

  const e = s.eventos();
  assert.ok(primeiro(e, /^systemctl stop/) < primeiro(e, /^backup/), 'a falha ocorreu dentro da janela');
  assert.ok(ultimo(e, /^systemctl restart/) > primeiro(e, /^backup/), 'o servico anterior foi religado');
  assert.ok(ultimo(e, /^curl/) > ultimo(e, /^systemctl restart/), 'o health da release anterior foi conferido');
}));

test('M5: migration falha nao religa a release anterior', { skip: pularTroca }, comSandbox((s) => {
  const anterior = comDeployAnterior(s);

  const shaNovo = s.novoCommitMain();
  const { codigo, saida } = executarDeploy(s, shaNovo, { STUB_NPM_FALHA: 'migrate:postgresql' });

  assert.equal(codigo, 8, saida);
  assert.equal(s.servico(), 'inactive', 'producao fica PARADA depois de migration falha');
  assert.equal(primeiro(s.eventos(), /^systemctl restart/), -1, 'nada foi religado automaticamente');
  assert.equal(fs.realpathSync(s.current), fs.realpathSync(anterior), 'current nao foi trocado');
  assert.ok(fs.existsSync(anterior), 'release anterior preservada');
  assert.ok(fs.existsSync(path.join(s.releases, shaNovo)), 'release nova preservada como evidencia');
  assert.match(s.historico(), /MIGRATION-INICIO/);
  assert.match(s.historico(), /FALHA-POS-MIGRATION/);
  assert.match(saida, /deixada PARADA deliberadamente/);
  assert.match(saida, /NENHUMA migration foi revertida/);
}));

test('M6: falha ao trocar o symlink deixa o servico parado', { skip: pularTroca }, comSandbox((s) => {
  const anterior = comDeployAnterior(s);

  const shaNovo = s.novoCommitMain();
  const { codigo, saida } = executarDeploy(s, shaNovo, { STUB_LN: 'falha' });

  assert.notEqual(codigo, 0);
  assert.match(s.log('npm'), /migrate:postgresql/, 'a migration chegou a rodar');
  assert.equal(s.servico(), 'inactive', 'fail-safe global: servico parado');
  assert.equal(primeiro(s.eventos(), /^systemctl restart/), -1, 'nenhum rollback automatico');
  assert.equal(fs.realpathSync(s.current), fs.realpathSync(anterior));
  assert.match(saida, /fase 'troca da release'|falha em 'troca da release'/);
  assert.match(saida, /deixada PARADA deliberadamente/);
}));

test('M7: falha no restart deixa o servico parado', { skip: pularTroca }, comSandbox((s) => {
  comDeployAnterior(s);

  const shaNovo = s.novoCommitMain();
  const { codigo, saida } = executarDeploy(s, shaNovo, { STUB_RESTART: 'falha' });

  assert.notEqual(codigo, 0);
  assert.equal(s.servico(), 'inactive', 'servico termina parado');
  assert.match(saida, /falha em 'restart do servico'/);
  assert.match(saida, /deixada PARADA deliberadamente/);
  assert.match(s.historico(), /FALHA-POS-MIGRATION/);
  // A release nova chegou a ser ativada antes do restart falhar: preservada.
  assert.equal(fs.realpathSync(s.current), fs.realpathSync(path.join(s.releases, shaNovo)));
}));

test('M8: health falho mantem o comportamento seguro do ADR-005', { skip: pularTroca }, comSandbox((s) => {
  const anterior = comDeployAnterior(s);

  const shaNovo = s.novoCommitMain();
  const { codigo, saida } = executarDeploy(s, shaNovo, { STUB_HEALTH: 'falha' });

  assert.equal(codigo, 9, saida);
  assert.equal(s.servico(), 'inactive');
  assert.equal(fs.realpathSync(s.current), fs.realpathSync(path.join(s.releases, shaNovo)));
  assert.ok(fs.existsSync(anterior), 'release anterior preservada');
  assert.match(saida, /NAO houve rollback automatico/);
}));

test('M9: caminho feliz ativa a release nova e deixa o servico no ar', { skip: pularTroca }, comSandbox((s) => {
  comDeployAnterior(s);

  const shaNovo = s.novoCommitMain();
  const { codigo, saida } = executarDeploy(s, shaNovo);

  assert.equal(codigo, 0, saida);
  assert.equal(fs.realpathSync(s.current), fs.realpathSync(path.join(s.releases, shaNovo)));
  assert.equal(s.servico(), 'active');
  assert.match(s.historico(), new RegExp(`OK ${shaNovo}`));
  assert.match(saida, /deploy concluido com sucesso/);
}));

test('M10: redeploy do SHA ativo nao abre janela de manutencao', { skip: pularTroca }, comSandbox((s) => {
  comDeployAnterior(s);

  const { codigo, saida } = executarDeploy(s, s.shaMain);

  assert.equal(codigo, 0, saida);
  assert.equal(s.servico(), 'active', 'a aplicacao nunca sai do ar');
  const e = s.eventos();
  assert.equal(primeiro(e, /^systemctl stop/), -1, 'nao para o servico');
  assert.equal(primeiro(e, /^backup/), -1, 'nao refaz backup');
  assert.equal(primeiro(e, /migrate:postgresql/), -1, 'nao repete migration');
  assert.equal(primeiro(e, /^ln/), -1, 'nao troca symlink');
  assert.match(saida, /idempotente/i);
}));
