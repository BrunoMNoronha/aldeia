# Comprovantes e pendência de evidência

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

> **Transporte.** Como no [ledger](ledger.md), os exemplos `curl` descrevem o
> contrato HTTP servido hoje pelo Express. A migração para Route Handlers do
> Next.js (NX-1) preserva status e códigos de erro — ver
> [ADR-002](../adr/ADR-002-nextjs-app-router.md).

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

## Fila de pendência de comprovante

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

## Fora de escopo

**Não** implementado nesta fase (C-06 segue `TO CONFIRM`): upload, armazenamento
de arquivo, blob, integração com provedor externo. As colunas
`comprovante.referencia_externa` e `comprovante.data` continuam reservadas e
**não** são preenchidas.
