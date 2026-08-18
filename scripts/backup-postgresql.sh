#!/usr/bin/env bash
# Backup logico do PostgreSQL de producao — executa NA VPS como usuario `aldeia`.
# Instalado em /usr/local/bin/aldeia-backup-postgresql (copia do template
# versionado). Disparado por aldeia-backup.timer e pelo deploy (pre-migration).
#
# Formato custom + compressao, timestamp UTC no nome, retencao local em dias.
# IMPORTANTE: backup na mesma VPS NAO e disaster recovery; off-site e pendencia
# registrada no runbook e depende de aprovacao (T-03: nenhum SaaS obrigatorio).
set -euo pipefail

BACKUP_DIR=/var/backups/aldeia/postgresql
RETENTION_DAYS=14

set -a
# shellcheck disable=SC1091
source /etc/aldeia/aldeia.env
set +a

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/aldeia_producao_${TS}.dump"

pg_dump --format=custom --compress=9 --file="$OUT" "$DATABASE_URL"
chmod 600 "$OUT"

find "$BACKUP_DIR" -name 'aldeia_producao_*.dump' -mtime +"$RETENTION_DAYS" -delete

echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
