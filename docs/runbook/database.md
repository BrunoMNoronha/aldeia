# Runbook — banco de dados

O projeto está no meio da migração SQLite → PostgreSQL
([ADR-003](../adr/ADR-003-postgresql-persistencia.md)). **Existem duas trilhas de
migration no repositório, e elas não se misturam.**

| Trilha | Diretório | Quem usa hoje |
|---|---|---|
| SQLite | `migrations/` (`001`, `002`, `003`) | **O runtime.** `npm run migrate`. |
| PostgreSQL | `migrations/postgresql/` (`001`) | Somente os testes de integração. |

A separação por subdiretório é o que mantém as duas trilhas isoladas:
`listMigrations` do migrator SQLite só aceita arquivos que casem com
`NNN_nome.sql` na raiz de `migrations/`, então `postgresql/` é ignorada por ele.

## SQLite — persistência do runtime

```bash
npm run migrate
```

Cria ou atualiza o banco em `DB_PATH` (padrão `data/acasa.sqlite`). Reexecutar é
seguro: migrations já registradas em `schema_migration` são puladas, não
re-rodadas.

`data/` é ignorado pelo Git — **nenhum banco com dados reais é versionado.**

## PostgreSQL — fundação, ainda ociosa

O schema PostgreSQL (`migrations/postgresql/001_initial_schema.sql`) reproduz o
**estado lógico final** de `001` + `002` + `003` do SQLite. Não é uma conversão
textual das três: as colunas da 002 já nascem na tabela e os índices da 003 já
nascem criados.

### Não há script npm de migration PostgreSQL

O migrator existe e está testado (`src/db/postgresql/migrator.js`), mas **nenhum
script de linha de comando o invoca** — `npm run migrate` é exclusivamente
SQLite. Criar esse comando pertence à fase **PG-2/PG-6**, quando algum
consumidor real precisar do banco.

Enquanto isso, a prova de que **um PostgreSQL vazio migra até o estado atual**
vem de `tests/postgresql-migrations.test.js`, que cria um schema dedicado do
zero, aplica as migrations e verifica o resultado. Esse teste só roda com
`TEST_DATABASE_URL` configurada.

### Configuração

| Variável | Papel |
|---|---|
| `DATABASE_URL` | Conexão oficial. **Ausente não é erro** nesta fase — é o estado normal de quem só usa o runtime SQLite. |
| `TEST_DATABASE_URL` | Conexão dos testes de integração. **Sem fallback** para `DATABASE_URL`. |
| `DB_PATH` | Caminho do banco SQLite. Padrão `data/acasa.sqlite`. |
| `PORT` | Porta HTTP. Padrão `3000`. |

### A barreira de segurança dos testes

Testes de integração criam e derrubam schema, e a falha que essa barreira
previne **não tem desfazer**. `tests/helpers/postgres.js` **falha fechado**: na
dúvida, pula o teste em vez de tentar assim mesmo. Ele recusa quando

- `TEST_DATABASE_URL` não está definida;
- a URL é inválida ou o protocolo não é `postgres:`/`postgresql:`;
- a URL é **idêntica** a `DATABASE_URL`;
- o nome do banco está na lista proibida (`postgres`, `template0`, `template1`,
  `prod`, `producao`, `production`, `acasa`);
- o nome do banco **não contém `test`**.

O isolamento é por **schema dedicado**, criado e derrubado pelo próprio teste.
Nenhum teste executa `DROP DATABASE`, `DROP SCHEMA public`, `TRUNCATE` ou
`DELETE` em massa.

Configuração típica para desenvolvimento:

```bash
TEST_DATABASE_URL=postgres://usuario:senha@localhost:5432/acasa_test
```

Sem ela, os testes que exigem banco real aparecem como **skipped** no relatório
do `node --test` — visivelmente, para não confundir "não testado" com "testado e
verde".

## Regras que valem nas duas trilhas

- **Migration aplicada é imutável** (T-05). O migrator grava o **SHA-256** do
  conteúdo do arquivo junto do registro em `schema_migration`, na **mesma
  transação** que aplica o SQL. Editar uma migration já aplicada faz a execução
  **abortar**. Correção entra como **migration nova**.
- **Dinheiro nunca é ponto flutuante** (T-06). `INTEGER` (centavos) no SQLite,
  `BIGINT` no PostgreSQL. `int4` estreitaria o domínio para ~R$ 21 milhões —
  seria mudança de regra disfarçada de conversão de tipo. Há teste que varre o
  SQL das migrations atrás de `REAL`/`FLOAT`/`DOUBLE PRECISION`.
- **`int8` do `node-postgres` chega como string.** O parser em
  `src/db/postgresql/connection.js` converte para `Number` **somente** dentro de
  `Number.MAX_SAFE_INTEGER` e **lança** fora dela — falha ruidosa em vez de
  centavo silenciosamente errado.
- **Operação financeira multi-registro é atômica** (T-07): `BEGIN IMMEDIATE` no
  SQLite, `BEGIN`/`COMMIT`/`ROLLBACK` sobre um client dedicado do pool no
  PostgreSQL. Em ambos, a alteração e o `audit_log` ficam na mesma transação.
- **Nenhuma FK de entidade financeira usa `ON DELETE CASCADE`** — todas usam
  `ON DELETE RESTRICT`. Há teste que varre o `information_schema` para provar.
- **Nenhum banco real, dump, credencial ou URL com senha é commitado.**

## Backup e restauração

**Não decidido.** Não há estratégia operacional de backup confirmada para
PostgreSQL, e inventar uma aqui seria criar requisito sem decisão. O ADR-003
registra apenas que o banco SQLite de origem é **preservado** durante toda a
transição, e que o cutover (PG-6) exige estratégia explícita de retorno, escrita
antes de ser executado.

Enquanto o runtime for SQLite, backup é copiar o arquivo em `DB_PATH`.
