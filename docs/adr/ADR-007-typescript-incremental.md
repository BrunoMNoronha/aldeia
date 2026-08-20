# ADR-007 — Adoção incremental de TypeScript

- **Status:** aceito
- **Data:** 2026-08-20
- **Baseline normativo aplicável:** `KB-BASELINE-ACASA-v2.0.pdf` (FROZEN) — a
  autoridade normativa é o PDF canônico, nunca este documento.
- **Relação com ADRs anteriores:** não supersede nenhum ADR. Convive com o
  [ADR-002](ADR-002-nextjs-app-router.md) (Next.js 16 App Router) e o
  [ADR-003](ADR-003-postgresql-persistencia.md) (PostgreSQL); ambos seguem
  vigentes e inalterados.

## 1. Contexto

O código do projeto é JavaScript CommonJS em `src/`, `scripts/` e `tests/`, e
JavaScript com sintaxe ESM/JSX em `app/` (compilado pelo Next.js). Não há
verificação estática de tipos: os contratos entre camadas — domínio, serviços,
persistência, importação e transporte — são sustentados exclusivamente por
convenção, JSDoc e pela suíte `node:test`.

Duas migrações estruturais estão **em curso e inacabadas**:

- **ADR-002** — Express → Next.js 16 App Router; fase concluída: NX-0. `src/web/`
  e `src/server.js` são transitórios e saem em NX-3.
- **ADR-003** — SQLite → PostgreSQL; fases concluídas: PG-0 e PG-1. **SQLite
  ainda é o banco do runtime**; a implementação SQLite sai no corte PG-6/PG-7.

Uma parcela relevante do JavaScript atual, portanto, **está marcada para
remoção**. Investir esforço em tipar código que será apagado é desperdício, e
pior: cria a impressão falsa de que esse código é permanente.

Ao mesmo tempo, a superfície de risco do sistema é financeira. Centavos
inteiros (T-06), atomicidade multi-registro com `audit_log` (T-07), separação
de camadas (T-08), proveniência célula a célula (M-07) e a passagem de valores
por `BIGINT`/`NUMERIC` do PostgreSQL são exatamente o tipo de contrato que se
beneficia de verificação estática — desde que ela não seja confundida com
validação.

## 2. Decisão

**Adotar TypeScript como linguagem preferencial para código permanente novo, em
migração incremental, sem conversão massiva e sem alterar comportamento.**

A fase TS-0 entrega apenas a **fundação**: `typescript` e os tipos de ambiente
como `devDependencies`, um `tsconfig.json` em modo `strict`, o comando
`npm run typecheck` e a execução desse comando no CI. A migração de JavaScript
para TypeScript **não está concluída** e não termina nesta fase.

## 3. Estratégia incremental

- `allowJs: true` com `checkJs: false`. Os `.js` existentes entram no programa
  como dependências — o compilador resolve seus módulos e infere o que consegue
  — mas **não são reprovados por falta de anotação**.
- Cada arquivo convertido para `.ts`/`.tsx` passa a ser checado em modo
  `strict` a partir do momento da conversão. A conversão é o momento em que o
  rigor entra, arquivo a arquivo.
- `noEmit: true`. Esta configuração é de **typecheck**, não de emissão. O
  Next.js compila `app/**` com o próprio pipeline; nada em `src/` passa a
  depender de um build step novo.
- Ordem sugerida de conversão: primeiro o que é puro e permanente (domínio,
  serviços de contrato, helpers), depois transporte Next.js, por último o que
  depender de infraestrutura de execução TypeScript ainda inexistente.

### 3.1 O contrato de compatibilidade tem **duas** superfícies

A versão de Node que o typechecker considera disponível não é definida por um
único ajuste. São **duas superfícies independentes**, e ambas têm de acompanhar
o **menor** Node suportado em `engines.node`:

| Superfície | O que anuncia | Valor atual |
|---|---|---|
| `compilerOptions.target` / `lib` | APIs da **linguagem** e globais do ECMAScript (`Promise.withResolvers`, `Object.groupBy`, `Array.prototype.toSorted`…) | `ES2022` |
| versão de **`@types/node`** | APIs da **plataforma Node** (módulos `node:*`, `fs`, `process`, `Buffer`…) | `20.11.30` |

Alinhar só uma delas **não** produz compatibilidade. É um erro fácil de cometer
e foi cometido na primeira versão desta fundação: com `target`/`lib` já em
`ES2022`, mas `@types/node@24`, o compilador aceitava sem reclamar

```ts
import { DatabaseSync } from 'node:sqlite';
```

— módulo que **só existe a partir do Node 22.5** e que estouraria em qualquer
Node 20.11, o mínimo que o projeto declara suportar. `target`/`lib` não têm
como barrar isso: `node:sqlite` não é API de linguagem.

Com `@types/node@20.11.30` o mesmo trecho é rejeitado na compilação
(`TS2307: Cannot find module 'node:sqlite'`), que é o comportamento correto.

**Escolha da versão:** a linha `20.11.x`, e não o `@types/node@20` mais
recente. Releases posteriores da própria linha 20 (20.12, 20.15…) incorporam
tipos de APIs introduzidas **depois** do 20.11, o que reabriria exatamente a
mesma brecha em escala menor. `--save-exact` mantém a versão fixa.

### 3.2 `target`/`lib` acompanham o **menor** Node suportado

`target` e `lib` são `ES2022`, alinhados ao mínimo declarado em
`engines.node` (`>=20.11.0`) — **não** ao `.nvmrc` (22) nem ao Node da máquina
de quem desenvolve.

A razão é que `lib` não é preferência de estilo: é a lista de APIs de runtime
que o typechecker passa a considerar existentes. Com `lib: ES2024` o compilador
aceitaria `Promise.withResolvers` (só existe a partir do Node 22) e
`Object.groupBy` (Node 21) como disponíveis em um Node 20.11 — e o erro
apareceria apenas em produção, sem nenhum aviso estático. Um typechecker que
autoriza API inexistente no runtime alvo é pior que nenhum.

**Regra:** ampliar `target`/`lib` **ou** a versão de `@types/node` é decisão
explícita, acompanhada da mudança correspondente em `engines.node`. Nunca
efeito colateral de satisfazer o `.d.ts` de uma dependência, e nunca resultado
de um `npm install` que resolveu a última versão disponível.

Registro do que foi medido na fase TS-0R: a primeira versão de TS-0 havia
subido para `ES2024` justamente para calar dois erros de `PromiseWithResolvers`
vindos de `.d.ts` do Next. Era desnecessário e nocivo — `skipLibCheck`, adotado
em seguida, já suprime esses erros por serem externos. Com `ES2022` +
`skipLibCheck`, `npm run typecheck` e `npm run build` passam ambos.

## 4. JavaScript continua temporariamente permitido

Durante toda a migração, JavaScript permanece uma linguagem válida no
repositório. `npm test`, `npm run build`, `npm run start:express`,
`npm run migrate` e os scripts de importação continuam funcionando sem
alteração. Nenhum arquivo `.js` é reprovado por ser `.js`.

## 5. Código transitório SQLite/Express NÃO é convertido só por tipagem

**Decisão explícita:** `src/db/connection.js`, `src/db/health.js`,
`src/db/migrator.js`, `src/server.js`, `src/web/**` e a implementação SQLite dos
serviços **podem permanecer JavaScript até serem removidos** pelas fases NX-3
(ADR-002) e PG-6/PG-7 (ADR-003).

Converter esse código para TypeScript apenas para satisfazer a migração de
linguagem seria trabalho descartado e, além disso, tocaria arquivos de runtime
financeiro em vigor sem nenhum ganho duradouro. Se um desses arquivos precisar
ser modificado por outra razão legítima, a conversão pode acompanhar a mudança —
mas nunca é motivada por ela sozinha.

## 6. TypeScript não substitui validação em runtime

Este é o ponto de maior risco da decisão e está registrado como restrição
normativa desta migração.

Tipo estático descreve o que o código **espera**; ele não observa o que o banco,
a rede, a planilha ou o ambiente **entregam**. Um `number` declarado não impede
que o driver devolva string, `null`, `bigint` ou um valor acima de
`Number.MAX_SAFE_INTEGER`.

**Continuam obrigatórias, sem exceção, as validações de runtime existentes
para:**

| Fonte | Validação que permanece |
|---|---|
| `BIGINT` (PostgreSQL) | conversão e checagem explícitas; nunca confiar no tipo declarado |
| `NUMERIC` | tratamento explícito; nunca ponto flutuante binário como fonte de verdade (T-06) |
| centavos | inteiro verificado em runtime |
| `Number.MAX_SAFE_INTEGER` | limite verificado em runtime |
| booleanos vindos de SQLite/PostgreSQL | normalização explícita (`0`/`1`, `t`/`f`, `boolean`) |
| `DATE` / `TIMESTAMPTZ` | contrato de timestamp preservado como já testado |
| request HTTP | validação de entrada integral |
| planilha legada | validação e proveniência integrais (M-07, M-08) |
| variáveis de ambiente | validação integral |

Remover uma validação de runtime porque "o tipo já garante" é **violação desta
decisão e do baseline**.

Proibido para obter verde artificial: `as any`, `@ts-ignore`, `@ts-nocheck`,
afrouxamento global do `tsconfig.json` e casts (`as X`) usados para silenciar
inconsistência real. Supressão, se inevitável, é **local, mínima e justificada
no ponto de uso**.

## 7. Contratos financeiros e SQL continuam validados em runtime e por teste

As suítes de contrato (`*-contrato.js`, `tests/*-diferencial.test.js`,
`tests/timestamp-contrato-diferencial.test.js`, `tests/postgresql-*.test.js`)
seguem sendo a prova de comportamento. TypeScript **não é evidência de
correção financeira** e não substitui um teste. Nenhum SQL, schema ou migration
é alterado por causa de tipagem — migration aplicada é imutável (T-05).

## 7.1 O gate da migração é o CI de Pull Request

A verificação estática só protege o projeto se rodar **antes** do merge. Até
TS-0, o único workflow (`deploy-production.yml`) disparava apenas em push na
`main` — ou seja, a validação acontecia quando o código já estava incorporado.

Esta decisão cria `.github/workflows/ci.yml`, disparado em `pull_request`, com
o mesmo contrato de validação já comprovado em produção: `npm ci` →
`npm run typecheck` → `npm test` contra PostgreSQL 16 efêmero → gate
fail-closed de `skipped = 0` → `npm run build`.

Restrições que fazem parte da decisão:

- o workflow de PR **não implanta nada**: sem `environment:`, sem `secrets.*`,
  sem SSH, sem referência a `PROD_DEPLOY_ENABLED`;
- usa exclusivamente `TEST_DATABASE_URL` apontando para o PostgreSQL efêmero do
  job. `DATABASE_URL` de produção nunca é definida ali (fail-closed, ADR-003);
- o gate de testes pulados **não é relaxado**: `skipped != 0` reprova, e
  contagem ilegível também reprova;
- `deploy-production.yml` permanece intacto, com os gates de ADR-004/005/006.

Enquanto a migração durar, **um PR só é revisável se esse workflow estiver
verde** — typecheck incluído.

## 8. Critérios para encerramento da migração

A migração TypeScript termina quando, cumulativamente:

1. não restar arquivo `.js` **permanente** no repositório (o transitório terá
   sido removido por NX-3 e PG-6/PG-7, não convertido);
2. `checkJs` for irrelevante e **`allowJs` puder ser removido** do
   `tsconfig.json` sem que `npm run typecheck` reprove;
3. `npm run typecheck`, `npm test` e `npm run build` seguirem verdes no CI de
   Pull Request (§7.1), em Linux, com a suíte PostgreSQL completa e
   `skipped = 0`;
4. nenhuma supressão ampla tiver sido introduzida para chegar lá;
5. **as duas** superfícies de compatibilidade — `target`/`lib` e a versão de
   `@types/node` — continuarem coerentes com `engines.node` (§3.1 e §3.2).

A remoção de `allowJs` é o marco objetivo de encerramento.

## 9. Consequências e trade-offs

**A favor**

- Contratos entre camadas verificados estaticamente, reforçando T-08.
- Erros de integração detectados antes do runtime financeiro.
- Conversão gradual: nenhum big bang, nenhum congelamento de outras frentes.

**Contra / custos aceitos**

- Convivência prolongada de duas linguagens no mesmo repositório.
- `allowJs` mantém uma zona não verificada até o fim da migração.
- **Risco central:** falsa sensação de segurança. Mitigado pela seção 6, que é
  restrição normativa desta decisão, não recomendação.
- `skipLibCheck: true` está ligado por motivo medido — ver §9.1.
- Mais uma etapa obrigatória no CI (`npm run typecheck`).

### 9.1 `skipLibCheck: true` — evidência, não conveniência

`skipLibCheck` **não é mecanismo genérico para esconder erro do projeto**. Ele
foi ligado depois de medir exatamente o que suprime.

Comando de verificação (reproduzível a qualquer momento):

```bash
npx tsc --noEmit --skipLibCheck false
```

Resultado com Next `16.3.1` e TypeScript `5.9.3` — **6 erros, todos dentro de
`node_modules/next/dist/`, nenhum em código deste repositório**:

| Erro | Arquivo (pacote `next`) |
|---|---|
| `TS2304` `PromiseWithResolvers` | `client/components/segment-cache/cache.d.ts` |
| `TS2304` `PromiseWithResolvers` | `server/app-render/work-unit-async-storage.external.d.ts` |
| `TS2552` `URLPatternInput` (×2) | `server/web/spec-extension/url-pattern.d.ts` |
| `TS2304` `URLPatternOptions` (×2) | `server/web/spec-extension/url-pattern.d.ts` |

- **Pacote que provoca:** `next` (declarações publicadas referenciando globais
  que a `lib` do TypeScript 5.9 ainda não define).
- **Fora do nosso alcance:** são `.d.ts` de terceiros; corrigi-los exigiria
  editar `node_modules` ou declarar globais ambientes que colidiriam assim que
  o TypeScript passasse a fornecê-los.
- **Não é atalho de tipagem:** `skipLibCheck` só afeta a checagem *interna* de
  arquivos de declaração. Todo erro em `.ts`/`.tsx` do projeto continua
  reprovando o build normalmente.
- **Condição de reavaliação:** a cada upgrade de `next` ou de `typescript`,
  rodar o comando acima. Quando sair limpo, `skipLibCheck` deve ser
  **removido** do `tsconfig.json`.

A alternativa descartada foi ampliar `lib` para `ES2024`, que calaria 2 dos 6
erros ao custo de o typechecker passar a autorizar APIs inexistentes no Node
mínimo suportado — ver §3.2.

**Explicitamente não decidido aqui:** migração de CommonJS para ESM. O
`tsconfig.json` de TS-0 é de typecheck (`noEmit`) e **não obriga** essa
migração; `"type": "module"` não é adicionado ao `package.json`. Se ela vier a
ser necessária, será decisão própria, com ADR próprio.

## 10. Relação com ADR-002 e ADR-003

- **ADR-002 (Next.js 16 App Router):** inalterado. O plano NX-0…NX-3 segue
  válido. TypeScript não antecipa nem atrasa nenhuma fase; `app/**` já é
  compilado pelo Next e aceita `.tsx` nativamente. `src/web/**` e
  `src/server.js` continuam JavaScript até NX-3 os remover.
- **ADR-003 (PostgreSQL):** inalterado. O plano PG-0…PG-7 segue válido.
  TypeScript **não** troca o driver `pg`, não introduz ORM, não altera SQL,
  schema, migration, semântica de snapshot ou de transação, e não antecipa o
  cutover PG-6. A implementação SQLite continua JavaScript até PG-6/PG-7.
- Nenhuma decisão histórica de ADR anterior é apagada ou reinterpretada por
  este documento.
