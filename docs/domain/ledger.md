# Ledger financeiro

Núcleo transacional do dinheiro (`src/services/ledger.js`). Um **movimento**
(pagamento ou depósito) é registrado **manualmente** e depois **alocado** em zero,
uma ou várias **competências** — e uma competência recebe alocações de vários
movimentos.

> **Transporte.** Os exemplos `curl` abaixo descrevem o contrato HTTP servido
> hoje pelo Express (`npm run start:express`). As rotas `/api/*` migram para
> Route Handlers do Next.js na fase NX-1, **preservando status e códigos de
> erro** — ver [ADR-002](../adr/ADR-002-nextjs-app-router.md). O contrato
> descrito aqui é o do domínio e não muda com o transporte.

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

## Identificação posterior de um depósito

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

## Correção de lançamento: inativação auditável

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

## Ajuste explícito de crédito/débito

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

### Corrigindo um ajuste: inativação

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

## Fila de movimentos não identificados

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
