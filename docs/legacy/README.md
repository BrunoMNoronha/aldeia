# Legado — regras de fonte e proveniência

O sistema substitui um controle mantido em planilha. Esta pasta documenta como o
conteúdo legado entra no sistema e, principalmente, **o que o sistema se recusa a
concluir sobre ele**.

| Documento | Conteúdo |
|---|---|
| [`source-manifest.md`](source-manifest.md) | Metadados e SHA-256 das fontes privadas. Nenhum dado bruto. |
| [`importacao.md`](importacao.md) | As três etapas: captura bruta, materialização cadastral e diagnóstico. |

## As três regras que não se negociam

### 1. Fonte privada não é versionada

`controle-de-pagamento.xlsx` e `ficha-de-cadastro.pdf` contêm dados pessoais e
financeiros reais. Eles ficam **fora do Git**, e o que fica versionado é o
manifesto: nome lógico, finalidade, classificação e SHA-256.

O SHA-256 é o que permite auditar *qual* arquivo produziu *qual* importação sem
guardar o arquivo.

### 2. Proveniência é preservada célula a célula (M-07)

A captura é **bruta**. Cada célula lida vira uma linha em `legacy_cell` com
arquivo, SHA-256, aba, endereço, linha, coluna, `valor_bruto`, tipo original,
fórmula e estilo. Toda entidade materializada a partir do legado guarda o
vínculo com a célula que a originou, em `legacy_cell_link`.

**`legacy_cell.valor_bruto` nunca é sobrescrito** por uma interpretação
normalizada. O valor original permanece disponível mesmo depois de alguém
decidir o que ele significa.

### 3. Ambiguidade não é resolvida em silêncio (M-08)

Onde o legado é ambíguo, o sistema **para e reporta** — não escolhe.

Continuam **TO CONFIRM**, e nenhum código os transforma em regra:

- o significado dos códigos `a`, `i`, `DESLIGADO`;
- as abreviações `c`, `f15`, `LG`, `TLA`, `TMC`, `TRA`;
- as cores sem legenda documentada;
- a hipótese de identificar o associado pelos **centavos** do depósito;
- o valor e a vigência da mensalidade;
- se `BJ` representa saldo e se `BM` representa status.

O diagnóstico **mede** esses pontos e os reporta como evidência. Ele nunca os
aplica. Token desconhecido continua desconhecido; cor sem legenda continua
`significado_nao_confirmado`; a coincidência entre centavos e `legacy_id` é
registrada como `hipotese_nao_aplicada`, incluindo a medição do próprio poder
discriminante do teste.

## O que o legado **não** produz

Nenhum movimento financeiro, alocação, ajuste ou comprovante nasce da planilha.
O ledger (ver [`../domain/ledger.md`](../domain/ledger.md)) é alimentado
**manualmente** pelo operador. A única coisa que a importação materializa é
cadastro de associado, e apenas a partir das colunas `A` (`legacy_id`) e `B`
(`nome`), quando determinístico.
