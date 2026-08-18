# ADR-004 — Produção em VPS com CI/CD automático a partir da `main`

- **Status:** aceito
- **Data:** 2026-08-18
- **Baseline normativo aplicável:** `KB-BASELINE-ACASA-v2.0.pdf` (FROZEN — o PDF
  canônico, nunca este documento)
- **Relação com ADRs anteriores:** consome ADR-002 (Next.js 16 App Router) e
  ADR-003 (PostgreSQL como persistência principal). Não supera nenhum ponto de
  ADR anterior.

## Contexto

O sistema precisa de um ambiente de produção e de um caminho de entrega
contínua. A decisão humana desta tarefa fixou: destino de produção é a VPS
(Ubuntu 22.04, acessível localmente pelo alias SSH `faithro-vps`), origem é o
repositório oficial `BrunoMNoronha/aldeia`, orquestrador é o GitHub Actions, e
o gatilho operacional é a atualização da branch `main` — deploy automático,
sem ação manual como mecanismo normal.

A VPS já hospeda outro sistema (servidor de jogo FaithRO: rAthena + MariaDB,
portas 5121/6121/6900, UFW ativo, SSH em 22022). A infraestrutura da Aldeia
convive com ele sem tocá-lo.

## Decisão

1. **Destino**: VPS única, sem Docker obrigatório, sem SaaS novo (T-03).
2. **Runtime**: Node.js **22 LTS** (pinado em `.nvmrc`; `engines` do projeto e
   Next 16 exigem ≥20.9, e Node 20 está EOL). CI e produção usam o mesmo major.
3. **Processo**: `next start` em **loopback** (`127.0.0.1:3000`), administrado
   por **systemd** (`aldeia.service`), usuário dedicado não-root `aldeia`,
   `NODE_ENV=production`, logs via journald, restart on-failure, boot habilitado.
4. **Reverse proxy**: **nginx** → `127.0.0.1:3000`. A porta 3000 nunca é
   pública; 5432 nunca é pública.
5. **Persistência**: **PostgreSQL 16 local** na própria VPS (PGDG), escutando
   somente loopback; role `aldeia_app` sem `SUPERUSER`/`CREATEDB`/`CREATEROLE`;
   database dedicada `aldeia_producao` com owner `aldeia_app` (o owner concentra
   o DDL das migrations — limitação documentada: código atual não separa role de
   migration de role de runtime). Credenciais só em `/etc/aldeia/aldeia.env`
   (root:aldeia, 640), nunca no Git.
6. **Release por SHA**: releases imutáveis em `/opt/aldeia/releases/<sha>`,
   ativadas por troca atômica do symlink `current`. O SHA implantado é sempre o
   `GITHUB_SHA` do push que atualizou a `main`, validado por `^[0-9a-f]{40}$`
   nos dois lados. Lock por `flock` serializa deploys no servidor. As últimas 5
   releases são mantidas para rollback de código.
7. **CI/CD**: workflow `.github/workflows/deploy-production.yml`, disparado por
   `push` em `main` (e `workflow_dispatch` para teste operacional). Job de
   validação roda `npm ci`, `npm test` (com PostgreSQL 16 efêmero de CI via
   `TEST_DATABASE_URL`) e `npm run build` antes de qualquer acesso à VPS.
   `permissions: contents: read`; `concurrency` serializa sem cancelar deploy em
   andamento; actions oficiais pinadas por commit SHA.
8. **Acesso do CI à VPS**: chave **ed25519 dedicada** exclusiva do GitHub
   Actions (nunca a chave pessoal), instalada no usuário `aldeia`; host key
   pré-verificada a partir do acesso confiável existente e usada com
   `StrictHostKeyChecking=yes`. Segredos em GitHub Environment `production`
   (`PROD_SSH_HOST/PORT/USER/PRIVATE_KEY/KNOWN_HOSTS`).
9. **Migrations**: o deploy exige o script npm `migrate:postgresql` na revisão
   implantada e o executa uma única vez antes da troca de release; erro bloqueia
   o deploy. `npm run migrate` (migrator SQLite) **nunca** é chamado em
   produção. Migration aplicada é imutável (T-05).
10. **Backup**: `pg_dump` formato custom comprimido, timestamp UTC, em
    `/var/backups/aldeia/postgresql/` (fora do Git), timer systemd diário,
    retenção local de 14 dias, e backup pré-deploy antes das migrations.
    Restore é testado contra database descartável. **Backup off-site é
    pendência de decisão** — backup na mesma VPS não é disaster recovery.
11. **Rollback**: rollback automático é só de **código** (symlink anterior +
    restart) quando o health check falha. Migration já aplicada nunca é
    revertida automaticamente nem editada; incompatibilidade entre release
    anterior e schema novo bloqueia e exige intervenção controlada.
12. **TLS**: não existe domínio destinado ao sistema hoje. Sem domínio não se
    inventa domínio nem se serve dado pessoal/financeiro em HTTP público:
    `TLS_ATIVO=não`, portas 80/443 permanecem fechadas no firewall até haver
    domínio e certificado.

## Gate PG-6 — automação ≠ autorização

**Automação de deploy não autoriza violar o gate PG-6.** Na data desta decisão,
a `main` ainda roda **SQLite** como persistência do runtime (`/health` verifica
SQLite; `npm run migrate` é o migrator SQLite; services consumidos pelas rotas
usam `better-sqlite3`), logo `PG6_RUNTIME_POSTGRESQL=não`.

Por isso o Environment `production` nasce com **`PROD_DEPLOY_ENABLED=false`**:
o pipeline dispara a cada push em `main`, valida e informa explicitamente que o
go-live aguarda PG-6. O deploy live só é habilitado (variável para `true`)
quando o cutover do ADR-003 estiver consolidado — PostgreSQL como runtime,
`/health` refletindo PostgreSQL, migrator PostgreSQL oficial (`migrate:postgresql`)
e suíte relevante verde. O script de deploy tem trava própria: aborta se
`migrate:postgresql` não existir na revisão. SQLite nunca vira banco oficial de
produção como atalho.

## Consequências

- Um push incorporado à `main` sempre produz uma execução do pipeline; depois
  do gate liberado, produz um deploy completo sem ação humana.
- Produção **preparada ≠ produção ativa**: este ADR registra a preparação; a
  ativação é o flip de `PROD_DEPLOY_ENABLED` após PG-6, sem novo ADR.
- A VPS tem 1 vCPU / 2 GB RAM: o build roda tanto no CI (validação) quanto na
  VPS (release local). Se o build na VPS se tornar proibitivo, transferir o
  artefato de build é evolução futura deste ADR.
- Operação documentada em [`docs/runbook/production.md`](../runbook/production.md).
