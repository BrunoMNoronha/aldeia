# ADR-001 — Arquitetura inicial do MVP

- **Status:** **aceito — parcialmente superseded** (ver abaixo)
- **Data:** 2026-08-16
- **Baseline normativo à época:** `KB-BASELINE-ACASA-v1.0.pdf` (v1.0 — FROZEN, **imutável**)
- **Baseline vigente hoje:** `KB-BASELINE-ACASA-v2.0`
- **Superseded parcialmente por:** [ADR-002](ADR-002-nextjs-app-router.md), [ADR-003](ADR-003-postgresql-persistencia.md)

> **Nota de leitura.** Este ADR foi **aceito e implementado**, e é o registro
> histórico da arquitetura do MVP. **O texto abaixo não foi reescrito** — ele
> descreve o que foi decidido em 2026-08-16, sob o baseline v1.0.
>
> Dois conjuntos de decisões deixaram de valer:
>
> | Decisão original | Superseded por | O que passa a valer |
> |---|---|---|
> | **Express**, HTML por concatenação de strings, ausência de build step, `src/server.js` como entry point (seção 1) | [ADR-002](ADR-002-nextjs-app-router.md) | Next.js 16 App Router, React, `npm run build` obrigatório, `next start`. |
> | **SQLite** via `better-sqlite3`, PRAGMAs, `DB_PATH`/`data/acasa.sqlite`, `withTransaction` com `BEGIN IMMEDIATE`, acesso síncrono (seções 2 e 3) | [ADR-003](ADR-003-postgresql-persistencia.md) | PostgreSQL com `pg` e pool, `DATABASE_URL`, `BEGIN`/`COMMIT`/`ROLLBACK`, acesso assíncrono. |
>
> **Nenhuma das duas substituições terminou.** Express ainda serve `/api/*` e
> `/associados`; SQLite ainda é o banco do runtime. Ver
> [`docs/adr/README.md`](README.md) e
> [`docs/architecture/overview.md`](../architecture/overview.md).
>
> **Permanece integralmente válido:** migrations SQL versionadas sem ORM com
> checksum e imutabilidade (T-05, seção 3), dinheiro em centavos inteiros (T-06,
> seção 4), preservação histórica por inativação (M-09, seção 5), `node:test`
> como runner (seção 6), a separação `domain`/`services`/`db`/`import` e toda a
> seção "Fora de escopo desta decisão", com seus pontos TO CONFIRM.

## Contexto

A ACASA controla os pagamentos dos associados em uma planilha Excel legada
(`controle-de-pagamento.xlsx`). O objetivo do MVP é substituir esse controle por um
sistema web, com prazo global de **1 dia**.

Restrições fixas do baseline que condicionam a arquitetura:

- **T-01** aplicação web em Node.js;
- **T-02** persistência inicial em SQLite;
- **T-03** nenhum serviço externo obrigatório (sem PostgreSQL, Redis, Docker, fila ou SaaS);
- **T-04** bibliotecas npm permitidas desde que não criem infraestrutura externa;
- **T-05** banco criado/migrado por scripts versionados; banco real nunca versionado;
- **T-06** valores monetários sem `float` como fonte de verdade;
- **T-07** operações financeiras multi-registro devem poder usar transações.

O prazo é o fator dominante: qualquer complexidade que não pague seu custo dentro do
mesmo dia é risco puro.

## Decisão

### 1. Node.js + Express, aplicação monolítica server-side

Um único processo Node.js serve API e (futuramente) HTML renderizado no servidor.
Express foi escolhido por ser o roteador HTTP mais difundido do ecossistema, com
custo de aprendizado zero para quem der manutenção.

Consequência prática: **sem SPA, sem build step, sem TypeScript**. JavaScript
CommonJS simples roda direto pelo Node, sem transpilação. Isso elimina toda uma
classe de configuração (bundler, tsconfig, sourcemaps) que não agrega valor ao MVP.

### 2. SQLite via `better-sqlite3`

O baseline fixa **SQLite** (T-02) e nada além disso: a escolha da biblioteca de
acesso é **decisão de implementação deste MVP**, não uma exigência do baseline, e
pode ser revista sem alterar nenhuma regra FROZEN.

`better-sqlite3` é síncrono, o que remove `async/await` de toda a camada de dados e
torna transações triviais de escrever e de raciocinar. O banco é um único arquivo
local — nenhum servidor de banco precisa estar de pé para rodar o sistema (T-03).

A conexão (`src/db/connection.js`) sempre aplica:

- `PRAGMA foreign_keys = ON` — integridade referencial é responsabilidade do banco;
- `PRAGMA journal_mode = WAL` — leitura concorrente com escrita (ignorado em `:memory:`);
- `PRAGMA busy_timeout = 5000` — evita `SQLITE_BUSY` imediato.

O caminho do banco é configurável por `DB_PATH`, com padrão `data/acasa.sqlite`.
**Nenhum arquivo `.env` é necessário** para a aplicação funcionar.

`withTransaction(db, fn)` usa `BEGIN IMMEDIATE` (adquire o lock de escrita já na
abertura, em vez de falhar tardiamente num upgrade de lock) e faz `ROLLBACK`
automático em qualquer erro. É a base para T-07.

**Nota de instalação:** `better-sqlite3` é um módulo nativo e depende de um install
script para obter o binário pré-compilado. No ambiente verificado (npm 11.17.0) esse
script **executou normalmente** — o npm apenas emitiu um aviso informando que o
pacote ainda não constava em `allowScripts` e sugerindo `npm approve-scripts`.

O `package.json` passou a declarar `allowScripts` para `better-sqlite3`. Isso não
desbloqueia nada que estivesse bloqueado: torna a confiança nesse install script
**explícita e versionada**, elimina o aviso e deixa o comportamento independente do
padrão adotado por versões futuras do npm. O pacote publica binários pré-compilados;
não há dependência de toolchain C++ no caso comum.

### 3. Migrations SQL versionadas, sem ORM

Migrations são arquivos `.sql` puros em `migrations/`, nomeados `NNN_nome.sql`.
O runner (`src/db/migrator.js`) é ~100 linhas e garante:

| Requisito | Como |
|---|---|
| banco inexistente/vazio → cria tudo | o runner aplica todas as migrations pendentes |
| não reaplicar | tabela de controle `schema_migration` (chave = versão) |
| não destruir dados ao reexecutar | migrations já registradas são puladas, não re-rodadas |
| falha não deixa banco parcial | cada migration roda em `BEGIN IMMEDIATE` … `COMMIT`, com `ROLLBACK` no erro (DDL é transacional no SQLite) |
| registro do que foi aplicado | `schema_migration(version, nome, checksum, aplicada_em)` |

Adicionalmente, o runner grava o **SHA-256 do arquivo**. Se uma migration já
aplicada for editada, o checksum diverge e a execução **aborta com erro** em vez de
produzir ambientes silenciosamente diferentes. Migrations aplicadas são imutáveis:
correções entram como uma nova migration.

Nenhum ORM foi adotado. SQL direto mantém o schema auditável e evita que decisões
de modelagem financeira fiquem escondidas atrás de uma camada de mapeamento.

### 4. Dinheiro em centavos inteiros (T-06)

Toda coluna monetária é `INTEGER` representando **centavos** e tem o sufixo
`_centavos` no nome. Nenhuma coluna do schema usa `REAL`/`FLOAT`/`DOUBLE` — há um
teste automatizado que varre `PRAGMA table_info` de todas as tabelas e falha se
algum tipo de ponto flutuante aparecer.

### 5. Preservação histórica em vez de exclusão física (M-09)

Entidades financeiras (`movimento_financeiro`, `alocacao`, `ajuste_credito_debito`)
têm `ativo INTEGER NOT NULL DEFAULT 1`, `inativado_em` e `motivo_inativacao`.
Correções se fazem por inativação, e a trilha é **obrigatória no banco**:

```sql
CHECK (ativo = 1 OR (inativado_em IS NOT NULL
                     AND motivo_inativacao IS NOT NULL
                     AND trim(motivo_inativacao) <> ''))
```

Ou seja, nenhuma das três entidades pode ficar inativa sem registrar *quando* e
*por quê* — nem por `UPDATE`, nem por `INSERT` já inativo. Nenhuma FK usa
`ON DELETE CASCADE`; todas usam `ON DELETE RESTRICT`, de modo que o banco recusa
apagar um registro que ainda sustenta histórico.

O índice único de `alocacao` é **parcial** (`WHERE ativo = 1`): impede duas
alocações ativas do mesmo movimento na mesma competência, mas não bloqueia a
correção depois de inativar a anterior.

### 6. `node:test` para testes

O runner de testes nativo do Node cobre a necessidade sem nenhuma dependência de
desenvolvimento. Testes usam banco temporário em `os.tmpdir()` e nunca tocam
`data/`.

O script é `node --test` **sem argumentos**, que é a única forma portátil no
intervalo declarado em `engines` (>=20.11.0): passar um glob exige Node >= 22.6 e
passar um diretório deixou de funcionar no Node 24, que trata argumentos posicionais
como arquivos. Sem argumentos, o runner descobre `tests/**/*.test.js` e ignora
`tests/helpers/`, que não casa com o padrão de nome de teste.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| `node:sqlite` (embutido no Node 22.5+) | Zero dependências, mas exige Node muito recente e sua API ainda está estabilizando, o que conflita com `engines: >=20.11.0`. Migrar depois é barato: a troca fica contida em `src/db/connection.js`. |
| Prisma / Sequelize / Knex | Camada extra de abstração e build/codegen num projeto de 1 dia, escondendo justamente as constraints financeiras que precisam ser auditáveis. |
| Fastify | Ganho de performance irrelevante nesta escala; Express tem mais familiaridade. |
| SPA (React/Vue) | Build step e complexidade de estado sem benefício para telas de cadastro e conferência. |
| Docker | Viola T-03 como requisito de execução. |
| Valor monetário como `TEXT` decimal | Comparações e somas em SQL ficam frágeis; centavos inteiros resolvem com aritmética exata nativa. |

## Consequências

**Positivas**

- `npm install && npm run migrate && npm start` é tudo que um desenvolvedor precisa.
- Nenhum serviço externo, nenhuma porta além da HTTP da própria aplicação.
- O schema é legível como SQL puro, o que facilita a conferência contra o baseline.
- Testes rodam em ~1s, viabilizando iteração rápida no prazo de 1 dia.
- Backup do banco é copiar um arquivo.

**Negativas / limites aceitos**

- SQLite serializa escritas: adequado para a escala da ACASA (dezenas de associados),
  mas não para concorrência alta de escrita. Se isso mudar, a migração para
  PostgreSQL exigirá reescrever `src/db/` e revisar o SQL.
- `better-sqlite3` é módulo nativo: um `npm install` num ambiente sem binário
  pré-compilado precisaria de toolchain C++.
- API síncrona bloqueia o event loop durante as queries. Aceitável no volume
  previsto; não use para consultas longas sem paginação.
- Sem ORM, a validação de domínio fica na aplicação (`src/services/`) e nas
  constraints SQL. Os dois lados precisam ser mantidos em sincronia —
  `src/domain/constants.js` espelha os `CHECK` da migration 001.

## Fora de escopo desta decisão

Os seguintes pontos permanecem **TO CONFIRM** no baseline e **não** foram
transformados em regra por esta arquitetura: significado dos códigos legados
`a`/`i`/`DESLIGADO`, identificação de associado pelos centavos do depósito, valor e
vigência da mensalidade, abreviações (`c`, `f15`, `LG`, `TLA`, `TMC`, `TRA`), cores
não documentadas, armazenamento de arquivos de comprovante, autenticação e perfis,
conciliação bancária, transferência de titularidade e estratégia de branches.

O schema apenas **reserva espaço** para esses conceitos (por exemplo,
`associado.legacy_status_code`, `legacy_cell.estilo`, `comprovante.referencia_externa`)
sem lhes atribuir semântica.
