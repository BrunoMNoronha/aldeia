# ADR-003 — Adotar PostgreSQL como persistência principal

- **Status:** **aceito**. Fases concluídas: **PG-0** (governança) + **PG-1** (fundação paralela).
- **Data:** 2026-08-17
- **Baseline normativo vigente:** `KB-BASELINE-ACASA-v2.0` — produzido pelas alterações
  normativas redigidas neste ADR (ver "Alterações normativas", abaixo)
- **Baseline anterior:** `KB-BASELINE-ACASA-v1.0.pdf` (v1.0 — FROZEN, **imutável**, não editado)
- **Relação com ADR-001 e ADR-002:** substitui parcialmente (ver abaixo)
- **Superseded by:** —

> **Estado da migração.** A decisão está aceita e a fundação existe, mas
> **PostgreSQL ainda não é o banco do runtime**. A camada `src/db/postgresql/` é
> paralela e nenhum service, rota ou script a consome; todo acesso a dados
> continua passando por SQLite até **PG-6**. Ver a tabela de fases em
> "Estratégia de cutover".

## Relação com os ADRs anteriores

O **ADR-001 e o ADR-002 não são revogados**. Este ADR substitui **apenas** os
pontos em conflito direto com a troca de banco.

| Ponto anterior | O que passa a valer |
|---|---|
| **ADR-001 / ADR-002: SQLite como persistência (T-02)**, com `DB_PATH` e `data/acasa.sqlite` | A persistência oficial passa a ser **PostgreSQL**, configurada por `DATABASE_URL`. SQLite permanece no repositório durante PG-1…PG-5 e sai depois. |
| **ADR-002: `better-sqlite3` e os PRAGMAs obrigatórios** | O driver oficial passa a ser **`pg` (node-postgres)**, com **pool de conexões**. Os PRAGMAs não têm equivalente e não são portados — `foreign_keys` é sempre ativo no PostgreSQL, e WAL é interno ao servidor. |
| **ADR-002: `withTransaction` com `BEGIN IMMEDIATE`** | T-07 passa a ser cumprido por `BEGIN`/`COMMIT`/`ROLLBACK` sobre um client dedicado do pool. `BEGIN IMMEDIATE` é sintaxe exclusiva do SQLite e existia por causa do lock de arquivo, que o PostgreSQL não tem. |
| **ADR-002: acesso síncrono ao banco** | O acesso passa a ser **assíncrono** (`async/await`). Ver "Consequências". |
| **ADR-002: ausência de infraestrutura externa obrigatória (T-03)** | Passa a existir **um** serviço externo obrigatório: o próprio PostgreSQL. Nenhum outro é autorizado por este ADR. |

**Permanece integralmente válido**, e nada aqui o toca:

- **T-01** — Node.js como runtime;
- **T-06** — dinheiro nunca depende de ponto flutuante binário;
- **T-08** — framework web é decisão de implementação; o ADR-002 (Next.js 16
  App Router) segue valendo, e a migração NX-1…NX-3 é independente desta;
- **M-01 a M-10** e **F-01 a F-11**, sem exceção;
- migrations SQL versionadas, sem ORM, com checksum e imutabilidade do que já
  foi aplicado (T-05);
- separação entre domínio, persistência e importação (`src/domain`,
  `src/services`, `src/db`, `src/import`);
- `node:test` como runner, com banco temporário e nunca `data/`;
- todos os pontos **TO CONFIRM**, que continuam TO CONFIRM.

## Contexto

O SQLite foi a persistência inicial do MVP (ADR-001) e cumpriu o que se pedia
dele: zero infraestrutura, um arquivo, um `npm install`. O sistema cresceu — hoje
há ledger financeiro normalizado, importação do legado com proveniência célula a
célula, fila de comprovantes e uma migração de framework web em curso — e a
persistência passou a ser o ponto em que as limitações aparecem primeiro:
escrita serializada em um único arquivo, ausência de acesso concorrente real
entre processos, e um caminho de operação (backup, réplica, acesso remoto) que
depende de copiar arquivo.

**O responsável pelo projeto aprovou a migração para PostgreSQL.** Essa decisão é
humana e já está tomada; este ADR a registra e delimita.

O ponto delicado é que **a decisão altera requisitos técnicos FROZEN do baseline
v1.0** — o que os ADRs anteriores nunca precisaram fazer, porque tratavam de
pontos que o baseline deixava explicitamente em aberto (T-08). Daí a existência
da seção "Alterações normativas propostas", abaixo.

**Nenhuma regra funcional ou de domínio muda.** Esta é uma decisão de
persistência, não de negócio.

## Decisão

1. **PostgreSQL** passa a ser a persistência oficial do sistema.
2. **`pg` (node-postgres)** é o driver. **Nenhum ORM** é introduzido.
3. **SQL explícito** continua sendo escrito à mão, como já era.
4. **`DATABASE_URL`** é a configuração principal da conexão.
5. **`TEST_DATABASE_URL`** é a configuração — separada e obrigatória — dos testes
   de integração. Não há fallback para `DATABASE_URL`.
6. **Migrations PostgreSQL versionadas** no repositório, em
   `migrations/postgresql/`, com as mesmas garantias de T-05.
7. O acesso ao PostgreSQL é **assíncrono**, com **pool de conexões**.
8. **SQLite é mantido temporariamente** durante a transição. `better-sqlite3`
   não é removido nesta fase, nem as migrations SQLite históricas.
9. **Nenhum fornecedor específico** de PostgreSQL é adotado: nada de Supabase,
   Neon, Railway, RDS ou equivalente como requisito arquitetural. Qualquer
   PostgreSQL alcançável por `DATABASE_URL` serve.
10. **Docker é conveniência, não requisito.** Pode ser usado para subir um
    PostgreSQL local de desenvolvimento/teste, mas o projeto não pode passar a
    exigir Docker para ser executado.

### Por que não um ORM

A regra financeira mora em `src/services/` e é auditada lendo SQL. Um ORM
acrescentaria uma camada de tradução exatamente entre a regra e o que o banco
executa, no momento em que o time precisa da relação mais direta possível entre
as duas coisas. Além disso, a migração já troca o banco *e* o modelo de execução
(síncrono → assíncrono); acrescentar um terceiro eixo de mudança tornaria
impossível atribuir uma eventual regressão financeira a uma causa.

## Consequências

**Positivas**

- Acesso concorrente real, e não escrita serializada em arquivo.
- Índices parciais, DDL transacional e `RETURNING` nativos — o DDL transacional,
  em particular, torna o migrator PostgreSQL *mais* seguro que o SQLite.
- Operação (backup, réplica, acesso remoto) deixa de depender de copiar arquivo.

**Negativas / custos assumidos — nenhum destes é opcional**

- **A API deixa de ser síncrona.** `better-sqlite3` é síncrono; `pg` não é. Todo
  service, repositório, rota e script que hoje lê o banco em linha reta passa a
  precisar de `async/await`, e isso **se propaga por todos os chamadores**. Não
  existe wrapper honesto que faça o `pg` parecer síncrono, e tentar escondê-lo
  atrás de um seria trocar um problema visível por um problema silencioso.
- **Impacto direto**, a ser tratado em PG-2 e PG-3: `src/services/ledger.js`
  (~1500 linhas), `src/services/comprovantes.js`, `src/services/associados.js`,
  `src/import/legacy-importer.js`, `src/import/legacy-diagnostics.js`,
  `src/web/`, `app/`, `scripts/` e toda a suíte de testes existente.
- **Placeholders mudam de `?` para `$1`, `$2`, …** Não é substituição textual: a
  numeração é posicional e reordenar um parâmetro sem renumerar produz uma query
  que executa e retorna o resultado errado, em silêncio.
- **Particularidades SQLite precisam de substituto explícito**, uma a uma:
  `PRAGMA foreign_keys` / `busy_timeout` / `journal_mode` (sem equivalente e sem
  necessidade), `BEGIN IMMEDIATE` (vira `BEGIN`), `strftime(...)` (vira `now()`),
  `sqlite_master` (vira `information_schema` / `pg_indexes` / `to_regclass`),
  `lastInsertRowid` (vira `RETURNING`), `db.prepare(...).get()/.all()/.run()`
  (vira `await client.query(...)` com `rows`).
- **É necessária uma ferramenta explícita de transferência SQLite →
  PostgreSQL**, com preservação de ids históricos, e ela ainda não existe.
- **É necessária uma suíte executada contra PostgreSQL real.** As 347+
  validações atuais rodam contra SQLite em arquivo temporário e não provam nada
  sobre o comportamento do PostgreSQL.
- **A migração NÃO está concluída quando o schema PostgreSQL existe.** Schema
  criado é o começo. Enquanto os serviços lerem SQLite, o PostgreSQL é
  infraestrutura ociosa.
- **Passa a existir um serviço externo obrigatório**, o que o ADR-001 e o
  ADR-002 evitavam deliberadamente. `npm install && npm start` deixa de ser
  suficiente: passa a ser preciso um PostgreSQL alcançável.

## Estratégia de cutover

| Fase | Escopo | Estado |
|---|---|---|
| **PG-0** | Governança: este ADR e a proposta de alteração normativa. | **feito** |
| **PG-1** | Fundação PostgreSQL paralela: `pg`, conexão/pool, `withTransaction`, health, migrator, migrations e testes. Runtime **inalterado**. | **feito** |
| **PG-2** | Conversão dos acessos a dados: services, importador, scripts e rotas passam a `async` e a SQL PostgreSQL. | pendente |
| **PG-3** | Suíte equivalente: todos os testes financeiros existentes rodando contra PostgreSQL. | pendente |
| **PG-4** | Migração dos dados SQLite → PostgreSQL, com preservação de ids e proveniência. | pendente |
| **PG-5** | Validação: conferência de totais, proveniência e contagens entre os dois bancos. | pendente |
| **PG-6** | Mudança do runtime: a aplicação passa a ler e escrever no PostgreSQL. | pendente |
| **PG-7** | Retirada do SQLite: remoção de `better-sqlite3`, de `src/db/connection.js` e do que ficou órfão. | pendente |

Nenhuma fase pode ser considerada concluída com a suíte vermelha.

## Rollback

Durante toda a transição:

- **o banco SQLite de origem é preservado.** Nenhuma ferramenta de transferência
  pode modificar, mover ou apagar o SQLite ao copiar dados — a cópia é de
  leitura apenas, e essa é a garantia que torna PG-4 reversível;
- **o cutover (PG-6) exige estratégia explícita de retorno**, escrita antes de
  ser executado: qual é o critério de reversão, quem decide, e o que acontece com
  os dados escritos no PostgreSQL depois do corte. Isso não é decidido aqui.

Até PG-6, reverter é apagar código: nada em produção depende do PostgreSQL.

---

# Alterações normativas para `KB-BASELINE-ACASA-v2.0`

> **Estado desta seção.** Ela foi redigida como *proposta* e **foi adotada**: o
> responsável pelo projeto declarou `KB-BASELINE-ACASA-v2.0` como o baseline
> vigente, com o conteúdo abaixo. O texto permanece como está por ser o registro
> normativo do que mudou.
>
> **Pendência de governança:** o PDF do v2.0 não está versionado neste
> repositório, então esta seção é hoje a fonte textual do que o v2.0 determina.
> Publicar o PDF — ou registrar onde ele é mantido — continua pendente.

**O `KB-BASELINE-ACASA-v1.0.pdf` é histórico, imutável e NÃO foi editado,
sobrescrito nem substituído.** Ele permanece como o registro do que valia antes.

> Nota: o repositório não possui convenção própria para fontes de baseline
> (`docs/` contém apenas `docs/adr/`). Conforme a instrução da tarefa, a proposta
> foi registrada **aqui, dentro do ADR**, em vez de inventar uma estrutura nova.

**Versão anterior:** `KB-BASELINE-ACASA-v1.0`

**Motivo:** migração aprovada da persistência de SQLite para PostgreSQL.

## Requisitos substituídos

| Req. | Texto v1.0 (sentido) | Texto proposto para v2.0 |
|---|---|---|
| **T-02** | A persistência inicial do sistema deve utilizar SQLite. | **A persistência principal do sistema deve utilizar PostgreSQL.** |
| **T-03** | PostgreSQL não pode ser requisito sem aprovação explícita; o sistema roda sem infraestrutura externa. | **PostgreSQL passa a fazer parte da infraestrutura obrigatória.** Nenhum outro serviço externo adicional — Redis, filas, SaaS obrigatório, fornecedor específico de PostgreSQL etc. — pode ser introduzido sem aprovação explícita. |
| **T-05** | O banco SQLite deve ser criado/migrado por scripts versionados no repositório. | **O banco PostgreSQL deve ser criado/migrado integralmente por scripts versionados no repositório.** Dumps, bancos reais, credenciais e segredos não devem ser commitados. |
| **T-07** | Operações que alterem múltiplos registros financeiros devem ocorrer em uma única transação SQLite. | **Operações que alterem múltiplos registros financeiros devem ocorrer em uma única transação PostgreSQL.** |

## Critérios globais de aceite

Todo critério global do v1.0 que mencione **SQLite** passa a mencionar
**PostgreSQL**, com o mesmo sentido. Em particular:

- "o banco é reconstruível do zero pelas migrations SQLite versionadas" →
  **"…pelas migrations PostgreSQL versionadas"**;
- "os testes usam banco SQLite temporário, nunca `data/`" → **"os testes usam um
  banco/schema PostgreSQL de teste, configurado exclusivamente por
  `TEST_DATABASE_URL`, nunca o banco apontado por `DATABASE_URL`"**;
- "nenhum banco real é commitado" permanece **sem alteração de sentido**, e passa
  a abranger também dumps e URLs de conexão com credencial.

## O que esta proposta NÃO altera

**Nenhuma regra funcional ou de domínio.** Permanecem FROZEN, com o texto
original do v1.0: **T-01**, **T-06**, **T-08**, **M-01 a M-10** e **F-01 a
F-11**. Nenhum ponto **TO CONFIRM** é resolvido por esta proposta.

---

# O que a fase PG-1 efetivamente fez

Uma camada PostgreSQL **paralela**, que nenhum service, rota ou script utiliza
ainda. O runtime continua inteiramente em SQLite.

```
src/db/postgresql/connection.js   pool, withClient, withTransaction, parser int8
src/db/postgresql/health.js       sonda SELECT 1 + contagem de migrations
src/db/postgresql/migrator.js     migrator assíncrono com checksum SHA-256
migrations/postgresql/001_initial_schema.sql
```

A separação por diretório é o que permite converter os consumidores um a um na
PG-2, sem um diff único e irrevisável.

## Configuração

`DATABASE_URL` e `TEST_DATABASE_URL` são resolvidas em `src/config.js` e ambas
retornam `null` quando ausentes — a ausência de PostgreSQL **não** é erro de
configuração nesta fase, é o estado normal de quem só usa o runtime SQLite.

`TEST_DATABASE_URL` **nunca** cai para `DATABASE_URL`. Sem ela, os testes que
exigem banco real são **pulados de forma visível** no relatório do `node --test`;
silenciar isso confundiria "não testado" com "testado e verde".

## Pool e transação

Pool compartilhado por processo (`getPool()`), com `connectionTimeoutMillis`
para que falha de conexão vire erro rápido em vez de request pendurada. Um
listener de `error` no pool é obrigatório: sem ele, um client ocioso que morre
derruba o processo Node inteiro.

`withTransaction(pool, fn)` cumpre `connect → BEGIN → fn(client) → COMMIT →
release`, e `ROLLBACK → release → rethrow` no erro, com `release()` em `finally`.

Duas decisões explícitas:

- **`fn` recebe o client e deve usar exatamente esse client.** Uma operação que
  volte a chamar `pool.query()` no meio do bloco pega outra conexão, fica fora da
  transação e não é desfeita pelo `ROLLBACK` — que é precisamente a atomicidade
  que T-07 exige. Há teste cobrindo essa distinção.
- **Sem nesting (`SAVEPOINT`) nesta fase.** Nenhum consumidor precisa disso
  ainda, e transação aninhada implícita é fonte clássica de commit parcial.

## Health check

`verificarSaudePostgresql(resolvePool)` espelha o contrato de `src/db/health.js`:
devolve `{ saudavel, corpo }` e **não** decide status HTTP. Distingue **conexão**
(servidor fora do ar, timeout, SQLSTATE classe 08) de **consulta** (o servidor
respondeu; o erro é de schema/aplicação) — a distinção importa porque as duas
falhas têm donos diferentes.

**O `/health` público não foi alterado.** Ele continua respondendo pelo SQLite:
trocar a fonte do health check é trocar o runtime, e isso é PG-6.

## Migrator e checksum

Mesmas garantias do migrator SQLite, que são T-05 e não mudam por causa do banco:
ordem determinística por versão numérica, execução única, registro em
`schema_migration`, **checksum SHA-256 do conteúdo do arquivo**, aborto quando o
conteúdo de uma migration já aplicada muda, atomicidade por migration e rollback
em falha.

O checksum é o SHA-256 do texto UTF-8 do arquivo, gravado junto do registro na
**mesma transação** que aplica o SQL. Se o `INSERT` de controle ficasse fora
dela, o schema poderia avançar sem rastro do que rodou.

Duas diferenças deliberadas em relação ao SQLite: a API é assíncrona, e
`aplicada_em` usa `TIMESTAMPTZ`/`now()` em vez de `strftime()` — copiar a função
do SQLite para cá seria carregar a peculiaridade de um banco para dentro do
outro sem nenhum ganho.

O DDL do PostgreSQL é transacional, então o `BEGIN`/`COMMIT` ao redor de cada
migration realmente desfaz tabelas e índices criados. Há teste cobrindo isso.

## Equivalência do schema

`migrations/postgresql/001_initial_schema.sql` reproduz o **estado lógico final**
de `001` + `002` + `003` do SQLite — que permanecem **intactas**. É uma migration
nova de uma trilha nova, não uma conversão textual das três: as colunas da 002 já
nascem na tabela e os índices da 003 já nascem criados. O histórico de *como* o
SQLite chegou lá é do SQLite.

| Aspecto | SQLite | PostgreSQL | Por quê |
|---|---|---|---|
| **Identidade** | `INTEGER PRIMARY KEY AUTOINCREMENT` | `INTEGER GENERATED BY DEFAULT AS IDENTITY` | `BY DEFAULT`, não `ALWAYS`: PG-4 precisa **inserir ids históricos explicitamente** para não quebrar FKs já gravadas. Contrapartida a tratar em PG-4: após inserir ids explícitos, a sequence precisa de `setval`, senão o próximo INSERT automático colide. |
| **Dinheiro** | `INTEGER` (64 bits no SQLite) | `BIGINT` | `int4` **estreitaria** o domínio de ~9,2e18 para ~2,1e9 centavos (R$ 21 milhões) — mudança de regra disfarçada de conversão de tipo. `REAL`/`FLOAT`/`DOUBLE PRECISION` seguem proibidos (T-06), e há teste que varre o SQL das migrations atrás deles. |
| **int8 no driver** | n/a | parser validado | `node-postgres` entrega `int8` como **string**. O parser em `connection.js` converte para `Number` **somente** dentro de `Number.MAX_SAFE_INTEGER` e **lança** fora dela — falha ruidosa em vez de centavo silenciosamente errado. Conversão global sem validação seria exatamente a coerção insegura que T-06 proíbe. |
| **Booleano** | `INTEGER CHECK (ativo IN (0,1))` | `BOOLEAN` | O CHECK existia para simular um booleano que o SQLite não tem. **M-09 não muda:** o CHECK de inativação continua exigindo QUANDO e POR QUE. |
| **Timestamp** | `TEXT` ISO-8601 + `strftime()` | `TIMESTAMPTZ` + `now()` | O texto era a convenção possível no SQLite, não uma regra de domínio. |
| **Data civil** | `TEXT` | `DATE` | `movimento_financeiro.data`, `ajuste.data` e `comprovante.data` são data civil do fato financeiro, sem hora e sem fuso. Promovê-las a instante introduziria um deslocamento de fuso capaz de **mover um pagamento de mês** — e portanto de competência (M-10). |
| **FKs** | `ON DELETE RESTRICT` | `ON DELETE RESTRICT` | Idêntico. Nenhuma FK de entidade financeira ganhou `CASCADE`; há teste que varre `information_schema` inteiro para provar isso. |
| **`associado_id` do movimento** | opcional | opcional | M-05: depósito não identificado existe sem associado. |
| **Índices parciais** | `WHERE ativo = 1`, `WHERE movimento_id IS NOT NULL` | `WHERE ativo`, `WHERE movimento_id IS NOT NULL` | Uma alocação **ativa** por movimento+competência; um comprovante por movimento **vinculado**, mas comprovantes soltos aos montes (M-04). Há teste que verifica que os dois índices continuam **parciais** — sem o `WHERE`, a regra mudaria. |
| **CHECKs** | todos | todos, agora **nomeados** | `ck_movimento_inativacao_justificada` etc. Nomear é o que permite ao teste afirmar *qual* regra recusou, em vez de apenas que algo recusou. |
| **`trim(x) <> ''`** | SQLite | idêntico em PostgreSQL | Motivo de inativação em branco continua não sendo motivo. |
| **Proveniência** | `legacy_cell` + `legacy_cell_link` | idêntico | Arquivo + `sha256` → aba → endereço → linha/coluna → `valor_bruto` → `tipo_original`/`formula`/`valor_json`. Referência polimórfica continua sem FK, de propósito. |

## Segurança dos testes

Testes de integração criam e derrubam schema. A barreira que decide se eles podem
rodar é, por isso, o ponto mais sensível do pacote PG-1 — a falha que ela previne
não tem desfazer. `tests/helpers/postgres.js` **falha fechado**: na dúvida, pula
o teste em vez de "tentar assim mesmo". Recusa quando

- `TEST_DATABASE_URL` não está definida;
- a URL é inválida ou o protocolo não é `postgres:`/`postgresql:`;
- a URL é **idêntica** a `DATABASE_URL`;
- o nome do banco está na lista proibida (`postgres`, `template0`, `template1`,
  `prod`, `producao`, `production`, `acasa`);
- o nome do banco **não contém `test`** — última barreira, e a mais simples de
  auditar: o banco precisa se declarar banco de teste no próprio nome.

O isolamento é por **schema dedicado**, criado e derrubado pelo próprio teste.
Nenhum teste executa `DROP DATABASE`, `DROP SCHEMA public`, `TRUNCATE` ou
`DELETE` em massa: mesmo que a URL de teste apontasse para um banco
compartilhado, o raio de ação seria o schema que aquele teste criou.

Essa barreira é testada sem PostgreSQL nenhum, em
`tests/postgresql-seguranca-testes.test.js`.

## O que a PG-1 explicitamente NÃO fez

Migração de dados; conversão de `ledger.js`, `comprovantes.js`, `associados.js`,
do importador legado ou de qualquer rota; mudança do runtime; alteração do
`/health` público; remoção do SQLite ou do `better-sqlite3`; alteração de
qualquer migration SQLite histórica; ORM; e qualquer resolução de ponto
TO CONFIRM.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| Permanecer em SQLite | Decisão humana já tomada. Este ADR registra a decisão, não a reabre. |
| Converter tudo em um único passo | Trocaria banco, modelo de execução (síncrono → assíncrono) e dados no mesmo diff. Uma regressão financeira ficaria sem causa atribuível. |
| Camada de abstração que sirva SQLite e PostgreSQL | Um ORM caseiro, com a desvantagem de ser mantido por nós e de esconder as diferenças exatas que a migração precisa expor. |
| Wrapper síncrono sobre `pg` | Não existe versão honesta disso em Node. Trocaria um problema visível por um silencioso. |
| Adotar Supabase/Neon/RDS | Acoplaria a arquitetura a um fornecedor. T-03 (proposto) mantém PostgreSQL genérico como o único serviço obrigatório. |
| Exigir Docker | Docker é conveniência de desenvolvimento. Torná-lo requisito de execução acrescentaria uma segunda dependência obrigatória sem necessidade. |
| `NUMERIC` para dinheiro | `BIGINT` em centavos já é exato e preserva a semântica atual. Trocar a unidade de verdade de centavo inteiro para decimal seria mudança de regra (T-06), não de tipo. |
| Reproduzir 001/002/003 como três migrations PostgreSQL | Reencenaria a história do SQLite sem acrescentar nenhuma garantia. O que importa é o estado lógico final, e ele é verificado por teste. |
