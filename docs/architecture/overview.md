# Arquitetura vigente

Aplicação Node.js monolítica: um processo serve UI e API, sem SPA separada e sem
ORM. O SQL é escrito à mão e as constraints financeiras vivem no schema.

**Duas migrações estão em curso ao mesmo tempo, e nenhuma das duas terminou.**
Este documento descreve o estado *real*, não o de destino.

| Eixo | Vigente hoje | Destino | ADR |
|---|---|---|---|
| Transporte web | Express (`/api/*`, `/associados`) + Next.js (`/`, `/health`) | Next.js 16 App Router | [ADR-002](../adr/ADR-002-nextjs-app-router.md) |
| Persistência | **SQLite** (runtime) + PostgreSQL (fundação paralela, ociosa) | PostgreSQL | [ADR-003](../adr/ADR-003-postgresql-persistencia.md) |

## Camadas

```
app/                Next.js App Router — transporte (fase NX-0: / e /health)
src/
  config.js         Resolução de DB_PATH, DATABASE_URL, TEST_DATABASE_URL, PORT
  domain/           Vocabulário do domínio (espelha os CHECK do schema)
  services/         REGRA DE NEGÓCIO — ledger, comprovantes, associados
  db/               SQLite: conexão, PRAGMAs, transações, migrator
    postgresql/     PostgreSQL: pool, withTransaction, health, migrator
  import/           Legado: leitura do workbook, camada bruta, materialização, diagnóstico
  web/              Express — transporte transitório, sai em NX-3
  server.js         Entry point Express — transitório, sai em NX-3
migrations/         Migrations SQL versionadas (SQLite)
  postgresql/       Migrations SQL versionadas (PostgreSQL)
scripts/            Entradas de linha de comando
tests/              node:test
docs/               Documentação (ADRs, domínio, legado, runbook)
data/               Banco SQLite local — ignorado pelo Git
```

## A regra que organiza tudo

**A regra financeira mora em `src/services/`.** Rota Express, Route Handler do
Next.js e Server Component são **transporte**: recebem, validam formato,
delegam e traduzem o resultado em HTTP. Nenhum deles decide se uma alocação
excede o movimento ou se uma inativação tem motivo.

É essa separação que torna as duas migrações possíveis em paralelo: trocar o
transporte (ADR-002) e trocar o banco (ADR-003) são mudanças que atravessam
camadas diferentes, e nenhuma delas precisa reescrever a regra.

## Transporte: onde cada rota responde hoje

| Rota | Servidor | Fase que muda isso |
|---|---|---|
| `GET /` | Next.js | — |
| `GET /health` | Next.js **e** Express (mesmo contrato, sonda comum em `src/db/health.js`) | NX-3 remove o lado Express |
| `/api/movimentos`, `/api/alocacoes`, `/api/ajustes`, `/api/pendencias/comprovantes` | **Express apenas** | NX-1 |
| `/associados`, `/associados/:id` | **Express apenas** | NX-2 |

Consequência operacional: **`npm start` (Next.js) não serve as APIs financeiras.**
Quem precisa delas usa `npm run start:express`. O produto não exige dois
processos — o segundo existe apenas como ferramenta de transição, e sai em NX-3.

## Persistência: SQLite é o runtime, PostgreSQL é fundação

O ADR-003 decidiu PostgreSQL como persistência oficial, e as fases PG-0 e PG-1
estão feitas. **Isso não significa que o sistema use PostgreSQL.** A camada
`src/db/postgresql/` é paralela e **nenhum service, rota ou script a consome**:

- todo acesso a dados em produção passa por `src/db/connection.js` (SQLite,
  síncrono, `better-sqlite3`);
- `/health` responde pelo SQLite — trocar a fonte do health check é trocar o
  runtime, e isso é PG-6;
- `DATABASE_URL` ausente **não é erro de configuração** nesta fase.

A conversão dos consumidores para `async`/SQL PostgreSQL é PG-2; o corte de
runtime é PG-6; a retirada do SQLite é PG-7.

## Invariantes que nenhuma migração toca

- **Dinheiro é inteiro em centavos.** Nunca ponto flutuante como fonte de
  verdade (T-06). Colunas monetárias terminam em `_centavos`; há teste que varre
  o schema atrás de `REAL`/`FLOAT`/`DOUBLE`.
- **Competência é dado, não coluna.** Nunca colunas `jan_2024`, `fev_2024`.
- **Correção é inativação com motivo, nunca `DELETE`** (M-09). FKs usam
  `ON DELETE RESTRICT`; o `CHECK` do banco recusa `ativo = 0` sem *quando* e
  *por quê*.
- **Migration aplicada é imutável** (T-05). O migrator guarda o SHA-256 de cada
  arquivo e aborta se um já aplicado mudar. Correção entra como migration nova.
- **Operação financeira multi-registro é atômica** (T-07): alteração e
  `audit_log` na mesma transação.
- **Proveniência do legado é preservada e ambiguidade não é resolvida em
  silêncio** (M-07, M-08) — ver [`../legacy/README.md`](../legacy/README.md).

## Configuração do Next.js

`next.config.js` declara exatamente duas opções, ambas deliberadas:

- **`poweredByHeader: false`** — preserva a postura que o Express já tinha com
  `app.disable('x-powered-by')`;
- **`outputFileTracingExcludes: { '**/*': ['./data/**/*'] }`** — impede que o
  banco real entre no output do servidor pelo rastreamento de arquivos do Next.

Há ainda um comentário **`/* turbopackIgnore: true */`** em `src/config.js`, sem
efeito em tempo de execução, que impede o Turbopack de rastrear o projeto
inteiro ao desistir de analisar `path.resolve(ROOT_DIR, value)`.

As duas proteções são **complementares e ambas necessárias** — foi medido
removendo cada uma e reconstruindo. Sem elas, o trace de `/health` chegava a
incluir a planilha legada e o banco em `data/`. O racional completo, com as
medições, está em [ADR-002](../adr/ADR-002-nextjs-app-router.md#duas-proteções-contra-vazamento-de-dado-para-o-output-do-servidor).

**Não remover nenhuma das duas** enquanto o build não provar que deixaram de ser
necessárias.
