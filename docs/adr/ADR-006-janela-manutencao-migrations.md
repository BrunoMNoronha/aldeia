# ADR-006 — Janela de manutenção segura para migrations de produção

- **Status:** aceito
- **Data:** 2026-08-19
- **Baseline normativo aplicável:** `KB-BASELINE-ACASA-v2.0.pdf` (FROZEN — o PDF
  canônico, nunca este documento)
- **Relação com ADRs anteriores:** supera **pontos operacionais específicos** do
  [ADR-005](ADR-005-hardening-deploy-producao.md) (momento do backup e alcance
  do fail-safe). Tudo o mais em ADR-004 e ADR-005 permanece válido: release
  imutável, redeploy idempotente, SHA restrito à `main`, backup fail-closed,
  CI reprovando suíte pulada, host key verificada, segredos fora do Git.

## Contexto

Depois do ADR-005 sobrava um risco de janela — pequeno em probabilidade,
inaceitável em consequência. O fluxo era:

```text
build → backup → migrate → troca current → restart → health
```

Dois problemas nessa ordem:

1. **Código antigo atendendo durante a mudança de schema.** O `systemctl
   restart` só acontecia depois das migrations, então durante `backup` e
   `migrate:postgresql` o processo da release anterior continuava servindo
   requests — escrevendo contra um schema em transformação. O backup, além
   disso, era tirado com a aplicação ainda escrevendo: não representava um ponto
   consistente imediatamente anterior à migration.
2. **Fail-safe restrito ao health check.** A parada preventiva do serviço vivia
   dentro do bloco de health falho. Uma falha em `ln`, `mv` ou `systemctl
   restart` encerrava o script pelo `set -e` **sem passar por aquele bloco**,
   deixando o estado proibido: schema novo com processo antigo ainda ativo.

## Decisão

**1. Build fora da janela; janela crítica explícita.** Tudo o que não altera
produção — validação do SHA e da ancestralidade, materialização da release,
`npm ci`, `npm run build`, gate PG-6 (`migrate:postgresql` existe?), existência
do arquivo de ambiente e do comando de backup — acontece com a aplicação **no
ar**. Um gate reprovado nunca custa indisponibilidade.

**2. A aplicação é parada antes do backup e da migration.** Aberta a janela:
`systemctl stop`, seguido de confirmação em duas fontes independentes —
`systemctl is-active` e uma requisição ao `/health` que **precisa falhar**.
Enquanto não houver quiescência comprovada, nenhuma migration começa (código 11).

**3. Backup quiescente.** O `pg_dump` roda com a aplicação parada, portanto sem
writes entre o dump e a migration. Formato custom, retenção de 14 dias, mesmo
diretório e off-site ainda pendente: nada disso muda.

**4. `MIGRATION_STARTED` é o ponto sem retorno automático.** Marcado
imediatamente antes de `npm run migrate:postgresql`. A partir dele nenhuma falha
religa a release anterior — **inclusive a falha do próprio migrator**, que pode
ter aplicado migrations anteriores antes de parar numa posterior.

**5. Fail-safe global, não local.** Um único `trap ... EXIT` (que também faz a
limpeza do staging, sem traps concorrentes) decide pelo estado observado —
`MIGRATION_STARTED`, `DEPLOY_SUCCEEDED`, `SERVICE_WAS_ACTIVE`, fase atual, SHA,
SHA anterior, backup produzido:

- **falhou depois de `MIGRATION_STARTED`** → `systemctl stop` defensivo, registro
  `FALHA-POS-MIGRATION`, tudo preservado (current conforme a fase alcançada,
  release anterior, release nova, backup, logs) e o código de erro original
  intacto. Cobre migration, `ln`, `mv`, `restart`, health e qualquer comando
  intermediário;
- **falhou dentro da janela mas antes de `MIGRATION_STARTED`** → o schema está
  intacto, então a release anterior é religada (sem trocar `current`) e seu
  health é conferido; se a restauração não for segura, isso é reportado
  explicitamente. Sem serviço anterior ativo (primeiro deploy), não se inventa
  rollback;
- **falhou antes da janela** → nada a desfazer.

Nunca há restauração automática de banco nem reversão de migration.

**6. Redeploy idempotente preservado.** SHA já ativo continua sendo apenas uma
verificação de health: não para o serviço, não abre janela, não faz backup, não
migra, não reconstrói, não troca symlink.

## Ponto superado do ADR-005

| ADR-005 | ADR-006 |
|---|---|
| backup e migration com a aplicação possivelmente atendendo | aplicação parada e quiescência comprovada antes do backup |
| parada preventiva apenas no bloco de health falho | fail-safe global no `trap EXIT`, cobrindo qualquer falha pós-migration |
| retorno automático inexistente em qualquer caso | retorno automático permitido **apenas** antes da primeira migration |

## Consequências

- **Todo deploy passa a ter indisponibilidade planejada** — a duração da janela é
  backup + migrations + restart, não mais só o restart. É o preço de nunca ter
  código antigo contra schema novo, e a operação é de baixa frequência.
- Uma falha pós-migration deixa produção parada até intervenção humana; uma
  falha pré-migration se auto-recupera. A diferença é observável no
  `deploy-history.log` (`RESTAURADO-PRE-MIGRATION` × `FALHA-POS-MIGRATION`).
- Os cenários são provados por `tests/deploy-production-janela.test.js` (M1–M10),
  que observa a ordem real dos eventos: o `systemctl` do harness mantém o estado
  do serviço e o `curl` só responde quando esse estado é `active`.
- **Nada disto ativa produção.** `PROD_DEPLOY_ENABLED` permanece `false` e o gate
  PG-6 (ADR-003) segue sendo o bloqueador do go-live.
