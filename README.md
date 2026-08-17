# TechLab+ Aldeia — ACASA

Sistema de controle de pagamentos da ACASA, substituindo o controle mantido em
planilha.

Autoridade normativa canônica: **`KB-BASELINE-ACASA-v2.0.pdf`** (FROZEN). O
`KB-BASELINE-ACASA-v1.0.pdf` permanece histórico e imutável. A ordem de
precedência é **baseline → ADRs → pacote da tarefa → demais documentos**: os
ADRs registram decisões arquiteturais e **não substituem o baseline**.

## Requisitos

- **Node.js >= 20.11**
- **PostgreSQL** — persistência oficial pelo baseline v2.0. **Ainda não é
  necessário para executar a aplicação**: o runtime continua em SQLite até a
  fase PG-6 ([ADR-003](docs/adr/ADR-003-postgresql-persistencia.md)). É exigido
  apenas para rodar os testes de integração PostgreSQL.
- Nada além disso. Nenhum outro serviço externo: sem Redis, sem fila, sem
  storage, sem SaaS, sem Docker obrigatório.

Nenhum arquivo `.env` é necessário para a aplicação funcionar; `.env.example`
documenta as variáveis opcionais.

## Como rodar

```bash
npm install
npm run migrate
npm run build
npm start
```

Em desenvolvimento, `npm run dev` dispensa o `build`.

```bash
curl http://localhost:3000/health
```

```json
{ "status": "ok", "database": "ok", "migrations": 3 }
```

## Estado das migrações — leia antes de usar

**Duas migrações estão em curso, e nenhuma terminou.**

| Eixo | Hoje | Destino | Decisão |
|---|---|---|---|
| Transporte web | Express serve `/api/*` e `/associados`; Next.js serve `/` e `/health` | Next.js 16 App Router | [ADR-002](docs/adr/ADR-002-nextjs-app-router.md) — fase **NX-0** concluída |
| Persistência | **SQLite** é o banco do runtime; PostgreSQL existe como fundação paralela, ociosa | PostgreSQL | [ADR-003](docs/adr/ADR-003-postgresql-persistencia.md) — fases **PG-0/PG-1** concluídas |

Consequência prática: **`npm start` não serve as APIs financeiras.** Elas
continuam no servidor Express transitório, executável por
`npm run start:express` até a fase NX-3.

## Migrations

```bash
npm run migrate
```

Cria/atualiza o banco **SQLite** (`DB_PATH`, padrão `data/acasa.sqlite`) a partir
das migrations versionadas. Migration aplicada é **imutável**: o runner guarda o
SHA-256 de cada arquivo e aborta se um já aplicado mudar — correção entra como
migration nova.

As migrations PostgreSQL vivem em `migrations/postgresql/` e ainda **não têm
script npm próprio**; hoje quem as exercita são os testes de integração. Detalhes
em [`docs/runbook/database.md`](docs/runbook/database.md).

## Testes e build

```bash
npm test
npm run build
```

Os testes SQLite usam banco temporário e nunca tocam `data/`. Os testes de
integração PostgreSQL são **pulados de forma visível** sem `TEST_DATABASE_URL` —
que **nunca** cai para `DATABASE_URL`.

## Fontes legadas — ficam fora do Git

A planilha de pagamentos e a ficha de cadastro contêm **dados pessoais e
financeiros reais** e **não são versionadas** neste repositório público. Elas
existem apenas na cópia local; o que fica versionado é o manifesto com nome
lógico, finalidade e SHA-256.

```bash
npm run import:legacy -- "<caminho/para/arquivo.xlsx>"
```

Ver [`docs/legacy/source-manifest.md`](docs/legacy/source-manifest.md).

## Documentação

| Documento | Conteúdo |
|---|---|
| [`docs/adr/README.md`](docs/adr/README.md) | Índice dos ADRs, status e supersessões |
| [`docs/architecture/overview.md`](docs/architecture/overview.md) | Arquitetura vigente, camadas e limites |
| [`docs/domain/ledger.md`](docs/domain/ledger.md) | Ledger financeiro: movimento, alocação, identificação, ajuste, inativação |
| [`docs/domain/comprovantes.md`](docs/domain/comprovantes.md) | Estado de comprovante e fila de pendência de evidência |
| [`docs/legacy/README.md`](docs/legacy/README.md) | Regras de fonte e proveniência do legado |
| [`docs/legacy/importacao.md`](docs/legacy/importacao.md) | Captura bruta, materialização cadastral e diagnóstico |
| [`docs/runbook/local-development.md`](docs/runbook/local-development.md) | Subir o projeto, scripts, testes |
| [`docs/runbook/database.md`](docs/runbook/database.md) | As duas trilhas de migration, configuração e barreiras de segurança |

## Convenções

- **Dinheiro é sempre inteiro em centavos.** Colunas monetárias terminam em
  `_centavos`. Nenhum `REAL`/`FLOAT`/`DOUBLE` no schema — há teste que garante.
- **Competência é dado, não coluna.** Nunca crie colunas `jan_2024`, `fev_2024`.
- **Correção é inativação, não `DELETE`.** Entidades financeiras têm `ativo`, e
  as FKs usam `ON DELETE RESTRICT`. Inativar exige **`inativado_em` +
  `motivo_inativacao` não vazio**: o `CHECK` do banco recusa `ativo = 0` sem os
  dois — não existe inativação sem quando e por quê.
- **Migrations aplicadas são imutáveis.** Correções entram como nova migration.
- **Regra financeira mora em `src/services/`.** Rota e componente são transporte.
- **Valor bruto do legado nunca é sobrescrito** por uma interpretação
  normalizada (`legacy_cell.valor_bruto`), e ambiguidade não é resolvida em
  silêncio.

## Estado atual

Implementado: fundação executável, schema inicial, migrations, `/health`, testes,
a importação **bruta** do legado (`legacy_cell`), a materialização **cadastral**
de associados a partir de A/B, o **diagnóstico/relatório de ambiguidades** do
conteúdo legado, o **ledger financeiro** (movimento manual + alocação em
competências + identificação posterior de depósito + fila paginada de movimentos
não identificados + ajuste explícito de crédito/débito + inativação auditável das
três entidades financeiras, com auditoria e transação) e o **estado de
comprovante por movimento** (quatro estados estruturados + observação + fila de
pendência de evidência, tudo auditado).

**Não** implementado (fora do escopo desta fase): interpretação dos códigos
legados, conversão de célula legada em movimento, cálculo de
mensalidade/inadimplência, saldo ou qualquer agregado financeiro,
aplicação/compensação automática de crédito e débito, estorno automático,
conciliação, telas do MVP, upload de comprovantes, reativação, exclusão física,
edição de lançamento, autenticação.
