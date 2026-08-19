'use strict';

/**
 * Comportamentos criticos do deploy de producao (ADR-005).
 *
 * Cada teste executa `scripts/deploy-production.sh` de verdade contra o sandbox
 * de tests/helpers/deploy-script.js. Nada aqui toca a VPS, o PostgreSQL de
 * producao ou o banco de teste — o script para no gate PG-6 e todo comando
 * externo e stub.
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
// Cenarios que chegam a trocar o symlink `current`; ver symlinkIndisponivel().
const pularTroca = pular || symlinkIndisponivel();

/** Roda o corpo com um sandbox proprio, sempre limpando ao final. */
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

function releasesExistentes(s) {
  return fs.existsSync(s.releases) ? fs.readdirSync(s.releases) : [];
}

test('T1: SHA malformado e recusado antes de qualquer efeito', { skip: pular }, comSandbox((s) => {
  for (const invalido of ['', 'main', 'HEAD', 'abc123', `${s.shaMain}x`, '; rm -rf /']) {
    const { codigo } = executarDeploy(s, invalido);
    assert.equal(codigo, 2, `esperava recusa para ${JSON.stringify(invalido)}`);
  }
  assert.equal(s.log('npm'), '', 'nenhum build pode ter comecado');
  assert.equal(s.log('backup'), '', 'nenhum backup pode ter sido chamado');
}));

test('T2: SHA que existe mas nao pertence a main e recusado', { skip: pular }, comSandbox((s) => {
  const { codigo, saida } = executarDeploy(s, s.shaFora);

  assert.equal(codigo, 5);
  assert.match(saida, /nao pertence a refs\/heads\/main/);
  assert.deepEqual(releasesExistentes(s), [], 'nada pode ter sido materializado');
  assert.equal(s.log('backup'), '', 'backup nao roda para revisao inelegivel');
  assert.doesNotMatch(s.log('npm'), /migrate:postgresql/, 'migration nao roda para revisao inelegivel');
}));

test('T3: SHA da main passa o gate e completa o deploy', { skip: pularTroca }, comSandbox((s) => {
  const { codigo, saida } = executarDeploy(s, s.shaMain);

  assert.equal(codigo, 0, saida);
  assert.equal(fs.realpathSync(s.current), fs.realpathSync(path.join(s.releases, s.shaMain)));
  assert.match(s.log('npm'), /migrate:postgresql/, 'migration roda antes da troca');
  assert.match(s.log('backup'), /chamado/, 'backup pre-deploy roda antes da migration');
  assert.match(s.log('sudo'), /restart aldeia\.service/);
}));

test('T4: build interrompido nao deixa release definitiva parcial', { skip: pular }, comSandbox((s) => {
  const { codigo } = executarDeploy(s, s.shaMain, { STUB_NPM_FALHA: 'build' });

  assert.notEqual(codigo, 0);
  assert.ok(!fs.existsSync(path.join(s.releases, s.shaMain)), 'release definitiva nao pode existir');
  assert.deepEqual(
    releasesExistentes(s).filter((n) => n.startsWith('.staging-')),
    [],
    'staging tem de ser limpo',
  );
  assert.equal(s.log('backup'), '', 'backup/migration nao chegam a acontecer');
}));

test('release existente sem selo e descartada; com selo e reutilizada', { skip: pularTroca }, comSandbox((s) => {
  // Sobra de deploy interrompido: diretorio com o nome definitivo, sem selo.
  const rel = path.join(s.releases, s.shaMain);
  fs.mkdirSync(rel, { recursive: true });
  fs.writeFileSync(path.join(rel, 'lixo-parcial.txt'), 'build interrompido\n');

  const primeiro = executarDeploy(s, s.shaMain);
  assert.equal(primeiro.codigo, 0, primeiro.saida);
  assert.match(primeiro.saida, /sem selo de integridade/);
  assert.ok(!fs.existsSync(path.join(rel, 'lixo-parcial.txt')), 'o parcial foi reconstruido');
  assert.ok(fs.existsSync(path.join(rel, '.aldeia-release-ok')), 'a release definitiva fica selada');

  // Release selada que nao e a ativa: reutilizada sem novo npm ci/build.
  fs.rmSync(s.current, { force: true });
  const npmAntes = s.log('npm');
  const segundo = executarDeploy(s, s.shaMain);
  assert.equal(segundo.codigo, 0, segundo.saida);
  assert.match(segundo.saida, /reutilizando sem reconstruir/);
  assert.equal(
    (s.log('npm').match(/ci /g) || []).length,
    (npmAntes.match(/ci /g) || []).length,
    'nao repete npm ci em release ja selada',
  );
}));

test('T5: redeploy do SHA ja ativo e idempotente e nao destroi a release', { skip: pularTroca }, comSandbox((s) => {
  assert.equal(executarDeploy(s, s.shaMain).codigo, 0);

  const rel = path.join(s.releases, s.shaMain);
  const sentinela = path.join(rel, 'prova-de-que-nao-foi-apagada.txt');
  fs.writeFileSync(sentinela, 'intacta\n');
  const backupAntes = s.log('backup');
  const npmAntes = s.log('npm');

  const { codigo, saida } = executarDeploy(s, s.shaMain);

  assert.equal(codigo, 0, saida);
  assert.match(saida, /idempotente/i);
  assert.ok(fs.existsSync(sentinela), 'a release ativa nao pode ter sido apagada/recriada');
  assert.ok(fs.existsSync(s.current), 'current tem de continuar existindo');
  assert.equal(fs.realpathSync(s.current), fs.realpathSync(rel));
  assert.equal(s.log('npm'), npmAntes, 'nao reconstroi nem remigra o que ja esta ativo');
  assert.equal(s.log('backup'), backupAntes, 'nao dispara backup novo sem necessidade');
}));

test('T6: health falho apos migration nao volta para a release anterior', { skip: pularTroca }, comSandbox((s) => {
  assert.equal(executarDeploy(s, s.shaMain).codigo, 0);
  const anterior = path.join(s.releases, s.shaMain);

  const shaNovo = s.novoCommitMain();
  const { codigo, saida } = executarDeploy(s, shaNovo, { STUB_HEALTH: 'falha' });
  const nova = path.join(s.releases, shaNovo);

  assert.equal(codigo, 9, saida);
  assert.equal(
    fs.realpathSync(s.current),
    fs.realpathSync(nova),
    'current NAO pode ter voltado para a release anterior',
  );
  assert.ok(fs.existsSync(anterior), 'release anterior preservada para intervencao');
  assert.ok(fs.existsSync(nova), 'release nova preservada para diagnostico');
  assert.match(s.log('sudo'), /stop aldeia\.service/, 'servico e parado para nao expor app defeituosa');
  assert.match(saida, new RegExp(shaNovo));
  assert.match(saida, new RegExp(s.shaMain));
  assert.match(saida, /backup pre-deploy: |backup pre-deploy:/);
  assert.match(saida, /runbook/i);
  assert.match(saida, /NAO houve rollback automatico/);
}));

test('T7: sem ferramenta de backup nenhuma migration comeca', { skip: pular }, comSandbox((s) => {
  const semBackup = { ...s.env, ALDEIA_BACKUP_CMD: `${s.env.ALDEIA_BACKUP_CMD}-inexistente` };
  const original = s.env;
  Object.assign(s, { env: semBackup });

  const { codigo, saida } = executarDeploy(s, s.shaMain);
  Object.assign(s, { env: original });

  assert.equal(codigo, 7, saida);
  assert.doesNotMatch(s.log('npm'), /migrate:postgresql/, 'migration nao pode ter rodado');
  assert.ok(!fs.existsSync(s.current), 'release ativa nao pode ter sido trocada');
}));

test('T8: backup que falha (ou nao produz dump) impede a migration', { skip: pular }, comSandbox((s) => {
  const falho = executarDeploy(s, s.shaMain, { STUB_BACKUP: 'falha' });
  assert.equal(falho.codigo, 7, falho.saida);
  assert.doesNotMatch(s.log('npm'), /migrate:postgresql/);
  assert.ok(!fs.existsSync(s.current));

  const vazio = executarDeploy(s, s.shaMain, { STUB_BACKUP: 'vazio' });
  assert.equal(vazio.codigo, 7, vazio.saida);
  assert.match(vazio.saida, /nao produziu arquivo novo e nao vazio/);
  assert.doesNotMatch(s.log('npm'), /migrate:postgresql/);
  assert.ok(!fs.existsSync(s.current));
}));

test('gate PG-6: revisao sem migrate:postgresql nao troca release', { skip: pular }, comSandbox((s) => {
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
  assert.match(saida, /PG-6/);
  assert.ok(!fs.existsSync(s.current), 'nenhuma release pode ter sido ativada');
}));
