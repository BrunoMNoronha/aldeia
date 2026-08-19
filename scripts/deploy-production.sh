#!/usr/bin/env bash
# Deploy de producao — executa NA VPS, como usuario `aldeia`, nunca como root.
# Instalado em /opt/aldeia/deploy-production.sh (copia do template versionado;
# alteracoes aqui exigem reinstalacao — ver docs/runbook/production.md).
#
# Uso: deploy-production.sh <sha-40-hex>
#
# Contrato (ADR-004, endurecido pelo ADR-005):
#  - o UNICO parametro aceito e um SHA Git completo (o GITHUB_SHA do workflow),
#    que precisa existir E pertencer a `main` oficial (fail-closed);
#  - release em /opt/aldeia/releases/<sha> e IMUTAVEL: nunca e apagada nem
#    sobrescrita como etapa de deploy. Build novo acontece em staging e so vira
#    release definitiva depois de completo (promocao atomica);
#  - migrations PostgreSQL sao OBRIGATORIAS antes da troca, e so rodam depois de
#    um backup pre-deploy comprovado. Se o script npm `migrate:postgresql` nao
#    existir, o deploy FALHA (gate PG-6, ADR-003). Nunca chamar `npm run
#    migrate` aqui: esse e o migrator SQLite;
#  - health check decide sucesso. Em falha NAO existe rollback automatico: uma
#    migration ja aplicada pode tornar a release anterior incompativel com o
#    schema novo. O script para o servico (impede expor aplicacao defeituosa),
#    preserva current/releases/backup/logs e falha para intervencao humana.
#
# Codigos de saida: 2 SHA malformado | 3 lock | 4 SHA inexistente | 5 SHA fora
# da main | 6 migrator PostgreSQL ausente | 7 backup pre-deploy fail-closed |
# 8 migration falhou | 9 health falhou (estado preservado) | 10 redeploy do SHA
# ja ativo com health ruim.
set -euo pipefail

# Overrides existem EXCLUSIVAMENTE para os testes automatizados do repositorio
# (tests/deploy-production-script.test.js). O deploy real nunca define nenhuma
# delas: o workflow abre a sessao SSH com comando fixo e sem encaminhar ambiente.
REPO_URL="${ALDEIA_REPO_URL:-https://github.com/BrunoMNoronha/aldeia.git}"
BASE="${ALDEIA_BASE:-/opt/aldeia}"
ENV_FILE="${ALDEIA_ENV_FILE:-/etc/aldeia/aldeia.env}"
BACKUP_CMD="${ALDEIA_BACKUP_CMD:-/usr/local/bin/aldeia-backup-postgresql}"
BACKUP_DIR="${ALDEIA_BACKUP_DIR:-/var/backups/aldeia/postgresql}"
HEALTH_URL="${ALDEIA_HEALTH_URL:-http://127.0.0.1:3000/health}"
HEALTH_TRIES="${ALDEIA_HEALTH_TRIES:-30}"
HEALTH_INTERVAL="${ALDEIA_HEALTH_INTERVAL:-2}"
MAIN_REF="${ALDEIA_MAIN_REF:-refs/heads/main}"
KEEP_RELEASES="${ALDEIA_KEEP_RELEASES:-5}"

REPO_DIR="$BASE/repo"
RELEASES="$BASE/releases"
CURRENT="$BASE/current"
LOCK="$BASE/.deploy.lock"
HISTORY="$BASE/shared/deploy-history.log"
# Marcador gravado no fim do build: uma release so e reutilizavel se o tiver.
SELO=".aldeia-release-ok"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
erro() { printf '%s ERRO: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
registrar() { mkdir -p "$(dirname "$HISTORY")"; printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >>"$HISTORY"; }

STAGING=""
limpar_staging() {
  # So remove o proprio diretorio de staging (nome contem o pid desta execucao).
  if [[ -n "$STAGING" && -d "$STAGING" ]]; then
    rm -rf "$STAGING"
  fi
}
trap limpar_staging EXIT

SHA="${1:-}"
if ! [[ "$SHA" =~ ^[0-9a-f]{40}$ ]]; then
  erro "parametro deve ser um SHA Git completo (40 hex)."
  exit 2
fi

mkdir -p "$RELEASES" "$BASE/shared"

# Serializa deploys: dois deploys simultaneos nunca tocam a VPS ao mesmo tempo.
exec 9>"$LOCK"
if ! flock -n 9; then
  erro "outro deploy em andamento (lock $LOCK)."
  exit 3
fi

log "deploy iniciado: $SHA"

if [[ ! -d "$REPO_DIR/refs" && ! -d "$REPO_DIR/.git" ]]; then
  git clone --bare "$REPO_URL" "$REPO_DIR"
fi
git -C "$REPO_DIR" fetch origin '+refs/heads/*:refs/heads/*' --prune

if ! git -C "$REPO_DIR" cat-file -e "$SHA^{commit}" 2>/dev/null; then
  erro "SHA $SHA nao existe no repositorio oficial."
  exit 4
fi

# Producao recebe SOMENTE codigo incorporado a main. Existir no repositorio nao
# basta: um commit de branch/PR nao mergeado tambem existe. Fail-closed — se a
# ref da main nao puder ser resolvida, o deploy para aqui.
if ! git -C "$REPO_DIR" rev-parse --verify --quiet "$MAIN_REF^{commit}" >/dev/null; then
  erro "nao foi possivel resolver $MAIN_REF no repositorio oficial."
  exit 5
fi
if ! git -C "$REPO_DIR" merge-base --is-ancestor "$SHA" "$MAIN_REF"; then
  erro "SHA $SHA nao pertence a $MAIN_REF: producao recebe somente codigo incorporado a main."
  exit 5
fi

REL="$RELEASES/$SHA"
ATUAL="$(readlink -f "$CURRENT" 2>/dev/null || true)"

# --- Caso 3: o SHA pedido ja e o ativo. Reexecucao idempotente. --------------
# Nada e apagado, reconstruido ou migrado de novo; apenas confirmamos que o que
# esta no ar responde. Migration ja foi aplicada por este mesmo SHA.
if [[ -n "$ATUAL" && "$ATUAL" == "$REL" ]]; then
  log "release $SHA ja esta ativa; deploy tratado como reexecucao idempotente."
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      registrar "OK-IDEMPOTENTE $SHA"
      log "release ativa saudavel; nada a fazer."
      exit 0
    fi
    sleep "$HEALTH_INTERVAL"
  done
  registrar "FALHA-IDEMPOTENTE $SHA"
  erro "release $SHA ja e a ativa, mas o health check nao responde."
  erro "Nada foi alterado. Investigar com o runbook (docs/runbook/production.md)."
  exit 10
fi

# --- Caso 2: release ja existe e nao e a ativa. -------------------------------
if [[ -d "$REL" ]]; then
  if [[ -f "$REL/$SELO" && "$(cat "$REL/$SELO")" == "$SHA" ]]; then
    log "release $SHA ja existe e esta selada; reutilizando sem reconstruir."
  else
    # Sobra de um deploy interrompido: nunca e a release ativa (o caso 3 ja
    # retornou) e nunca esta selada, portanto nao ha nada a preservar nela.
    log "release $SHA existe sem selo de integridade (build interrompido); descartando o parcial."
    rm -rf "$REL"
  fi
fi

# --- Caso 1: construir em staging e promover atomicamente. -------------------
if [[ ! -d "$REL" ]]; then
  STAGING="$RELEASES/.staging-$SHA-$$"
  rm -rf "$STAGING"
  mkdir -p "$STAGING"
  git -C "$REPO_DIR" archive "$SHA" | tar -x -C "$STAGING"

  (
    cd "$STAGING"
    npm ci --no-audit --no-fund
    npm run build
  )

  printf '%s\n' "$SHA" >"$STAGING/$SELO"
  # Promocao atomica: o nome definitivo so passa a existir com o build completo.
  mv -T "$STAGING" "$REL"
  STAGING=""
  log "release $SHA construida e promovida."
fi

# --- Backup pre-deploy: fail-closed. ----------------------------------------
# Nenhuma migration comeca sem um backup novo e nao vazio no disco.
if [[ ! -x "$BACKUP_CMD" ]]; then
  erro "backup pre-deploy indisponivel ($BACKUP_CMD ausente ou nao executavel)."
  erro "Nenhuma migration foi executada e a release ativa nao foi trocada."
  exit 7
fi
BACKUP_ANTES="$(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | head -1 || true)"
if ! "$BACKUP_CMD"; then
  erro "backup pre-deploy falhou; nenhuma migration foi executada."
  exit 7
fi
BACKUP_NOVO="$(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | head -1 || true)"
if [[ -z "$BACKUP_NOVO" || "$BACKUP_NOVO" == "$BACKUP_ANTES" || ! -s "$BACKUP_NOVO" ]]; then
  erro "backup pre-deploy nao produziu arquivo novo e nao vazio em $BACKUP_DIR."
  erro "Nenhuma migration foi executada."
  exit 7
fi
log "backup pre-deploy: $BACKUP_NOVO"

# --- Gate PG-6: sem migrator PostgreSQL oficial nao ha deploy de producao. ---
if ! (cd "$REL" && node -e "const s=require('./package.json').scripts||{};process.exit(s['migrate:postgresql']?0:1)"); then
  erro "script npm 'migrate:postgresql' ausente na revisao $SHA."
  erro "O cutover PG-6 (ADR-003) ainda nao esta consolidado; deploy abortado"
  erro "antes de qualquer troca de release. Nao contornar este gate."
  exit 6
fi

set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a
if ! (cd "$REL" && npm run migrate:postgresql); then
  erro "migrations PostgreSQL falharam; release ativa NAO foi trocada."
  erro "Backup pre-deploy preservado em: $BACKUP_NOVO"
  exit 8
fi
log "migrations PostgreSQL aplicadas."

# --- Troca atomica + restart + health. --------------------------------------
ln -sfn "$REL" "$CURRENT.tmp"
mv -T "$CURRENT.tmp" "$CURRENT"
sudo -n /usr/bin/systemctl restart aldeia.service

ok=0
for _ in $(seq 1 "$HEALTH_TRIES"); do
  if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep "$HEALTH_INTERVAL"
done

if [[ "$ok" -ne 1 ]]; then
  # SEM rollback automatico (ADR-005). As migrations desta release ja foram
  # aplicadas ao banco; voltar o codigo anterior sem prova de compatibilidade
  # com o schema novo pode corromper dado financeiro. O que fazemos e impedir
  # que uma aplicacao defeituosa continue exposta e preservar tudo.
  registrar "FALHA-HEALTH $SHA"
  sudo -n /usr/bin/systemctl stop aldeia.service || true
  anterior_desc="nenhuma"
  if [[ -n "$ATUAL" ]]; then anterior_desc="$(basename "$ATUAL")"; fi
  erro "health check falhou depois da troca de release."
  erro "  SHA novo (current, preservado): $SHA"
  erro "  SHA anterior (release preservada): $anterior_desc"
  erro "  backup pre-deploy: $BACKUP_NOVO"
  erro "  servico aldeia.service PARADO para nao expor aplicacao defeituosa."
  erro "NAO houve rollback automatico: migrations desta release ja foram aplicadas"
  erro "e a release anterior pode ser incompativel com o schema novo. Intervencao"
  erro "controlada conforme docs/runbook/production.md (secao Rollback)."
  exit 9
fi

registrar "OK $SHA"

# Rotacao: somente depois do sucesso, preservando as ultimas KEEP_RELEASES e
# jamais a release ativa ou a imediatamente anterior.
find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -rn | awk -v k="$KEEP_RELEASES" 'NR > k { print $2 }' \
  | while read -r old; do
      [[ "$old" == "$REL" ]] && continue
      [[ -n "$ATUAL" && "$old" == "$ATUAL" ]] && continue
      rm -rf "$old"
    done

log "deploy concluido com sucesso: $SHA"
