#!/usr/bin/env bash
# Deploy de producao — executa NA VPS, como usuario `aldeia`, nunca como root.
# Instalado em /opt/aldeia/deploy-production.sh (copia do template versionado;
# alteracoes aqui exigem reinstalacao — ver docs/runbook/production.md).
#
# Uso: deploy-production.sh <sha-40-hex>
#
# Contrato (ADR-004, endurecido por ADR-005 e ADR-006):
#  - o UNICO parametro aceito e um SHA Git completo (o GITHUB_SHA do workflow),
#    que precisa existir E pertencer a `main` oficial (fail-closed);
#  - release em /opt/aldeia/releases/<sha> e IMUTAVEL: nunca e apagada nem
#    sobrescrita como etapa de deploy. Build novo acontece em staging e so vira
#    release definitiva depois de completo (promocao atomica);
#  - o build acontece FORA da janela de manutencao, com a aplicacao no ar. Todos
#    os gates que nao alteram producao rodam antes de qualquer indisponibilidade;
#  - JANELA CRITICA (ADR-006): a aplicacao e PARADA antes do backup e da
#    migration. Codigo antigo nunca atende requests contra schema em mudanca, e
#    o dump representa um ponto quiescente imediatamente anterior ao schema novo;
#  - MIGRATION_STARTED e o ponto sem retorno: depois dele NENHUMA falha religa a
#    release anterior — nem falha do proprio migrator, que pode ter aplicado
#    migrations antes de parar numa posterior. O fail-safe deixa o servico
#    PARADO e preserva current/releases/backup/logs para intervencao humana;
#  - antes de MIGRATION_STARTED o schema esta intacto, entao uma falha pode
#    religar exatamente a release anterior (sem trocar `current`).
#
# Codigos de saida: 2 SHA malformado | 3 lock | 4 SHA inexistente | 5 SHA fora
# da main | 6 migrator PostgreSQL ausente | 7 backup fail-closed | 8 migration
# falhou | 9 health falhou (estado preservado) | 10 redeploy do SHA ja ativo com
# health ruim | 11 nao foi possivel parar/quiescer a aplicacao | 12 gate de
# ambiente (env file/backup tool) reprovado. Qualquer outro codigo vem do
# comando que falhou; o fail-safe nunca mascara o erro original.
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
UNIDADE="${ALDEIA_UNIT:-aldeia.service}"

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

# ---------------------------------------------------------------------------
# Estado observado pelo fail-safe. Toda mudanca relevante de fase atualiza uma
# destas variaveis; o trap de saida decide o que fazer olhando so para elas.
# ---------------------------------------------------------------------------
SHA=""
STAGING=""
FASE="preparacao"
ATUAL=""              # release ativa quando o deploy comecou
SERVICE_WAS_ACTIVE=0  # a aplicacao estava atendendo antes da janela?
JANELA_ABERTA=0       # ja paramos a aplicacao?
MIGRATION_STARTED=0   # ponto sem retorno automatico
DEPLOY_SUCCEEDED=0
BACKUP_NOVO=""

servico_ativo() { systemctl is-active --quiet "$UNIDADE"; }

health_ok() {
  local tentativas="${1:-$HEALTH_TRIES}"
  local _
  for _ in $(seq 1 "$tentativas"); do
    if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$HEALTH_INTERVAL"
  done
  return 1
}

# Trap unico: limpeza de staging E fail-safe. Nao ha traps concorrentes.
ao_sair() {
  local codigo=$?
  trap - EXIT

  if [[ -n "$STAGING" && -d "$STAGING" ]]; then
    rm -rf "$STAGING"
  fi

  if [[ "$DEPLOY_SUCCEEDED" -eq 1 ]]; then
    exit "$codigo"
  fi

  if [[ "$MIGRATION_STARTED" -eq 1 ]]; then
    # Ponto sem retorno: o schema pode ja ter mudado (inclusive quando o proprio
    # migrator falhou no meio). Religar a release anterior seria rodar codigo
    # velho contra schema novo. O estado seguro e: aplicacao PARADA.
    registrar "FALHA-POS-MIGRATION $SHA fase=$FASE codigo=$codigo"
    sudo -n /usr/bin/systemctl stop "$UNIDADE" >/dev/null 2>&1 || true
    erro "falha em '$FASE' DEPOIS do inicio das migrations (codigo $codigo)."
    erro "  producao foi deixada PARADA deliberadamente (fail-safe ADR-006)."
    erro "  SHA alvo: $SHA"
    erro "  release anterior preservada: ${ATUAL:-nenhuma}"
    erro "  backup pre-migration: ${BACKUP_NOVO:-nao chegou a ser produzido}"
    erro "  NENHUMA migration foi revertida e NENHUM banco foi restaurado."
    erro "  Intervencao controlada: docs/runbook/production.md (secao Rollback)."
    exit "$codigo"
  fi

  if [[ "$JANELA_ABERTA" -eq 1 ]]; then
    # Paramos a aplicacao, mas nenhuma migration comecou: o schema esta intacto,
    # entao religar exatamente a release anterior e seguro. `current` nao foi
    # trocado — a release anterior continua sendo a ativa.
    erro "falha em '$FASE' ANTES de qualquer migration (codigo $codigo)."
    if [[ "$SERVICE_WAS_ACTIVE" -eq 1 && -n "$ATUAL" ]]; then
      log "restaurando o servico anterior ($(basename "$ATUAL")); nenhuma migration foi executada."
      if sudo -n /usr/bin/systemctl restart "$UNIDADE" >/dev/null 2>&1 && health_ok 10; then
        registrar "RESTAURADO-PRE-MIGRATION $(basename "$ATUAL") apos falha em $FASE"
        log "servico anterior restaurado e saudavel."
      else
        registrar "FALHA-RESTAURACAO $(basename "$ATUAL") apos falha em $FASE"
        erro "NAO foi possivel restaurar o servico anterior com seguranca."
        erro "  release anterior: ${ATUAL:-nenhuma} (current inalterado)"
        erro "  intervencao manual necessaria: docs/runbook/production.md."
      fi
    else
      log "nao havia servico anterior ativo; nada a restaurar."
    fi
    exit "$codigo"
  fi

  exit "$codigo"
}
trap ao_sair EXIT

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

# ---------------------------------------------------------------------------
# Fora da janela: a aplicacao atual continua no ar durante tudo o que segue.
# ---------------------------------------------------------------------------
FASE="validacao do SHA"
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
# Nada e apagado, reconstruido ou migrado de novo, e NENHUMA janela de
# manutencao e aberta: apenas confirmamos que o que esta no ar responde.
if [[ -n "$ATUAL" && "$ATUAL" == "$REL" ]]; then
  FASE="reexecucao idempotente"
  log "release $SHA ja esta ativa; deploy tratado como reexecucao idempotente."
  if health_ok; then
    registrar "OK-IDEMPOTENTE $SHA"
    log "release ativa saudavel; nada a fazer."
    DEPLOY_SUCCEEDED=1
    exit 0
  fi
  registrar "FALHA-IDEMPOTENTE $SHA"
  erro "release $SHA ja e a ativa, mas o health check nao responde."
  erro "Nada foi alterado. Investigar com o runbook (docs/runbook/production.md)."
  exit 10
fi

# --- Caso 2: release ja existe e nao e a ativa. -------------------------------
FASE="preparacao da release"
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

# --- Gates que precedem qualquer indisponibilidade. --------------------------
# Tudo o que pode reprovar o deploy sem tocar producao roda ANTES da janela: um
# gate reprovado nunca deve custar downtime.
FASE="gates pre-janela"

# Gate PG-6: sem migrator PostgreSQL oficial nao ha deploy de producao.
if ! (cd "$REL" && node -e "const s=require('./package.json').scripts||{};process.exit(s['migrate:postgresql']?0:1)"); then
  erro "script npm 'migrate:postgresql' ausente na revisao $SHA."
  erro "O cutover PG-6 (ADR-003) ainda nao esta consolidado; deploy abortado"
  erro "antes de qualquer troca de release e sem parar a aplicacao."
  exit 6
fi

if [[ ! -x "$BACKUP_CMD" ]]; then
  erro "backup indisponivel ($BACKUP_CMD ausente ou nao executavel)."
  erro "Nenhuma janela de manutencao foi aberta e nada foi alterado."
  exit 7
fi
if [[ ! -r "$ENV_FILE" ]]; then
  erro "arquivo de ambiente $ENV_FILE ausente ou ilegivel."
  erro "Nenhuma janela de manutencao foi aberta e nada foi alterado."
  exit 12
fi

if servico_ativo; then SERVICE_WAS_ACTIVE=1; fi
log "estado antes da janela: servico ativo=$SERVICE_WAS_ACTIVE, release atual=${ATUAL:-nenhuma}"

# ===========================================================================
# JANELA CRITICA DE MANUTENCAO (ADR-006). A aplicacao fica indisponivel a
# partir daqui: nenhum processo antigo pode atender requests durante o backup,
# a migration e a troca de release.
# ===========================================================================
JANELA_ABERTA=1
FASE="parada da aplicacao"
registrar "JANELA-INICIO $SHA"
log "abrindo janela de manutencao: parando $UNIDADE antes do backup e das migrations."

sudo -n /usr/bin/systemctl stop "$UNIDADE" || true
quiesceu=0
for _ in $(seq 1 "$HEALTH_TRIES"); do
  if ! servico_ativo; then quiesceu=1; break; fi
  sleep "$HEALTH_INTERVAL"
done
if [[ "$quiesceu" -ne 1 ]]; then
  erro "$UNIDADE continua ativo depois do stop; migration nao sera executada."
  exit 11
fi
# Confirmacao independente do systemd: ninguem pode estar atendendo a rota.
if curl --fail --silent --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then
  erro "algo ainda responde em $HEALTH_URL depois do stop; migration nao sera executada."
  exit 11
fi
log "aplicacao quiescente."

# --- Backup com a aplicacao parada: ponto consistente pre-migration. --------
FASE="backup pre-migration"
BACKUP_ANTES="$(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | head -1 || true)"
if ! "$BACKUP_CMD"; then
  erro "backup pre-migration falhou; nenhuma migration foi executada."
  exit 7
fi
BACKUP_NOVO="$(ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | head -1 || true)"
if [[ -z "$BACKUP_NOVO" || "$BACKUP_NOVO" == "$BACKUP_ANTES" || ! -s "$BACKUP_NOVO" ]]; then
  BACKUP_NOVO=""
  erro "backup pre-migration nao produziu arquivo novo e nao vazio em $BACKUP_DIR."
  erro "Nenhuma migration foi executada."
  exit 7
fi
log "backup pre-migration (aplicacao parada): $BACKUP_NOVO"

# --- PONTO SEM RETORNO AUTOMATICO. ------------------------------------------
set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a

MIGRATION_STARTED=1
FASE="migrations PostgreSQL"
registrar "MIGRATION-INICIO $SHA backup=$BACKUP_NOVO"
if ! (cd "$REL" && npm run migrate:postgresql); then
  erro "migrations PostgreSQL falharam."
  exit 8
fi
log "migrations PostgreSQL aplicadas."

FASE="troca da release"
ln -sfn "$REL" "$CURRENT.tmp"
mv -T "$CURRENT.tmp" "$CURRENT"

FASE="restart do servico"
sudo -n /usr/bin/systemctl restart "$UNIDADE"

FASE="health check"
if ! health_ok; then
  registrar "FALHA-HEALTH $SHA"
  sudo -n /usr/bin/systemctl stop "$UNIDADE" >/dev/null 2>&1 || true
  anterior_desc="nenhuma"
  if [[ -n "$ATUAL" ]]; then anterior_desc="$(basename "$ATUAL")"; fi
  erro "health check falhou depois da troca de release."
  erro "  SHA novo (current, preservado): $SHA"
  erro "  SHA anterior (release preservada): $anterior_desc"
  erro "  backup pre-migration: $BACKUP_NOVO"
  erro "  servico $UNIDADE PARADO para nao expor aplicacao defeituosa."
  erro "NAO houve rollback automatico: migrations desta release ja foram aplicadas"
  erro "e a release anterior pode ser incompativel com o schema novo. Intervencao"
  erro "controlada conforme docs/runbook/production.md (secao Rollback)."
  exit 9
fi

DEPLOY_SUCCEEDED=1
FASE="conclusao"
registrar "OK $SHA"
registrar "JANELA-FIM $SHA"
# ===========================================================================
# FIM DA JANELA CRITICA — aplicacao nova no ar e saudavel.
# ===========================================================================

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
