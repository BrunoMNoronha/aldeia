#!/usr/bin/env bash
# Deploy de producao — executa NA VPS, como usuario `aldeia`, nunca como root.
# Instalado em /opt/aldeia/deploy-production.sh (copia do template versionado;
# alteracoes aqui exigem reinstalacao — ver docs/runbook/production.md).
#
# Uso: deploy-production.sh <sha-40-hex>
#
# Contrato:
#  - o UNICO parametro aceito e um SHA Git completo (o GITHUB_SHA do workflow);
#  - release imutavel em /opt/aldeia/releases/<sha>, ativada por troca atomica
#    do symlink `current`;
#  - migrations PostgreSQL sao OBRIGATORIAS antes da troca: se o script npm
#    `migrate:postgresql` nao existir, o deploy FALHA (gate PG-6, ADR-003).
#    Nunca chamar `npm run migrate` aqui: esse e o migrator SQLite;
#  - health check em http://127.0.0.1:3000/health decide sucesso; em falha, o
#    symlink volta para a release anterior (rollback de CODIGO apenas — uma
#    migration ja aplicada pode torna-la incompativel; ver runbook).
set -euo pipefail

REPO_URL="https://github.com/BrunoMNoronha/aldeia.git"
BASE=/opt/aldeia
REPO_DIR="$BASE/repo"
RELEASES="$BASE/releases"
CURRENT="$BASE/current"
LOCK="$BASE/.deploy.lock"
HISTORY="$BASE/shared/deploy-history.log"
HEALTH_URL="http://127.0.0.1:3000/health"
KEEP_RELEASES=5

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

SHA="${1:-}"
if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "ERRO: parametro deve ser um SHA Git completo (40 hex)." >&2
  exit 2
fi

# Serializa deploys: dois deploys simultaneos nunca tocam a VPS ao mesmo tempo.
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "ERRO: outro deploy em andamento (lock $LOCK)." >&2
  exit 3
fi

log "deploy iniciado: $SHA"

if [[ ! -d "$REPO_DIR/refs" && ! -d "$REPO_DIR/.git" ]]; then
  git clone --bare "$REPO_URL" "$REPO_DIR"
fi
git -C "$REPO_DIR" fetch origin '+refs/heads/*:refs/heads/*' --prune
if ! git -C "$REPO_DIR" cat-file -e "$SHA^{commit}"; then
  echo "ERRO: SHA $SHA nao existe no repositorio oficial." >&2
  exit 4
fi

REL="$RELEASES/$SHA"
rm -rf "$REL"
mkdir -p "$REL" "$BASE/shared"
git -C "$REPO_DIR" archive "$SHA" | tar -x -C "$REL"

cd "$REL"
npm ci --no-audit --no-fund
npm run build

# Backup pre-deploy: antes de qualquer migration sobre o banco de producao.
if [[ -x /usr/local/bin/aldeia-backup-postgresql ]]; then
  /usr/local/bin/aldeia-backup-postgresql
else
  log "AVISO: backup pre-deploy indisponivel (/usr/local/bin/aldeia-backup-postgresql ausente)"
fi

# Gate PG-6: sem migrator PostgreSQL oficial nao ha deploy de producao.
if node -e "const s=require('./package.json').scripts||{};process.exit(s['migrate:postgresql']?0:1)"; then
  set -a
  # shellcheck disable=SC1091
  source /etc/aldeia/aldeia.env
  set +a
  npm run migrate:postgresql
else
  echo "ERRO: script npm 'migrate:postgresql' ausente na revisao $SHA." >&2
  echo "O cutover PG-6 (ADR-003) ainda nao esta consolidado; deploy abortado" >&2
  echo "antes de qualquer troca de release. Nao contornar este gate." >&2
  exit 5
fi

PREV="$(readlink -f "$CURRENT" 2>/dev/null || true)"
ln -sfn "$REL" "$CURRENT.tmp"
mv -T "$CURRENT.tmp" "$CURRENT"
sudo -n /usr/bin/systemctl restart aldeia.service

ok=0
for _ in $(seq 1 30); do
  if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done

if [[ "$ok" -ne 1 ]]; then
  log "HEALTH FALHOU para $SHA"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) FALHA $SHA" >>"$HISTORY"
  if [[ -n "$PREV" && -d "$PREV" && "$PREV" != "$REL" ]]; then
    ln -sfn "$PREV" "$CURRENT.tmp"
    mv -T "$CURRENT.tmp" "$CURRENT"
    sudo -n /usr/bin/systemctl restart aldeia.service
    log "rollback de codigo para $(basename "$PREV"); compatibilidade com migrations ja aplicadas deve ser verificada manualmente (runbook)"
  fi
  exit 6
fi

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) OK $SHA" >>"$HISTORY"

# Rotacao: somente depois do sucesso, preservando as ultimas KEEP_RELEASES.
find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -rn | awk -v k="$KEEP_RELEASES" 'NR > k { print $2 }' \
  | while read -r old; do
      [[ "$old" == "$(readlink -f "$CURRENT")" ]] && continue
      rm -rf "$old"
    done

log "deploy concluido com sucesso: $SHA"
