# Runbook — desenvolvimento local

## Requisitos

- **Node.js >= 20.11** (`engines` do `package.json`).
- **PostgreSQL** — obrigatório pelo baseline v2.0, mas **ainda não exigido para
  executar a aplicação**: o runtime continua em SQLite até PG-6. É necessário
  apenas para rodar os testes de integração PostgreSQL (ver
  [`database.md`](database.md)).
- Nada além disso. Sem Docker obrigatório, sem Redis, sem fila, sem SaaS.

Nenhum arquivo `.env` é necessário para a aplicação funcionar. `.env.example`
documenta as variáveis opcionais.

## Subir o projeto

```bash
npm install
npm run migrate
npm run build
npm start
```

Em desenvolvimento, `npm run dev` dispensa o `build`.

Verificação:

```bash
curl http://localhost:3000/health
```

Resposta esperada:

```json
{ "status": "ok", "database": "ok", "migrations": 3 }
```

## Os dois servidores — e por que ainda são dois

`npm start` sobe o **Next.js**, que na fase NX-0 serve apenas `/` e `/health`.
As APIs financeiras e as telas de associados ainda pertencem ao **Express**:

```bash
npm run start:express
```

Isto é **transitório** e termina em NX-3 — ver
[ADR-002](../adr/ADR-002-nextjs-app-router.md) e
[`../architecture/overview.md`](../architecture/overview.md#transporte-onde-cada-rota-responde-hoje),
que lista qual rota responde em qual servidor.

O produto **não** exige dois processos em produção: o segundo existe apenas
enquanto a migração não conclui.

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Sobe o Next.js em desenvolvimento |
| `npm run build` | Build de produção do Next.js |
| `npm start` | Sobe o Next.js em produção (exige `npm run build` antes) |
| `npm run start:express` | Sobe o servidor Express transitório (sai em NX-3) |
| `npm run migrate` | Cria/atualiza o banco **SQLite** a partir das migrations |
| `npm run import:legacy` | Importa um `.xlsx` legado para a camada bruta |
| `npm run legacy:associados` | Materializa associados a partir das colunas A/B de uma importação |
| `npm run legacy:diagnostico` | Gera o relatório de ambiguidades/discrepâncias do legado |
| `npm test` | Roda a suíte com `node:test` |

Não há script de migration PostgreSQL — ver [`database.md`](database.md).

## Testes

```bash
npm test
```

`node --test` **sem argumentos** é deliberado: é a única forma portátil no
intervalo declarado em `engines` (>=20.11.0). Passar um glob exige Node >= 22.6
e passar um diretório deixou de funcionar no Node 24. Sem argumentos, o runner
descobre `tests/**/*.test.js` e ignora `tests/helpers/`.

Os testes SQLite usam banco temporário em `os.tmpdir()` e **nunca** tocam
`data/`. Os testes de integração PostgreSQL são **pulados de forma visível**
quando `TEST_DATABASE_URL` não está definida — nunca redirecionados para
`DATABASE_URL`. Ver [`database.md`](database.md).

## Fontes legadas

A planilha e a ficha de cadastro **não estão no Git** e não são baixadas por
nenhum script. Elas precisam existir localmente para rodar a importação, e o
caminho é passado como argumento:

```bash
npm run import:legacy -- "<caminho/para/arquivo.xlsx>"
```

Ver [`../legacy/source-manifest.md`](../legacy/source-manifest.md).
