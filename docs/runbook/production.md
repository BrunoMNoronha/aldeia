# Runbook — Produção na VPS (ADR-004, endurecido pelo ADR-005)

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
| Usuário do serviço | `aldeia` (não-root, sem sudo geral; sudoers restrito a `systemctl restart/stop/status aldeia.service`) |
| App | `/opt/aldeia/{releases,current,repo,shared}` |
| Config | `/etc/aldeia/aldeia.env` (root:aldeia, 640) |
| Backups | `/var/backups/aldeia/postgresql/` (aldeia, 750) |
| systemd | `aldeia.service`, `aldeia-backup.service`, `aldeia-backup.timer` |
| Firewall | UFW: 22022 aberto; 3000 e 5432 **nunca** públicos; 80/443 fechados até TLS |

## Deploy (automático)

1. Push incorporado à `main` dispara `.github/workflows/deploy-production.yml`.
2. Job `validate`: `npm ci` → `npm test` (PostgreSQL 16 efêmero de CI via
   `TEST_DATABASE_URL`; `DATABASE_URL` nunca é definida no CI) → `npm run build`.
   **Qualquer teste pulado reprova o job**: com `TEST_DATABASE_URL` configurada
   a suíte PostgreSQL tem de rodar inteira, e `skipped != 0` (ou resumo
   ilegível) é falha, não aviso.
3. Job `deploy` (Environment `production`):
   - se `PROD_DEPLOY_ENABLED != 'true'`: informa que o go-live está bloqueado
     pelo **gate PG-6** e termina verde, sem tocar a VPS;
   - se `'true'` **e** a ref for `refs/heads/main`: SSH com chave dedicada +
     `StrictHostKeyChecking=yes` e executa
     `/opt/aldeia/deploy-production.sh <GITHUB_SHA>` na VPS;
   - se `'true'` e a ref **não** for a `main` (ex.: `workflow_dispatch` numa
     branch): o job **falha** explicitamente e nada é implantado.
4. O script remoto (fonte: `scripts/deploy-production.sh`) serializa com
   `flock` e então: valida o formato do SHA → confirma que ele **pertence à
   `main`** (`git merge-base --is-ancestor`; existir no repositório não basta) →
   constrói em `releases/.staging-<sha>-<pid>` (`npm ci` + `npm run build`) e
   promove atomicamente para `releases/<sha>` com o selo `.aldeia-release-ok` →
   **backup pré-deploy fail-closed** → exige e executa `npm run
   migrate:postgresql` (aborta se ausente — gate PG-6) → troca o symlink
   `current` → `systemctl restart aldeia` → health check em
   `http://127.0.0.1:3000/health` (30×2 s) → registra em
   `/opt/aldeia/shared/deploy-history.log` → mantém as últimas 5 releases
   (nunca a ativa nem a anterior).

### Idempotência e reaproveitamento de release

Uma release nunca é apagada nem sobrescrita como etapa de deploy:

| Situação do `releases/<sha>` | O que o deploy faz |
|---|---|
| não existe | constrói em staging e promove (o nome definitivo só aparece completo) |
| existe **e é o `current`** | reexecução idempotente: só confere o health. Não reconstrói, não refaz backup, não repete migration, não apaga nada |
| existe, selado, não é o `current` | reutiliza sem reconstruir |
| existe **sem selo** (build interrompido) | descarta o parcial e reconstrói, com log explícito |

### Códigos de saída do script

`2` SHA malformado · `3` outro deploy em andamento · `4` SHA inexistente ·
`5` SHA fora da `main` · `6` migrator PostgreSQL ausente (gate PG-6) ·
`7` backup pré-deploy ausente/falho · `8` migration falhou (release **não**
trocada) · `9` health falhou após a troca (estado preservado, serviço parado) ·
`10` redeploy do SHA já ativo com health ruim (nada alterado).

O comportamento operacional é versionado; os arquivos instalados na VPS são
cópias dos templates do repo (`scripts/*.sh`, `deploy/systemd/*`,
`deploy/nginx/*`, `deploy/sudoers/*`). **Alterou o template → reinstale a cópia
na VPS.** Conferir se a cópia está em dia:

```bash
sha256sum /opt/aldeia/deploy-production.sh   # comparar com o do repo
```

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

- O backup pré-deploy é **fail-closed**: se a ferramenta estiver ausente,
  retornar erro ou não gerar um dump novo e não vazio, **nenhuma migration
  começa** e o deploy falha com código 7.
- **Backup off-site: pendente de decisão/aprovação.** Backup na mesma VPS não é
  disaster recovery.

## Rollback

**Não existe rollback automático** (ADR-005). Quando o health check falha depois
da troca de release, o deploy:

1. registra `FALHA-HEALTH <sha>` em `/opt/aldeia/shared/deploy-history.log`;
2. **para** `aldeia.service`, para não deixar aplicação defeituosa exposta;
3. **preserva** `current` (apontando para a release nova), a release anterior, o
   backup pré-deploy e os logs;
4. falha com código 9, imprimindo SHA novo, SHA anterior e caminho do backup.

O motivo é direto: as migrations desta release **já foram aplicadas ao banco**.
Voltar o código anterior sem prova de compatibilidade com o schema novo é rodar
código velho contra schema novo — risco sobre dado financeiro (T-06/T-07). Por
isso a volta é decisão humana:

```bash
journalctl -u aldeia -n 200 --no-pager        # por que o health falhou
tail -5 /opt/aldeia/shared/deploy-history.log # SHA novo e histórico
readlink -f /opt/aldeia/current               # release ativa preservada
```

- **Se a causa for do código e a release anterior for comprovadamente compatível
  com o schema atual** (nenhuma migration desta leva mudança incompatível):
  `ln -sfn /opt/aldeia/releases/<sha-anterior> /opt/aldeia/current && sudo systemctl restart aldeia`,
  seguido de `curl --fail http://127.0.0.1:3000/health`.
- **Se a compatibilidade não puder ser provada**: mantenha o serviço parado e
  corrija adiante (nova revisão na `main` + novo deploy). Nunca reverter
  migration, nunca editar migration aplicada (T-05), nunca restaurar o banco por
  impulso — o backup pré-deploy existe como evidência e último recurso, e um
  restore é operação deliberada, não parte do deploy.
- **Banco**: migration aplicada é imutável; correção entra como migration nova.

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
- **Health falho pós-migration deixa o serviço parado** até intervenção humana
  (ADR-005). É indisponibilidade explícita em vez de rollback arriscado.
- O script de deploy aceita overrides `ALDEIA_*` **usados apenas pelos testes
  automatizados** (`tests/deploy-production-script.test.js`). O deploy real não
  define nenhuma: a sessão SSH usa comando fixo e não encaminha ambiente.
