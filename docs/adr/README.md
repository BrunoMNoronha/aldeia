# Decisões arquiteturais (ADRs)

Registro das decisões de arquitetura do projeto. **ADR não se apaga e não se
reescreve**: uma decisão superada continua no repositório como registro
histórico, e o que muda é o *status* e a nota de supersessão.

## Índice

| ADR | Título | Status | Data | Supersede | Superseded by | Resumo |
|---|---|---|---|---|---|---|
| [ADR-001](ADR-001-arquitetura-inicial.md) | Arquitetura inicial do MVP | **Aceito — parcialmente superseded** | 2026-08-16 | — | ADR-002 (Express, UI, build step), ADR-003 (SQLite, `better-sqlite3`, PRAGMAs, `BEGIN IMMEDIATE`) | Node.js + Express + SQLite, migrations SQL versionadas sem ORM, dinheiro em centavos inteiros, inativação em vez de exclusão. |
| [ADR-002](ADR-002-nextjs-app-router.md) | Migração incremental para Next.js (App Router) | **Aceito — parcialmente superseded** | 2026-08-16 | ADR-001 (framework web, direção de UI, ausência de build step, entry point) | ADR-003 (as partes que reafirmavam SQLite e `better-sqlite3`) | Express → Next.js 16 App Router em quatro fases (NX-0…NX-3). Transporte apenas; nenhuma regra financeira muda. |
| [ADR-003](ADR-003-postgresql-persistencia.md) | Adotar PostgreSQL como persistência principal | **Aceito** | 2026-08-17 | ADR-001 e ADR-002 (SQLite como persistência, `DB_PATH`, PRAGMAs, `BEGIN IMMEDIATE`, acesso síncrono, T-03 sem serviço externo) | — | SQLite → PostgreSQL com driver `pg`, sem ORM, em oito fases (PG-0…PG-7). Registro da decisão que motivou o baseline v2.0. |
| [ADR-004](ADR-004-deploy-producao-vps.md) | Produção em VPS com CI/CD automático a partir da `main` | **Aceito — parcialmente superseded** | 2026-08-18 | — | ADR-005 (rollback automático pós-migration, ciclo de vida da release, elegibilidade do SHA, gates de CI e de backup) | VPS + systemd + nginx + PostgreSQL 16 local; GitHub Actions dispara em push na `main`; release imutável por SHA; deploy live bloqueado por `PROD_DEPLOY_ENABLED=false` até o cutover PG-6. |
| [ADR-005](ADR-005-hardening-deploy-producao.md) | Hardening e rollback seguro do deploy de produção | **Aceito — parcialmente superseded** | 2026-08-19 | ADR-004 (rollback automático pós-migration, `rm -rf` da release, validação do SHA por mera existência, ref livre no `workflow_dispatch`, contagem de skips informativa, backup pré-deploy opcional) | ADR-006 (momento do backup e alcance do fail-safe) | Sem rollback automático depois de migration; release imutável com staging e selo; deploy restrito a commits da `main`; CI reprova suíte pulada; backup pré-migration fail-closed. |
| [ADR-006](ADR-006-janela-manutencao-migrations.md) | Janela de manutenção segura para migrations de produção | **Aceito** | 2026-08-19 | ADR-005 (backup com a aplicação possivelmente atendendo; fail-safe restrito ao bloco de health) | — | Build fora da janela; aplicação parada e quiescência comprovada antes de backup e migration; `MIGRATION_STARTED` como ponto sem retorno; fail-safe global no `trap EXIT`; retorno automático só antes da primeira migration. |
| [ADR-007](ADR-007-typescript-incremental.md) | Adoção incremental de TypeScript | **Aceito** | 2026-08-20 | — | — | TypeScript como linguagem preferencial para código permanente novo, em migração incremental (`allowJs` temporário, `strict`, `noEmit`). Código transitório SQLite/Express permanece JavaScript até ser removido. Tipagem **não** substitui validação em runtime. `target`/`lib` seguem o mínimo de `engines.node`. Validação de PR (`ci.yml`) passa a ser o gate antes do merge. Sem migração CJS → ESM. |

## Supersessões, em detalhe

Nenhum ADR foi revogado por inteiro. Cada supersessão é **parcial** e está
delimitada dentro do ADR que a produz.

```text
ADR-001  Express ─────────────────────────► ADR-002  Next.js 16 App Router
ADR-001  HTML por concatenação ───────────► ADR-002  React (Server Components)
ADR-001  sem build step ──────────────────► ADR-002  npm run build obrigatório
ADR-001  src/server.js como entry point ──► ADR-002  next start

ADR-001  SQLite (T-02) ───────────────────► ADR-003  PostgreSQL
ADR-002  better-sqlite3 + PRAGMAs ────────► ADR-003  pg (node-postgres) + pool
ADR-002  BEGIN IMMEDIATE ─────────────────► ADR-003  BEGIN/COMMIT/ROLLBACK
ADR-002  acesso síncrono ao banco ────────► ADR-003  async/await
ADR-002  T-03 sem serviço externo ────────► ADR-003  PostgreSQL é o único obrigatório

ADR-004  rollback automático de código ───► ADR-005  parar o serviço e preservar tudo
ADR-004  rm -rf da release no deploy ─────► ADR-005  staging + promoção atômica + selo
ADR-004  SHA apenas precisa existir ──────► ADR-005  SHA tem de ser ancestral da main
ADR-004  workflow_dispatch de qualquer ref► ADR-005  deploy só de refs/heads/main
ADR-004  skips do CI meramente informados ► ADR-005  skip > 0 reprova o job
ADR-004  backup pré-deploy opcional ──────► ADR-005  sem backup não há migration

ADR-005  backup com a app atendendo ──────► ADR-006  app parada, backup quiescente
ADR-005  fail-safe só no health falho ────► ADR-006  fail-safe global no trap EXIT
```

**Permanece válido em todos eles**, e nenhum ADR toca: T-01 (Node.js), T-06
(dinheiro sem ponto flutuante), **T-08** — que no baseline vigente v2.0 exige a
**separação entre domínio, persistência, importação e transporte web**, e proíbe
que uma mudança de framework mova regra financeira para componentes ou rotas —,
M-01 a M-10, F-01 a F-11, migrations versionadas com checksum e imutabilidade
(T-05), a separação `domain`/`services`/`db`/`import`, `node:test` como runner e
**todos os pontos TO CONFIRM**, que continuam TO CONFIRM.

> **Atenção ao T-08.** No baseline **v1.0** o T-08 dizia que *framework web é
> decisão de implementação* — é essa formulação, e só ela, que aparece no
> contexto histórico do ADR-002 e do ADR-003. No **v2.0** o T-08 passou a ser
> uma exigência de **arquitetura em camadas**, e não uma liberdade de escolha.
> A escolha do **Next.js 16 App Router permanece APPROVED** por **A-01** e pelo
> [ADR-002](ADR-002-nextjs-app-router.md); o que o T-08 vigente governa é onde a
> regra financeira pode morar — em `src/services/`, nunca em rota ou componente.

## Estado das migrações

As duas migrações estão **em curso** e nenhuma terminou. O que está feito:

| ADR | Fases concluídas | Próxima |
|---|---|---|
| ADR-002 (Next.js) | **NX-0** — fundação: `app/`, `next.config.js`, scripts | NX-1 — APIs viram Route Handlers |
| ADR-003 (PostgreSQL) | **PG-0** governança, **PG-1** fundação paralela | PG-2 — converter os acessos a dados para `async` |
| ADR-007 (TypeScript) | **TS-0** — fundação: `tsconfig.json` strict, `npm run typecheck`, validação de PR em `ci.yml` | TS-1 — converter os módulos permanentes puros |

Enquanto isso: **Express serve `/api/*` e `/associados`**, e **SQLite é o banco
do runtime**. Ver [`../architecture/overview.md`](../architecture/overview.md).

## Baseline normativo

A ordem de precedência do projeto é: **baseline → ADRs → pacote da tarefa →
demais documentos**.

- **`KB-BASELINE-ACASA-v2.0.pdf`** (FROZEN) é a **autoridade normativa canônica
  vigente**. Em qualquer divergência entre um ADR e o baseline, **o baseline
  prevalece**.
- **`KB-BASELINE-ACASA-v1.0.pdf`** permanece **histórico e imutável**. Não é
  editado nem substituído, e não é tratado como vigente.

**ADR não é baseline.** Um ADR registra uma **decisão arquitetural** — o
contexto, as alternativas, as consequências e o plano de execução. Ele **não
substitui, não copia e não reproduz normativamente** o baseline. Em particular,
o [ADR-003](ADR-003-postgresql-persistencia.md) é o **registro arquitetural da
decisão e da migração para PostgreSQL**; a norma que essa decisão passou a
observar está no `KB-BASELINE-ACASA-v2.0.pdf`, não no ADR.

> **Nota de rastreabilidade.** Os PDFs de baseline não são versionados neste
> repositório — `docs/` contém apenas os ADRs. Consultar o texto normativo exige
> o PDF canônico. Registrar onde o baseline é mantido é uma pendência de
> governança, não uma decisão de arquitetura.

## Formato

Cada ADR abre com um bloco de metadados:

```markdown
- **Status:** aceito | proposto | aceito — parcialmente superseded | revogado
- **Data:** AAAA-MM-DD
- **Baseline normativo aplicável:** ... (o PDF canônico, nunca este documento)
- **Relação com ADRs anteriores:** ...
```

Um ADR novo que supere parte de um anterior deve (a) declarar exatamente **quais
pontos** supera, (b) declarar o que **permanece válido**, e (c) ser adicionado à
tabela acima com a supersessão preenchida nos dois lados.
