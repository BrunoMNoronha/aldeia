# Runbook — Produção na VPS (ADR-004)

Somente informação **não secreta**. Segredos vivem em `/etc/aldeia/aldeia.env`
na VPS e no GitHub Environment `production` — nunca aqui, nunca no Git.

## Arquitetura

```text
Internet
   |            (80/443 FECHADAS no UFW enquanto não houver domínio/TLS)
   v
nginx (reverse proxy)          /etc/nginx/sites-available/aldeia.conf
   |
   v
127.0.0.1:3000  Next.js 16     systemd: aldeia.service  (User=aldeia)
   |
   v
127.0.0.1:5432  PostgreSQL 16  database aldeia_producao / role aldeia_app
```

A VPS também hospeda o FaithRO (rAthena + MariaDB, portas 5121/6121/6900,
`mariadb.service`, `faithro-*.service`). **Não tocar** nesses serviços.

## Inventário

| Item | Valor |
|---|---|
| SO | Ubuntu 22.04.5 LTS (1 vCPU, 2 GB RAM, 2 GB swap, ~49 GB disco) |
| SSH | porta **22022** (UFW allow); alias local `faithro-vps` |
| Node | **22 LTS** (NodeSource; pinado em `.nvmrc` — CI e produção usam o mesmo major) |
| PostgreSQL | **16** (PGDG), loopback-only |
| Usuário do serviço | `aldeia` (não-root, sem sudo geral; sudoers restrito a `systemctl restart/status aldeia.service`) |
| App | `/opt/aldeia/{releases,current,repo,shared}` |
| Config | `/etc/aldeia/aldeia.env` (root:aldeia, 640) |
| Backups | `/var/backups/aldeia/postgresql/` (aldeia, 750) |
| systemd | `aldeia.service`, `aldeia-backup.service`, `aldeia-backup.timer` |
| Firewall | UFW: 22022 aberto; 3000 e 5432 **nunca** públicos; 80/443 fechados até TLS |

## Deploy (automático)

1. Push incorporado à `main` dispara `.github/workflows/deploy-production.yml`.
2. Job `validate`: `npm ci` → `npm test` (PostgreSQL 16 efêmero de CI via
   `TEST_DATABASE_URL`; `DATABASE_URL` nunca é definida no CI) → `npm run build`.
3. Job `deploy` (Environment `production`):
   - se `PROD_DEPLOY_ENABLED != 'true'`: informa que o go-live está bloqueado
     pelo **gate PG-6** e termina verde, sem tocar a VPS;
   - se `'true'`: SSH com chave dedicada + `StrictHostKeyChecking=yes` e executa
     `/opt/aldeia/deploy-production.sh <GITHUB_SHA>` na VPS.
4. O script remoto (fonte: `scripts/deploy-production.sh`) valida o SHA,
   serializa com `flock`, materializa `releases/<sha>` via `git archive`,
   `npm ci` + `npm run build`, **backup pré-deploy**, exige e executa
   `npm run migrate:postgresql` (aborta se ausente — gate PG-6), troca o
   symlink `current` atomicamente, `systemctl restart aldeia`, health check em
   `http://127.0.0.1:3000/health` (30×2 s), registra em
   `/opt/aldeia/shared/deploy-history.log` e mantém as últimas 5 releases.

O comportamento operacional é versionado; os arquivos instalados na VPS são
cópias dos templates do repo (`scripts/*.sh`, `deploy/systemd/*`,
`deploy/nginx/*`). **Alterou o template → reinstale a cópia na VPS.**

## Verificações

```bash
# SHA implantado
readlink -f /opt/aldeia/current            # .../releases/<sha>
tail /opt/aldeia/shared/deploy-history.log

# serviço e logs
systemctl status aldeia
journalctl -u aldeia -n 100 --no-pager

# health interno (não considerar `systemctl active` suficiente)
curl --fail --silent --show-error http://127.0.0.1:3000/health
```

Depois do PG-6, `/health` deve refletir **PostgreSQL**, não SQLite.

## Migrations

- `npm run migrate` é o migrator **SQLite** — **nunca** executá-lo em produção.
- O mecanismo de produção é o script npm `migrate:postgresql` (a existir no
  cutover PG-6); o deploy o executa uma única vez, antes da troca de release,
  com erro bloqueando o deploy. Migration aplicada é imutável (T-05); correção
  entra como migration nova.
- `TEST_DATABASE_URL` jamais aponta para produção.

## Backup e restore

- Diário 03:30 (timer `aldeia-backup.timer`) e pré-deploy: `pg_dump` formato
  custom comprimido em `/var/backups/aldeia/postgresql/aldeia_producao_<UTC>.dump`
  (chmod 600). Retenção local: **14 dias**.
- Restore test (nunca contra produção, nunca `--clean` na produção):

```bash
sudo -u postgres createdb aldeia_restore_test
sudo -u postgres pg_restore -d aldeia_restore_test /var/backups/aldeia/postgresql/<arquivo>.dump
sudo -u postgres psql -d aldeia_restore_test -c '\dt'   # conferir schema/contagens
sudo -u postgres dropdb aldeia_restore_test
```

- **Backup off-site: pendente de decisão/aprovação.** Backup na mesma VPS não é
  disaster recovery.

## Rollback

- **Código**: em falha de health, o deploy script volta o symlink para a
  release anterior e reinicia — automático. Manual:
  `ln -sfn /opt/aldeia/releases/<sha-anterior> /opt/aldeia/current && sudo systemctl restart aldeia`.
- **Banco**: nunca reverter migration automaticamente, nunca editar migration
  aplicada. Uma migration já aplicada pode tornar a release anterior
  incompatível — antes de voltar código após uma migration, provar
  compatibilidade; se não der, manter o serviço parado/degradado e intervir de
  forma controlada com o backup pré-deploy como evidência.

## GitHub — secrets e variáveis (somente nomes)

Environment `production`:

- secrets: `PROD_SSH_HOST`, `PROD_SSH_PORT`, `PROD_SSH_USER`,
  `PROD_SSH_PRIVATE_KEY`, `PROD_SSH_KNOWN_HOSTS`
- variable: `PROD_DEPLOY_ENABLED` (`false` até PG-6; `true` ativa o deploy live)

Fingerprint da chave pública de deploy ativa (ed25519, exclusiva do Actions):
`SHA256:BaYX+QbItr25EYj6oJeQX3TnOUsvYY4Fv8Od+oSqLPs`

## Rotação da chave de deploy

1. `ssh-keygen -t ed25519 -C "github-actions-deploy-aldeia" -f <tmp> -N ""`
2. Adicionar a nova pública em `/home/aldeia/.ssh/authorized_keys`; testar login.
3. Atualizar o secret `PROD_SSH_PRIVATE_KEY` no Environment `production`.
4. Remover a pública antiga do `authorized_keys` e apagar a cópia local da
   privada. Registrar apenas o fingerprint (`ssh-keygen -lf`).

## Emergência

```bash
sudo systemctl stop aldeia          # parar a aplicação
sudo systemctl restart aldeia       # reiniciar
journalctl -u aldeia -f             # acompanhar logs
sudo -u postgres psql aldeia_producao   # inspecionar banco (leitura!)
```

Se o deploy automático precisar ser suspenso: Environment `production` →
`PROD_DEPLOY_ENABLED=false` (nenhum acesso à VPS ocorre com o gate fechado).

## Status e limitações conhecidas

- **PG-6: pendente.** Runtime da `main` ainda é SQLite → `PROD_DEPLOY_ENABLED=false`,
  produção **preparada, não ativa**. Não usar SQLite como banco oficial de produção.
- **TLS: inativo.** Não há domínio destinado ao sistema; 80/443 fechadas. Com
  domínio: preencher `server_name`, certbot, redirect HTTP→HTTPS, abrir portas.
- Role `aldeia_app` é owner da database (DDL de migration e runtime na mesma
  role — o código atual não suporta separação; documentado no ADR-004).
- Build roda na VPS (1 vCPU/2 GB): deploy demora alguns minutos; swap cobre o pico.
