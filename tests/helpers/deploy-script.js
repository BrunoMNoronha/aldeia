'use strict';

/**
 * Harness do `scripts/deploy-production.sh` (ADR-005).
 *
 * O script de deploy roda na VPS e toca banco, systemd e disco. Para poder
 * prova-lo sem VPS, o proprio script aceita overrides `ALDEIA_*` (documentados
 * no seu cabecalho) e este harness monta um mundo falso:
 *
 *  - um repositorio Git REAL (nao stub) com um commit na `main` e outro fora
 *    dela — a checagem de ancestralidade e exercitada de verdade;
 *  - stubs executaveis de `npm`, `curl`, `sudo`, `flock` e do comando de backup,
 *    todos registrando o que foi chamado, para que o teste afirme sobre o que o
 *    deploy fez (e sobre o que ele NAO fez).
 *
 * Nada aqui toca PostgreSQL: o gate PG-6 do script para antes disso, e o stub
 * de `npm` cobre `migrate:postgresql`.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(RAIZ, 'scripts', 'deploy-production.sh');

/** Caminho no formato que o bash do harness entende (`C:\x` -> `/c/x`). */
function paraPosix(p) {
  if (process.platform !== 'win32') return p;
  return p.replace(/^([A-Za-z]):/, (_, letra) => `/${letra.toLowerCase()}`).replace(/\\/g, '/');
}

/** `bash` utilizavel? Sem ele (Windows sem Git Bash) os testes sao pulados. */
function bashIndisponivel() {
  const r = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() === 'ok' ? false : 'bash indisponivel neste ambiente';
}

/**
 * Symlink POSIX de verdade? A troca de release depende dele. No Git Bash sem
 * privilegio de criacao de link o `ln -s` COPIA o diretorio, entao os cenarios
 * que trocam `current` so podem ser provados onde o symlink e real — o que
 * inclui o CI (ubuntu) e a propria VPS.
 */
function symlinkIndisponivel() {
  if (bashIndisponivel()) return 'bash indisponivel neste ambiente';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aldeia-symlink-'));
  try {
    const r = spawnSync('bash', ['-c', 'mkdir -p a && ln -sfn a l && [[ -L l ]]'], { cwd: dir });
    return r.status === 0 ? false : 'symlink POSIX indisponivel (Windows sem privilegio de symlink)';
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} falhou: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim();
}

function escreverStub(destino, corpo) {
  fs.writeFileSync(destino, `#!/usr/bin/env bash\n${corpo}\n`, { mode: 0o755 });
  fs.chmodSync(destino, 0o755);
}

/**
 * Monta o sandbox e devolve o contexto usado pelos testes.
 *
 * @returns {{
 *   dir: string, base: string, releases: string, current: string,
 *   backups: string, bin: string, shaMain: string, shaFora: string,
 *   env: Record<string,string>, log: (nome: string) => string,
 *   novoCommitMain: () => string,
 * }}
 */
function criarSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aldeia-deploy-'));
  const origem = path.join(dir, 'origem');
  const base = path.join(dir, 'base');
  const bin = path.join(dir, 'bin');
  const backups = path.join(dir, 'backups');
  const logs = path.join(dir, 'logs');

  for (const d of [origem, base, bin, backups, logs]) fs.mkdirSync(d, { recursive: true });

  // Repositorio de origem real, com `main` e uma branch lateral nao mergeada.
  git(origem, ['init', '-q', '--initial-branch=main']);
  fs.writeFileSync(
    path.join(origem, 'package.json'),
    `${JSON.stringify(
      { name: 'fake', version: '1.0.0', scripts: { build: 'true', 'migrate:postgresql': 'true' } },
      null,
      2,
    )}\n`,
  );
  git(origem, ['add', '-A']);
  git(origem, ['commit', '-qm', 'commit na main']);
  const shaMain = git(origem, ['rev-parse', 'HEAD']);

  git(origem, ['checkout', '-q', '-b', 'lateral']);
  fs.writeFileSync(path.join(origem, 'lateral.txt'), 'fora da main\n');
  git(origem, ['add', '-A']);
  git(origem, ['commit', '-qm', 'commit fora da main']);
  const shaFora = git(origem, ['rev-parse', 'HEAD']);
  git(origem, ['checkout', '-q', 'main']);

  const envFile = path.join(dir, 'aldeia.env');
  fs.writeFileSync(envFile, 'DATABASE_URL=postgresql://fake:fake@127.0.0.1:5432/fake\n');

  const logsPosix = paraPosix(logs);
  const backupsPosix = paraPosix(backups);

  // Stubs. Cada um registra a chamada; o comportamento e ditado por variaveis
  // que o proprio teste define na execucao (STUB_*).
  escreverStub(
    path.join(bin, 'npm'),
    `echo "$*" >> "${logsPosix}/npm.log"
if [[ "\${STUB_NPM_FALHA:-}" == "$1" ]]; then exit 1; fi
if [[ "\${STUB_NPM_FALHA:-}" == "$2" ]]; then exit 1; fi
exit 0`,
  );
  escreverStub(
    path.join(bin, 'curl'),
    `echo "$*" >> "${logsPosix}/curl.log"
[[ "\${STUB_HEALTH:-ok}" == "ok" ]] || exit 7
exit 0`,
  );
  escreverStub(
    path.join(bin, 'sudo'),
    `echo "$*" >> "${logsPosix}/sudo.log"
exit 0`,
  );
  escreverStub(path.join(bin, 'flock'), 'exit 0');
  escreverStub(
    path.join(bin, 'backup'),
    `echo "chamado" >> "${logsPosix}/backup.log"
[[ "\${STUB_BACKUP:-ok}" == "falha" ]] && exit 1
if [[ "\${STUB_BACKUP:-ok}" == "vazio" ]]; then
  : > "${backupsPosix}/aldeia_producao_$(date -u +%Y%m%dT%H%M%S)_$RANDOM.dump"
  exit 0
fi
echo "conteudo" > "${backupsPosix}/aldeia_producao_$(date -u +%Y%m%dT%H%M%S)_$RANDOM.dump"
exit 0`,
  );

  const env = {
    ALDEIA_REPO_URL: paraPosix(origem),
    ALDEIA_BASE: paraPosix(base),
    ALDEIA_ENV_FILE: paraPosix(envFile),
    ALDEIA_BACKUP_CMD: paraPosix(path.join(bin, 'backup')),
    ALDEIA_BACKUP_DIR: backupsPosix,
    ALDEIA_HEALTH_URL: 'http://127.0.0.1:3000/health',
    ALDEIA_HEALTH_TRIES: '2',
    ALDEIA_HEALTH_INTERVAL: '0',
    ALDEIA_MAIN_REF: 'refs/heads/main',
  };

  return {
    dir,
    origem,
    base,
    bin,
    logs,
    backups,
    releases: path.join(base, 'releases'),
    current: path.join(base, 'current'),
    shaMain,
    shaFora,
    env,
    log(nome) {
      const p = path.join(logs, `${nome}.log`);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    },
    novoCommitMain() {
      fs.appendFileSync(path.join(origem, 'package.json'), '');
      fs.writeFileSync(path.join(origem, `mudanca-${Date.now()}.txt`), 'x\n');
      git(origem, ['add', '-A']);
      git(origem, ['commit', '-qm', 'outro commit na main']);
      return git(origem, ['rev-parse', 'HEAD']);
    },
    limpar() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Executa o script de deploy dentro do sandbox.
 *
 * @param {ReturnType<typeof criarSandbox>} s
 * @param {string} sha
 * @param {Record<string,string>} [extra] variaveis STUB_* do cenario
 */
function executarDeploy(s, sha, extra = {}) {
  const r = spawnSync('bash', [paraPosix(SCRIPT), sha], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${s.bin}${path.delimiter}${process.env.PATH}`,
      ...s.env,
      ...extra,
    },
  });
  return { codigo: r.status, saida: `${r.stdout || ''}${r.stderr || ''}` };
}

module.exports = {
  bashIndisponivel,
  symlinkIndisponivel,
  criarSandbox,
  executarDeploy,
  paraPosix,
  SCRIPT,
  RAIZ,
};
