# Importação do legado

Três etapas **separadas e sequenciais**. A separação é deliberada: cada uma tem
um critério de aceitação próprio, e nenhuma delas deriva regra financeira da
planilha.

```text
1. captura bruta        →  legacy_cell (proveniência célula a célula)
2. materialização       →  associado, só a partir de A/B, só quando determinístico
3. diagnóstico          →  relatório descritivo, nunca normativo
```

## 1. Captura bruta

```bash
npm run import:legacy -- "<arquivo.xlsx>"
```

Essa importação é **bruta**: preserva a proveniência de cada célula (arquivo,
SHA-256, aba, endereço, valor original, tipo, fórmula e estilo) e **não interpreta
pagamentos** — nenhum valor é convertido em centavos e nenhum movimento
financeiro, alocação ou associado é criado a partir dela.

O SHA-256 do arquivo é a identidade do conteúdo: reimportar o mesmo arquivo — ou
uma cópia com outro nome — não duplica nada, e o comando informa qual importação
já registrou aquele conteúdo. A planilha real não é copiada para o repositório
(ver [`source-manifest.md`](source-manifest.md)).

## 2. Materialização de associados

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

## 3. Diagnóstico do legado

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
