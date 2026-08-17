# ADR-002 — Migração incremental para Next.js (App Router)

- **Status:** proposto (aguardando aceite do responsável pelo projeto)
- **Data:** 2026-08-16
- **Baseline normativo:** `KB-BASELINE-ACASA-v1.0.pdf` (v1.0 — FROZEN)
- **Relação com o ADR-001:** substitui parcialmente (ver seção abaixo)

## Relação com o ADR-001

O **ADR-001 não é revogado nem apagado**: ele continua sendo o registro histórico
da arquitetura do MVP e a maior parte do seu conteúdo permanece em vigor. Este ADR
substitui **apenas** os pontos que entram em conflito direto com a adoção do Next.js.

### O que este ADR supersede no ADR-001

| Ponto do ADR-001 | O que passa a valer |
|---|---|
| **Express como framework web principal** (seção 1) | O framework web passa a ser **Next.js 16 (App Router)**. Express permanece no repositório apenas durante NX-0…NX-2 e é removido em NX-3. |
| **HTML server-side por concatenação de strings como direção de UI** (seção 1) | A direção de UI passa a ser **React** (Server Components e, quando necessário, Client Components). `src/web/views/` é substituído em NX-2. |
| **Ausência de build step** ("sem SPA, sem build step, sem TypeScript", seção 1) | O projeto passa a ter **build step obrigatório** para produção (`npm run build`). A parte "sem TypeScript" **continua valendo** — não é alterada por este ADR. |
| **`src/server.js` como entry point web** (seção 1 e "Consequências") | O entry point de produção passa a ser **`next start`**. `src/server.js` sobrevive como `npm run start:express`, transitório, até NX-3. |

Em consequência, a linha do ADR-001 `npm install && npm run migrate && npm start`
passa a ser `npm install && npm run migrate && npm run build && npm start`.

### O que permanece integralmente válido no ADR-001

Nada disto é tocado por este ADR — a migração é **de transporte**:

- **SQLite** como persistência (T-02), incluindo o caminho configurável por
  `DB_PATH` e o padrão `data/acasa.sqlite`;
- **`better-sqlite3`** como biblioteca de acesso, síncrona, e os PRAGMAs
  obrigatórios (`foreign_keys`, `journal_mode = WAL`, `busy_timeout`);
- **Node.js** como runtime (T-01);
- **`withTransaction` com `BEGIN IMMEDIATE`** como base de T-07;
- **migrations SQL versionadas, sem ORM**, com checksum e imutabilidade das
  migrations já aplicadas (T-05);
- **dinheiro em centavos inteiros** e a proibição de ponto flutuante (T-06);
- **preservação histórica por inativação** em vez de exclusão física (M-09);
- **proveniência do legado** preservada célula a célula (M-07) e a recusa a
  interpretar ambiguidade silenciosamente (M-08);
- **separação entre domínio, persistência e importação** — `src/domain`,
  `src/services`, `src/db` e `src/import` seguem intactos e continuam sendo os
  donos da regra;
- **ausência de infraestrutura externa obrigatória** (T-03): sem Docker, sem
  PostgreSQL, sem Redis, sem SaaS — e, acrescenta este ADR, **sem Vercel**;
- **`node:test`** como runner, com banco temporário e nunca `data/`;
- a seção **"Fora de escopo desta decisão"** do ADR-001, com todos os pontos
  TO CONFIRM, que continuam TO CONFIRM.

## Contexto

O sistema foi implementado inicialmente em **Express + HTML gerado no servidor**
(ADR-001): `src/web/app.js` roteia as APIs JSON, `src/web/views/` monta strings de
HTML e `src/server.js` é o entry point.

Essa escolha pagou o prazo de 1 dia do MVP, mas o produto passou a precisar de
telas de conferência com estado (filas de pendência, identificação de depósito,
comprovantes). Montar HTML por concatenação de strings não escala para isso, e
adotar uma SPA separada criaria dois processos e dois modelos de erro.

O baseline **não** fixa framework web: **T-08** o declara explicitamente decisão de
implementação. Trocar Express por Next.js não toca nenhuma regra FROZEN.

## Decisão

Migrar **incrementalmente** para **Next.js 16 com App Router**, mantendo
**Node.js + SQLite** e reutilizando os módulos de domínio e persistência já
existentes (`src/domain`, `src/services`, `src/db`, `src/import`) sem alteração.

### Razões

- **framework full-stack único** — um processo serve UI e API, sem CORS, sem
  proxy, sem build separado de cliente e servidor;
- **UI React** — as telas de conferência têm estado; componentes resolvem isso
  melhor que concatenação de strings;
- **Route Handlers** para as APIs, com o mesmo contrato JSON já publicado;
- **Server Components** para consulta server-side: leitura direta do SQLite
  síncrono, sem endpoint intermediário só para alimentar a tela;
- **separação transporte × domínio preservada** — a regra continua em
  `src/services/`; Route Handler e Server Component são transporte, exatamente
  como as rotas Express eram;
- **execução em Node.js** (T-01) e compatibilidade com `better-sqlite3`, que é
  módulo nativo síncrono.

### Restrições assumidas

- **SQLite continua obrigatório** (T-02) e continua acessado por
  `better-sqlite3` — nenhum ORM é introduzido;
- **runtime Edge não pode ser usado** em nenhum código que toque o banco: todo
  Route Handler que abre SQLite declara `export const runtime = 'nodejs'`;
- **Vercel não é requisito** (T-03): a aplicação roda com `next start` em Node.js
  local, sem serviço externo;
- **nenhuma regra financeira muda** — este ADR é sobre transporte;
- **nenhuma migration financeira é criada** pela simples troca de framework: o
  schema não é afetado por qual framework serve o HTTP (T-05);
- **JavaScript** nesta etapa: converter o domínio para TypeScript é decisão
  independente e não pertence a esta migração.

## Estratégia de migração

| Fase | Escopo |
|---|---|
| **NX-0** | Fundação: `app/layout.js`, `app/page.js`, `app/health/route.js`, `next.config.js`, scripts de `dev`/`build`/`start`. Express intacto no repositório. |
| **NX-1** | APIs: `/api/movimentos`, `/api/alocacoes`, `/api/ajustes`, `/api/pendencias/comprovantes` viram Route Handlers, preservando status e códigos de erro. |
| **NX-2** | UI: `/associados` (listagem e detalhe) vira Server Component, substituindo `src/web/views/`. |
| **NX-3** | Remoção do Express: `src/web/`, `src/server.js` e a dependência `express` saem do projeto. |

Cada fase mantém a suíte de testes verde. Nenhuma fase altera schema, migrations
ou regras financeiras.

## O que a Fase NX-0 efetivamente fez

1. `next`, `react` e `react-dom` adicionados como dependências.
2. `npm run dev`/`build`/`start` passaram a operar o Next.js. O entry point
   Express continua executável por `npm run start:express`.
3. `app/health/route.js` publica `GET /health` com o **mesmo contrato** de antes.
4. A sonda do health check foi extraída para `src/db/health.js`.
5. Dois ajustes exigidos pelo bundler: remoção do campo `"type"` do
   `package.json` e um comentário `turbopackIgnore` em `src/config.js` — ambos
   detalhados abaixo, ambos sem efeito em tempo de execução.

### Por que `src/db/health.js` existe

Durante a transição, `/health` tem **dois transportes** — Express e Next. Duplicar
a consulta em ambos convidaria à divergência silenciosa do contrato justamente no
endpoint usado para dizer se o sistema está de pé.

O módulo devolve `{ saudavel, corpo }` e **não** decide status HTTP: mapear
`saudavel` para 200/503 continua sendo trabalho de cada transporte. Ele também não
aplica migration — health check é leitura, não manutenção de schema.

É a única alteração feita em código pré-existente nesta fase, e ela sobrevive à
remoção do Express em NX-3.

### Por que `next.config.js` tem apenas `poweredByHeader: false`

`better-sqlite3` carrega um binário `.node` e não pode ser empacotado no bundle do
servidor. A primeira versão desta fase declarava
`serverExternalPackages: ['better-sqlite3']` para garantir isso — mas a revisão
NX-0R verificou que **o pacote já consta na lista interna do Next 16**
(`next/dist/esm/lib/server-external-packages.jsonc`, junto de `sqlite3`). A
declaração era, portanto, a repetição de um default: removida, porque configuração
redundante sugere falsamente que há algo especial a configurar. O build e os
testes continuam passando sem ela.

Resta uma única opção, e ela é deliberada: `poweredByHeader: false` preserva a
postura que o Express já adotava com `app.disable('x-powered-by')` — a aplicação
não anuncia a tecnologia que a serve. Sem essa linha o Next passaria a enviar
`X-Powered-By: Next.js`, o que seria uma **regressão** de segurança introduzida
pela migração.

### Por que o campo `"type": "commonjs"` foi removido do `package.json`

Todo o `src/`, `scripts/` e `tests/` é CommonJS, e os arquivos de `app/` são ESM.
A intenção inicial era manter `"type": "commonjs"` declarado, já que o Next compila
`app/` com o próprio compilador — mas o **Turbopack, que é o bundler padrão do
Next 16, honra o campo `type` e aborta o build**:

> `Specified module format (CommonJs) is not matching the module format of the
> source code (EcmaScript Modules)`

Remover o campo resolve o conflito **sem alterar o comportamento do Node**: na
ausência de `"type"`, o padrão do Node para `.js` já é CommonJS. Detecção de
sintaxe só entra em ação quando o arquivo falha ao ser interpretado como CommonJS,
o que não acontece em nenhum arquivo do projeto. É também a configuração que o
próprio `create-next-app` gera.

Consequência prática, que permanece: `app/health/route.js` é ESM e **não pode ser
importado por `node:test`** com o restante da suíte CommonJS. Por isso o handler
foi mantido com duas linhas de lógica e todo o contrato testável vive em
`src/db/health.js`, coberto por `tests/health-check.test.js`. O endpoint servido
pelo Next é verificado manualmente após `npm run build`.

### Duas proteções contra vazamento de dado para o output do servidor

O rastreador de arquivos do Next decide o que acompanha o servidor em produção.
A revisão NX-0R mediu esse output e encontrou **dois vazamentos distintos**, com
causas diferentes. As duas proteções são complementares: nenhuma cobre a outra, e
isso foi verificado empiricamente removendo cada uma e reconstruindo.

**1. `turbopackIgnore` em `src/config.js` — contra o rastreamento do projeto inteiro**

`resolveDbPath()` faz `path.resolve(ROOT_DIR, value)` com `value` vindo de
`DB_PATH`. O Turbopack não consegue delimitar o resultado, desiste da análise e
passa a rastrear **tudo**. Medição com a proteção removida:

| | arquivos rastreados por `/health` | arquivos do projeto |
|---|---|---|
| sem `turbopackIgnore` | 176 | **57** |
| com `turbopackIgnore` | 122 | 3 |

Entre os 57 estavam **`controle-de-pagamento.xlsx`** — a planilha legada, com dados
reais de associados — e **`ficha-de-cadastro.pdf`**, além de todo `src/`, `tests/`
e `migrations/`. O caminho do banco só existe em tempo de execução; rastreá-lo não
faz sentido. O comentário `/* turbopackIgnore: true */` é a saída documentada pelo
próprio Next e **não tem efeito nenhum em tempo de execução**.

**2. `outputFileTracingExcludes` em `next.config.js` — contra a inclusão do banco real**

`DEFAULT_DB_PATH` é `path.join(ROOT_DIR, 'data', 'acasa.sqlite')`: totalmente
estático. O rastreador o resolve com sucesso, encontra o arquivo em disco e o
inclui como dependência da rota — **sem emitir warning nenhum**, justamente porque
a análise funcionou. `data/acasa.sqlite` aparecia literalmente no
`.nft.json` de `/health`. A exclusão declara o que é verdade: `data/` guarda dado
de produção, não artefato de build.

Este segundo caso é o mais perigoso dos dois, porque é silencioso. Um `.nft.json`
não é lido no dia a dia, e o vazamento só se materializaria num deploy que honra o
trace (`output: 'standalone'`) — quando já seria tarde.

**Estado após as duas correções:** o `/health` rastreia 122 arquivos, dos quais 3
são do projeto (os próprios arquivos de `app/`), e **zero** são banco, planilha ou
PDF. Build sem warnings.

Ambas saem quando/se o bundler deixar de exigi-las, e nenhuma altera como o banco
é resolvido em tempo de execução.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| Manter Express + templates | Não resolve o problema que motivou a mudança: telas com estado. |
| Express (API) + SPA React separada | Dois processos, dois deploys, CORS e um modelo de erro duplicado. Contraria T-03 na prática operacional. |
| Remix / Astro | Viáveis, mas sem vantagem sobre Next para este caso; Next tem a maior base de conhecimento disponível para manutenção. |
| Migração "big bang" (tudo de uma vez) | Toda a superfície financeira mudaria de transporte em um único diff, sem etapa verde intermediária. Risco desnecessário. |
| Converter o domínio para TypeScript junto | Duas mudanças grandes no mesmo diff. Se algo quebrar, não se sabe qual delas causou. |
| `next.config.js` com runtime Edge | Impossível: Edge não carrega módulo nativo, e T-02 exige SQLite. |

## Consequências

**Positivas**

- Um único processo serve UI e API (T-01, T-03 preservados).
- O domínio (`src/services/`, `src/db/`, `src/import/`) não foi tocado: a
  migração é de transporte, e os testes financeiros comprovam isso.
- Migração reversível por fase: cada etapa é um diff independente.

**Negativas / limites aceitos**

- **Durante a transição existem artefatos Next.js e Express no mesmo
  repositório.** `src/web/app.js`, `src/web/routes/`, `src/web/views/` e
  `src/server.js` continuam versionados e testados, mas **não são mais
  alcançados por `npm start`**. Isso é explicitamente transitório e termina em
  NX-3.
- **Enquanto NX-1 e NX-2 não concluírem, as rotas `/api/*` e `/associados` não
  respondem sob o servidor Next.** Elas continuam disponíveis via
  `npm run start:express`, mas o produto **não** exige dois processos: o segundo
  existe apenas como ferramenta de transição.
- O projeto passa a ter um **build step** (`npm run build`), que o ADR-001
  evitava deliberadamente. É o preço da UI React, e foi aceito conscientemente.
- `node_modules` cresce (~19 pacotes). Nenhum deles é serviço externo.

## Fora de escopo desta decisão

Continuam **TO CONFIRM** e não são afetados: significado dos códigos legados,
identificação de associado pelos centavos, valor da mensalidade, abreviações,
cores, armazenamento de arquivos de comprovante (C-06), autenticação e perfis,
conciliação bancária e transferência de titularidade.

Também não são decididos aqui: TypeScript, biblioteca de CSS, biblioteca de
estado global e estratégia de deploy.
