# Decisões arquiteturais (ADRs)

Registro das decisões de arquitetura do projeto. **ADR não se apaga e não se
reescreve**: uma decisão superada continua no repositório como registro
histórico, e o que muda é o *status* e a nota de supersessão.

## Índice

| ADR | Título | Status | Data | Supersede | Superseded by | Resumo |
|---|---|---|---|---|---|---|
| [ADR-001](ADR-001-arquitetura-inicial.md) | Arquitetura inicial do MVP | **Aceito — parcialmente superseded** | 2026-08-16 | — | ADR-002 (Express, UI, build step), ADR-003 (SQLite, `better-sqlite3`, PRAGMAs, `BEGIN IMMEDIATE`) | Node.js + Express + SQLite, migrations SQL versionadas sem ORM, dinheiro em centavos inteiros, inativação em vez de exclusão. |
| [ADR-002](ADR-002-nextjs-app-router.md) | Migração incremental para Next.js (App Router) | **Aceito — parcialmente superseded** | 2026-08-16 | ADR-001 (framework web, direção de UI, ausência de build step, entry point) | ADR-003 (as partes que reafirmavam SQLite e `better-sqlite3`) | Express → Next.js 16 App Router em quatro fases (NX-0…NX-3). Transporte apenas; nenhuma regra financeira muda. |
| [ADR-003](ADR-003-postgresql-persistencia.md) | Adotar PostgreSQL como persistência principal | **Aceito** | 2026-08-17 | ADR-001 e ADR-002 (SQLite como persistência, `DB_PATH`, PRAGMAs, `BEGIN IMMEDIATE`, acesso síncrono, T-03 sem serviço externo) | — | SQLite → PostgreSQL com driver `pg`, sem ORM, em oito fases (PG-0…PG-7). Base normativa do baseline v2.0. |

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
```

**Permanece válido em todos eles**, e nenhum ADR toca: T-01 (Node.js), T-06
(dinheiro sem ponto flutuante), T-08 (framework web é decisão de implementação),
M-01 a M-10, F-01 a F-11, migrations versionadas com checksum e imutabilidade
(T-05), a separação `domain`/`services`/`db`/`import`, `node:test` como runner e
**todos os pontos TO CONFIRM**, que continuam TO CONFIRM.

## Estado das migrações

As duas migrações estão **em curso** e nenhuma terminou. O que está feito:

| ADR | Fases concluídas | Próxima |
|---|---|---|
| ADR-002 (Next.js) | **NX-0** — fundação: `app/`, `next.config.js`, scripts | NX-1 — APIs viram Route Handlers |
| ADR-003 (PostgreSQL) | **PG-0** governança, **PG-1** fundação paralela | PG-2 — converter os acessos a dados para `async` |

Enquanto isso: **Express serve `/api/*` e `/associados`**, e **SQLite é o banco
do runtime**. Ver [`../architecture/overview.md`](../architecture/overview.md).

## Baseline normativo

A ordem de precedência do projeto é: **baseline → ADRs → pacote da tarefa →
demais documentos**.

- **`KB-BASELINE-ACASA-v2.0`** é o baseline **vigente**. As alterações
  normativas que o produzem (T-02, T-03, T-05, T-07 e os critérios globais de
  aceite) estão redigidas na seção *"Alterações normativas propostas"* do
  [ADR-003](ADR-003-postgresql-persistencia.md).
- **`KB-BASELINE-ACASA-v1.0.pdf`** permanece **histórico e imutável**. Não é
  editado nem substituído.

> **Nota de rastreabilidade.** Nenhum dos dois PDFs está versionado neste
> repositório — o `docs/` contém apenas os ADRs. A referência ao baseline é,
> hoje, textual. Publicar o PDF do v2.0 (ou registrar onde ele é mantido) é uma
> pendência de governança, não uma decisão de arquitetura.

## Formato

Cada ADR abre com um bloco de metadados:

```markdown
- **Status:** aceito | proposto | aceito — parcialmente superseded | revogado
- **Data:** AAAA-MM-DD
- **Baseline normativo vigente:** ...
- **Relação com ADRs anteriores:** ...
```

Um ADR novo que supere parte de um anterior deve (a) declarar exatamente **quais
pontos** supera, (b) declarar o que **permanece válido**, e (c) ser adicionado à
tabela acima com a supersessão preenchida nos dois lados.
