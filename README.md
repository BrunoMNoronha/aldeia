# TechLab+ Aldeia — ACASA

Sistema de controle de pagamentos da ACASA, substituindo a planilha legada
`controle-de-pagamento.xlsx`.

Fonte normativa: `KB-BASELINE-ACASA-v1.0.pdf` (v1.0 — FROZEN).

## Requisitos

- Node.js >= 20.11
- Nada mais. Sem banco de dados externo, sem Docker, sem serviço em nuvem.

## Como rodar

```bash
npm install
npm run migrate
npm run build
npm start
```

Em desenvolvimento, `npm run dev` dispensa o `build`.

Depois, verifique:

```bash
curl http://localhost:3000/health
```

Resposta esperada:

```json
{ "status": "ok", "database": "ok", "migrations": 3 }
```

## Migração para Next.js (em andamento)

A aplicação web está migrando de Express para **Next.js 16 (App Router)** —
ver [`docs/adr/ADR-002-nextjs-app-router.md`](docs/adr/ADR-002-nextjs-app-router.md).

A migração é incremental e, **nesta fase (NX-0), o Next.js serve apenas `/` e
`/health`**. As APIs `/api/*` e as telas `/associados` ainda pertencem ao
servidor Express, que continua no repositório e executável por
`npm run start:express` enquanto NX-1 e NX-2 não concluem.

Nada disso alterou schema, migrations ou regra financeira.

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Sobe o Next.js em desenvolvimento |
| `npm run build` | Build de produção do Next.js |
| `npm start` | Sobe o Next.js em produção (exige `npm run build` antes) |
| `npm run start:express` | Sobe o servidor Express legado (transitório — sai em NX-3) |
| `npm run migrate` | Cria/atualiza o banco a partir das migrations |
| `npm run import:legacy` | Importa um `.xlsx` legado para a camada bruta |
| `npm run legacy:associados` | Materializa associados a partir das colunas A/B de uma importação |
| `npm run legacy:diagnostico` | Gera o relatório de ambiguidades/discrepâncias do legado |
| `npm test` | Roda a suíte com `node:test` |

## Importação do legado

```bash
npm run import:legacy -- "<arquivo.xlsx>"
```

Essa importação é **bruta**: preserva a proveniência de cada célula (arquivo,
SHA-256, aba, endereço, valor original, tipo, fórmula e estilo) e **não interpreta
pagamentos** — nenhum valor é convertido em centavos e nenhum movimento
financeiro, alocação ou associado é criado a partir dela.

O SHA-256 do arquivo é a identidade do conteúdo: reimportar o mesmo arquivo — ou
uma cópia com outro nome — não duplica nada, e o comando informa qual importação
já registrou aquele conteúdo. A planilha real não é copiada para o repositório.

### Materialização de associados

```bash
npm run legacy:associados -- <importacao_id>
```

Etapa separada e posterior à captura bruta. Materializa **somente cadastros
determinísticos** de associados a partir de `A` (`legacy_id`) e `B` (`nome`),
preservando a proveniência de cada célula em `legacy_cell_link` (`papel =
legacy_id` / `papel = nome`) e **encaminhando conflitos para revisão humana** em
vez de decidir: ID duplicado, ID sem nome, nome sem ID, ID inválido e nome
divergente para um `legacy_id` já cadastrado viram ocorrências estruturadas no
`resultado` da importação, nunca uma sobrescrita silenciosa.

Nada de `C:BN` é lido: nenhum pagamento, status legado ou situação financeira é
derivado aqui. Reexecutar é idempotente, e duas importações com o mesmo
`legacy_id`/nome compartilham um único associado — acumulando proveniência, não
duplicatas.

Um `legacy_id` que só existe como **resultado de fórmula** não é aceito como
identidade por padrão; ele é reportado como `legacy_id_from_formula` e só é
materializado com o opt-in explícito `-- <id> --aceitar-id-de-formula`.

### Diagnóstico do legado

```bash
npm run legacy:diagnostico -- <importacao_id>
```

Terceira etapa, também separada: lê **apenas** `legacy_cell` (mais os vínculos de
proveniência já criados) e produz um **relatório estruturado** do que existe no
legado — distribuição de tipos por área, inventário de textos/tokens, fórmulas,
assinaturas de preenchimento, estatísticas numéricas, conteúdo de `BM`/`BN` e
registros fora da tabela principal — com **cada amostra rastreável até a célula
de origem**.

O relatório é **descritivo, nunca normativo**: token desconhecido continua
desconhecido, cor sem legenda continua `significado_nao_confirmado`, `BJ` é
evidência e não saldo, `BM` não vira status e a coincidência entre centavos e
`legacy_id` é medida como `hipotese_nao_aplicada` — inclusive medindo o próprio
**poder discriminante** do teste. Nenhuma tabela financeira é populada e nenhum
associado é alterado.

O resultado é gravado no namespace `diagnosticoLegado` de `importacao.resultado`,
preservando integralmente os namespaces anteriores. Não há timestamp próprio: o
relatório é função determinística de `legacy_cell` e recalculá-lo produz
exatamente o mesmo conteúdo. Para consumo por outra ferramenta:

```bash
npm run legacy:diagnostico -- <importacao_id> --json
```

## Ledger financeiro

Núcleo transacional do dinheiro (`src/services/ledger.js`). Um **movimento**
(pagamento ou depósito) é registrado **manualmente** e depois **alocado** em zero,
uma ou várias **competências** — e uma competência recebe alocações de vários
movimentos.

```bash
curl -X POST http://localhost:3000/api/movimentos \
  -H 'content-type: application/json' \
  -d '{"data":"2026-03-05","valorCentavos":15035,"origem":"pagamento","associadoId":1}'

curl -X POST http://localhost:3000/api/movimentos/1/alocacoes \
  -H 'content-type: application/json' \
  -d '{"competenciaId":1,"valorCentavos":4000}'

curl http://localhost:3000/api/movimentos/1
```

Regras garantidas pelo serviço, dentro de **uma única transação** por operação:

- valores entram e saem em **centavos inteiros** — `150.35` é recusado com
  `valor_nao_inteiro`, nunca convertido silenciosamente;
- a soma das alocações ativas **nunca ultrapassa** o valor do movimento
  (`alocacao_excede_movimento`); movimento **parcialmente alocado é válido**, não é erro;
- depósito **sem associado** existe como `nao_identificado` e **não pode ser alocado**
  enquanto permanecer assim;
- criação de movimento e de alocação gravam `audit_log`; se qualquer validação
  falha, **nada** sobra — nem alocação parcial, nem auditoria órfã;
- `totalCentavos` / `alocadoCentavos` / `naoAlocadoCentavos` vêm **só do ledger**,
  nunca de um total herdado da planilha.

Nada aqui lê a planilha: **nenhum movimento é gerado a partir do legado.**

### Identificação posterior de um depósito

Um depósito registrado sem associado fica `nao_identificado` e **não recebe
alocação**. A vinculação é uma **ação explícita do operador**, feita depois:

```bash
curl -X POST http://localhost:3000/api/movimentos/1/identificacao \
  -H 'content-type: application/json' \
  -d '{"associadoId":37,"motivo":"Depósito confirmado manualmente após conferência"}'
```

```text
depósito sem associado → nao_identificado → identificarMovimento(...) → identificado → alocarMovimento(...)
```

- o associado vem **só** pelo `id` interno: não há busca por nome, por `legacy_id`,
  pelos centavos do valor nem por qualquer heurística do legado;
- `motivo` é **obrigatório** e vai para a auditoria — nunca para a observação do movimento;
- a operação **só** promove `nao_identificado → identificado`. Movimento já
  identificado é recusado com `movimento_ja_identificado`, **mesmo que o associado
  informado seja o mesmo**: trocar titular é correção, será operação própria;
- movimento **inativo** e movimento **`em_revisao`** são recusados — nada de
  reativação implícita nem de tratar ambiguidade declarada como ausência de dado;
- alteração + `audit_log` (com `estado_anterior` e `estado_posterior`) na **mesma
  transação**: se a auditoria falhar, o movimento continua sem associado;
- identificar **não** cria alocação: só torna o movimento elegível.

### Correção de lançamento: inativação auditável

Corrigir **não** é apagar. Um movimento ou uma alocação errada é **inativada**:
a linha continua no banco, com `inativado_em` e `motivo_inativacao`, e a
alteração deixa `audit_log` com **estado anterior e posterior**.

```bash
curl -X POST http://localhost:3000/api/alocacoes/7/inativacao \
  -H 'content-type: application/json' \
  -d '{"motivo":"competência incorreta","ator":"operador"}'

curl -X POST http://localhost:3000/api/movimentos/1/inativacao \
  -H 'content-type: application/json' \
  -d '{"motivo":"lançamento duplicado","ator":"operador"}'
```

- `motivo` é **obrigatório** (o `CHECK` do banco já recusa inativação sem ele) e
  vai para `motivo_inativacao` + auditoria — **nunca** para `observacao`;
- **não há cascata**: movimento com alocação **ativa** é recusado com
  `movimento_possui_alocacoes_ativas` (409). Inative cada alocação com o **seu**
  motivo e só então o movimento — uma correção, uma justificativa. Alocações já
  inativas não bloqueiam nada;
- **não é idempotente**: repetir a chamada é `movimento_inativo` /
  `alocacao_inativa` (409), sem sobrescrever o timestamp/motivo originais e sem
  gerar uma segunda auditoria;
- nada financeiro é reescrito: `valor_centavos`, `data`, `tipo`, `origem`,
  vínculo com associado, competência e proveniência ficam **intactos**;
- alocação inativada **libera** o par movimento+competência para uma nova
  alocação ativa (índice parcial `ux_alocacao_ativa`), e a linha antiga
  **permanece** no histórico;
- UPDATE + `audit_log` na **mesma transação**: se a auditoria falhar, o
  `ROLLBACK` devolve o registro **ativo**;
- **não** existe reativação, exclusão física, edição de lançamento nem
  formulário HTML de inativação — a tela `/associados/:id` continua somente
  leitura e apenas **exibe** o que foi inativado, quando e por quê.

### Ajuste explícito de crédito/débito

Crédito e débito existem como **vocabulário estruturado** (M-03), nunca deduzidos
de texto livre. A operação registra um **evento** com motivo e auditoria — e
nada além disso:

```bash
curl -X POST http://localhost:3000/api/ajustes \
  -H 'content-type: application/json' \
  -d '{"associadoId":12,"tipo":"credito","valorCentavos":4000,
       "motivo":"ajuste aprovado pela administração","data":"2026-08-16",
       "competenciaId":8,"observacao":"referência interna","ator":"operador"}'
```

```json
{
  "status": "ok",
  "ajuste": {
    "id": 7, "associadoId": 12, "tipo": "credito", "valorCentavos": 4000,
    "motivo": "ajuste aprovado pela administração", "data": "2026-08-16",
    "competenciaId": 8, "observacao": "referência interna",
    "ativo": true, "inativadoEm": null, "motivoInativacao": null
  }
}
```

- `tipo` aceita **exclusivamente** `credito` ou `debito` (o mesmo vocabulário do
  `CHECK` da migration 001, espelhado em `domain/constants.TIPO_AJUSTE`). Só a
  caixa é normalizada, como já acontece em `origem`. `crédito`, `deb`, `entrada`,
  `saida`, `estorno`, `+` e `-` são recusados com `tipo_ajuste_invalido` (422) —
  traduzir um símbolo em significado seria interpretar, e isso não acontece aqui;
- `valorCentavos` é **sempre positivo** e inteiro (T-06). O sinal econômico vive
  **só** em `tipo`, então débito nunca vira valor negativo. `150.35`, `"15035"`,
  `0` e `-100` são recusados sem arredondar, truncar ou converter reais;
- `associadoId` é **obrigatório** e chega pelo **id interno** — nada é inferido de
  nome, `legacy_id`, centavos, observação ou competência. Inexistente → 404;
- `competenciaId` é **opcional**. Ausente significa apenas que o ajuste não foi
  amarrado a um mês — **não** significa saldo, crédito geral nem mensalidade
  antecipada. Informada, precisa existir (404): nenhuma é criada automaticamente;
- `motivo` é obrigatório (F-04) e `observacao` **não** o substitui. A observação é
  preservada literalmente e nunca é lida para extrair valor, tipo, competência,
  associado ou estado financeiro;
- INSERT + `audit_log` na **mesma transação** (T-07): exatamente **um** ajuste e
  **uma** auditoria (`ajuste_credito_debito.criado`, `estado_anterior: null`). Se
  a auditoria falhar, o `ROLLBACK` não deixa ajuste nenhum para trás;
- a operação **não toca** movimento, alocação, comprovante nem pendência, e **não
  calcula** saldo, total devido/pago, quitação ou adimplência — um crédito
  registrado aqui **não** quita mensalidade e um débito **não** declara
  inadimplência (M-06 segue TO CONFIRM);
- **não** há edição, exclusão nem formulário HTML de ajuste: a superfície de
  escrita é a API JSON (C-07 TO CONFIRM). Ajuste errado se corrige por
  **inativação**, abaixo.

#### Corrigindo um ajuste: inativação

Mesmo contrato já usado por movimento e alocação — corrigir **não** é apagar:

```bash
curl -X POST http://localhost:3000/api/ajustes/7/inativacao \
  -H 'content-type: application/json' \
  -d '{"motivo":"lançamento duplicado","ator":"operador"}'
```

- `motivo` é **obrigatório** (o `CHECK` do banco já recusa inativação sem ele) e
  vai para `motivo_inativacao` + auditoria. Ele **não** substitui o `motivo`
  original do ajuste — são duas informações distintas;
- **nada econômico é reescrito**: `tipo`, `valor_centavos`, `associado_id`,
  `competencia_id`, `data`, `motivo` e `observacao` ficam **intactos**. Um débito
  inativado continua sendo um débito daquele valor, só que sem efeito;
- **não é idempotente**: repetir a chamada é `ajuste_inativo` (409), sem
  sobrescrever o timestamp/motivo originais e sem gerar segunda auditoria.
  Ajuste inexistente é `ajuste_inexistente` (404);
- UPDATE + `audit_log` (`ajuste_credito_debito.inativado`, com estado anterior e
  posterior) na **mesma transação**: se a auditoria falhar, o `ROLLBACK` devolve
  o ajuste **ativo**;
- **não** existe exclusão física, **não** existe reativação nesta fase, e
  **nenhum** ajuste oposto/estorno é criado automaticamente — inativar apenas
  declara que aquele evento não vale mais, preservando sua história (M-09).

### Fila de movimentos não identificados

Consulta **somente leitura** que lista o que ainda espera identificação — a
entrada natural da operação acima:

```bash
curl 'http://localhost:3000/api/movimentos?estado=nao_identificado&limite=50&offset=0'
```

```json
{
  "status": "ok",
  "itens": [{ "id": 2, "data": "2026-01-15", "valorCentavos": 20000, "estadoIdentificacao": "nao_identificado", "associadoId": null }],
  "paginacao": { "limite": 50, "offset": 0, "total": 4 }
}
```

- entra na fila **só** quem satisfaz as três condições ao mesmo tempo: `ativo = 1`,
  `associado_id IS NULL` e `estado_identificacao = 'nao_identificado'`. Movimento
  identificado, **inativo** ou **`em_revisao`** fica de fora — ambiguidade declarada
  não é promovida a "sem identificação";
- ordem **`data ASC, id ASC`**: fila cronológica, com desempate estável pelo `id`,
  então paginar duas vezes devolve sempre a mesma sequência;
- `total` conta os elegíveis **antes** do `LIMIT/OFFSET`; página além do fim
  devolve `itens: []` sem mudar o `total`. `limite` vai de 1 a 200 (padrão 50) e
  `offset` de 0 em diante — fora disso é `paginacao_invalida` (422), nunca um
  valor "corrigido" em silêncio;
- `estado` é obrigatório e a rota serve **apenas** `nao_identificado`: qualquer
  outro valor é recusado com `estado_nao_suportado` (422);
- é leitura pura: **não** altera registro, **não** grava `audit_log` e **não**
  consulta nada do legado — o valor `15037` é só o valor do movimento, jamais um
  palpite de associado.

## Comprovantes e pendência de evidência

O comprovante é um **estado/evidência independente do pagamento** (M-04): ele não
altera, confirma nem invalida nada do ledger. Quatro estados, e só eles:

```text
presente | ausente | pendente | nao_aplicavel
```

A caixa da palavra é normalizada (`PRESENTE` = `presente`), o significado nunca:
`OK`, `N/A` ou `nao aplicavel` são recusados com `estado_comprovante_invalido` (422).

**Ausência de registro não é `ausente`.** Movimento sem linha em `comprovante`
responde `registrado: false` e `estadoTecnico: "sem_registro"` — ninguém declarou
nada sobre ele. `ausente` é uma declaração humana de que o comprovante **não
existe**; só ela conta como pendência.

```bash
curl 'http://localhost:3000/api/movimentos/7/comprovante'
```

```bash
curl -X PUT 'http://localhost:3000/api/movimentos/7/comprovante' \
  -H 'content-type: application/json' \
  -d '{"estado":"presente","observacao":"Documento conferido pela administração."}'
```

```json
{
  "status": "ok",
  "comprovante": {
    "movimentoId": 7,
    "registrado": true,
    "estado": "presente",
    "estadoTecnico": "presente",
    "pendenteDeEvidencia": false,
    "observacao": "Documento conferido pela administração.",
    "alteracao": "alterado"
  }
}
```

- **um comprovante por movimento** (índice único parcial `ux_comprovante_movimento`,
  migration 003). A alteração acontece na própria linha e o histórico — estado
  anterior, estado novo, observação, ator e timestamp — fica em `audit_log`, nas
  ações `comprovante.registrado` e `comprovante.alterado` (F-11). Comprovante
  **sem** movimento continua podendo existir aos montes (M-04);
- **`PUT` é idempotente**: reenviar o mesmo `estado` **e** a mesma `observacao` é
  reconhecido como `alteracao: "sem_mudanca"` — não há `UPDATE`, `atualizado_em`
  não se move e nenhuma segunda linha de auditoria é criada. Mudou o estado **ou**
  a observação, é `alterado` e é auditado;
- **nada financeiro é tocado**: valor, data, associado, identificação, `ativo` e
  alocações do movimento permanecem intactos. Movimento **inativado** aceita
  evidência e **não** é reativado por isso (M-09);
- a **observação** é contexto humano, preservada verbatim e **nunca** lida para
  deduzir estado: a situação oficial é sempre o campo estruturado;
- todas as transições entre os quatro estados são permitidas — não há máquina de
  estados aprovada no baseline, e inventar uma seria criar regra de negócio.

### Fila de pendência de comprovante

```bash
curl 'http://localhost:3000/api/pendencias/comprovantes?estado=pendente&limite=50&offset=0'
```

- lista **apenas** o que foi declarado `pendente` ou `ausente` (F-05 / F-10).
  `presente` e `nao_aplicavel` estão resolvidos e ficam de fora; movimento **sem
  registro** de comprovante também, porque nada foi declarado sobre ele;
- `estado` é opcional (sem ele, os dois estados pendentes). Pedir `presente` é
  recusado com 422 em vez de devolver lista vazia — lista vazia seria lida como
  "não há nada pendente";
- movimento **inativado** com pendência continua listado, com `movimento.ativo:
  false` visível: escondê-lo seria decidir, sem requisito, que evidência deixa de
  importar depois da correção;
- é **só** de comprovante. Depósito não identificado, insuficiência de pagamento e
  ambiguidade do legado têm origem própria e **não** são misturados aqui.

**Não** implementado nesta fase (C-06 segue `TO CONFIRM`): upload, armazenamento
de arquivo, blob, integração com provedor externo. As colunas
`comprovante.referencia_externa` e `comprovante.data` continuam reservadas e
**não** são preenchidas.

## Configuração

Nenhum arquivo `.env` é necessário.

| Variável | Padrão | Descrição |
|---|---|---|
| `DB_PATH` | `data/acasa.sqlite` | Caminho do banco SQLite |
| `PORT` | `3000` | Porta HTTP |

O diretório `data/` é ignorado pelo Git: **nenhum banco com dados reais é versionado.**

## Estrutura

```
migrations/     Migrations SQL versionadas (NNN_nome.sql)
scripts/        Entradas de linha de comando (migrate)
src/
  config.js     Resolução de DB_PATH / PORT
  db/           Conexão SQLite, pragmas, transações, runner de migrations
  domain/       Vocabulário do domínio (espelha os CHECK do schema)
  services/     Regras de negócio (ledger: movimento financeiro + alocação;
                comprovantes: estado da evidência e fila de pendência)
  web/          Aplicação Express
  import/       Legado: leitura do workbook, camada bruta, materialização e diagnóstico
tests/          node:test — usam banco temporário, nunca data/
docs/adr/       Decisões arquiteturais
data/           Banco local (ignorado pelo Git)
```

## Convenções

- **Dinheiro é sempre `INTEGER` em centavos.** Colunas monetárias terminam em
  `_centavos`. Nenhum `REAL`/`FLOAT` no schema (há teste que garante isso).
- **Competência é dado, não coluna.** Nunca crie colunas `jan_2024`, `fev_2024`.
- **Correção é inativação, não `DELETE`.** Entidades financeiras têm `ativo`, e
  as FKs usam `ON DELETE RESTRICT`. Inativar exige **`inativado_em` + `motivo_inativacao`
  não vazio**: o `CHECK` do banco recusa `ativo = 0` sem os dois — não existe
  inativação sem quando e por quê.
- **Migrations aplicadas são imutáveis.** O runner guarda o SHA-256 de cada arquivo
  e aborta se um já aplicado mudar. Correções entram como nova migration.
- **Valor bruto do legado nunca é sobrescrito** por uma interpretação normalizada
  (`legacy_cell.valor_bruto`).

Ver [ADR-001](docs/adr/ADR-001-arquitetura-inicial.md) para o racional completo.

## Estado atual

Implementado: fundação executável, schema inicial, migrations, `/health`, testes,
a importação **bruta** do legado (`legacy_cell`), a materialização **cadastral**
de associados a partir de A/B, o **diagnóstico/relatório de ambiguidades** do
conteúdo legado e o **ledger financeiro** (movimento manual + alocação em
competências + identificação posterior de depósito + fila paginada de movimentos
não identificados + **ajuste explícito de crédito/débito** + **inativação
auditável** das três entidades financeiras — movimento, alocação e ajuste —, com
auditoria e transação) e o **estado de comprovante por movimento** (quatro estados
estruturados + observação + fila de pendência de evidência, tudo auditado).

**Não** implementado (fora do escopo desta fase): interpretação dos códigos legados,
conversão de célula legada em movimento, cálculo de mensalidade/inadimplência,
saldo ou qualquer agregado financeiro, aplicação/compensação automática de
crédito e débito, estorno automático, conciliação, telas do MVP, upload de
comprovantes, reativação, exclusão física, edição de lançamento, autenticação.
