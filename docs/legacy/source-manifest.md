# Manifesto das fontes legadas

Registro dos arquivos de origem do controle da ACASA. **Este documento contém
apenas metadados.** Nenhum conteúdo bruto — nome de associado, valor, data ou
qualquer dado pessoal/financeiro real — é reproduzido aqui.

## Por que existe

Os arquivos abaixo são a origem do sistema e a identidade deles importa: a
importação usa o **SHA-256 do conteúdo** como chave de idempotência (reimportar o
mesmo arquivo, ainda que renomeado, não duplica nada). Ao mesmo tempo, eles
contêm dados pessoais e financeiros reais de associados e **não podem ficar
versionados em repositório Git público**.

O manifesto resolve os dois lados: a identidade fica versionada e auditável, o
conteúdo não.

## Fontes

### `controle-de-pagamento.xlsx`

| Campo | Valor |
|---|---|
| **Nome lógico** | Planilha de controle de pagamentos da ACASA |
| **Finalidade** | Fonte do controle legado; entrada de `npm run import:legacy` |
| **Classificação** | **Fonte privada** — dados pessoais e financeiros reais |
| **SHA-256** | `23762ce1a462c5aa511e5fa357e41c3ceedfbb504a8560e90365e35cbe7472c0` |
| **Versionado no Git** | **Não.** Ignorado por `.gitignore`; permanece apenas na cópia local. |

Este SHA-256 é o **valor canônico**, confirmado por recálculo local. É ele que
aparece em `importacao.sha256` e é ele que torna a reimportação idempotente.

### `ficha-de-cadastro.pdf`

| Campo | Valor |
|---|---|
| **Nome lógico** | Ficha de cadastro de associado |
| **Finalidade** | Documento de referência do cadastro; **não** é lido por nenhum script |
| **Classificação** | **Fonte privada** — dados pessoais reais |
| **SHA-256** | `22eb1ebe2af7ef21714cb3b25ea89f98f0a20289160be7e3cb5023c15b99fd35` |
| **Versionado no Git** | **Não.** Ignorado por `.gitignore`; permanece apenas na cópia local. |

O SHA-256 foi **calculado localmente** sobre a cópia existente no ambiente de
desenvolvimento, não presumido.

## Onde os arquivos ficam

Fora do Git. As opções previstas, em ordem de preferência:

1. na raiz do projeto, ignorada pelo `.gitignore` (situação atual);
2. em `private/`, diretório ignorado por inteiro;
3. em qualquer caminho fora do repositório — a importação recebe o caminho como
   argumento:

```bash
npm run import:legacy -- "<caminho/para/arquivo.xlsx>"
```

Nada no código resolve esses arquivos por caminho fixo dentro do repositório.

## Aviso sobre o histórico do Git

Os dois arquivos **estiveram versionados** e foram removidos apenas do **estado
atual** da branch. Remover do índice **não apaga as cópias já gravadas no
histórico** — elas continuam alcançáveis por commits anteriores, localmente e no
remoto `origin`.

Limpar o histórico exige reescrita (`git filter-repo` ou equivalente) seguida de
**force-push coordenado**, com invalidação de clones existentes. É uma **tarefa
humana separada**, que depende de decisão explícita do responsável pelo projeto,
e **não** foi executada aqui.

Enquanto isso não acontecer, trate o conteúdo desses arquivos como **já exposto**
a quem tenha tido acesso ao repositório.
