# ADR-005 — Hardening e rollback seguro do deploy de produção

- **Status:** aceito
- **Data:** 2026-08-19
- **Baseline normativo aplicável:** `KB-BASELINE-ACASA-v2.0.pdf` (FROZEN — o PDF
  canônico, nunca este documento)
- **Relação com ADRs anteriores:** supera **pontos operacionais específicos** do
  [ADR-004](ADR-004-deploy-producao-vps.md), listados abaixo. Todo o resto do
  ADR-004 (VPS como destino, systemd, nginx, PostgreSQL local, release por SHA,
  segredos, TLS pendente, ausência de Docker/SaaS obrigatórios) permanece
  válido. Não toca ADR-001, ADR-002 nem ADR-003.

## Contexto

A revisão do PR #4 encontrou cinco defeitos no mecanismo de deploy antes de ele
poder ser habilitado. Nenhum deles se manifestava com `PROD_DEPLOY_ENABLED=false`,
e todos se manifestariam no primeiro deploy real:

1. **rollback automático depois de migration** — em falha de health o script
   voltava o symlink para a release anterior e a reiniciava. Uma migration já
   aplicada pode tornar aquele código incompatível com o schema novo: o
   "rollback" rodaria código antigo contra schema novo, com risco sobre dado
   financeiro (T-06/T-07);
2. **`rm -rf "$REL"` como primeira etapa** — um redeploy do mesmo SHA apagava a
   release que estava em execução; e um build interrompido deixava um diretório
   com o nome definitivo, indistinguível de uma release completa;
3. **`workflow_dispatch` aceitava qualquer ref** — o disparo manual permite
   escolher a branch, e a VPS só verificava que o commit *existia*
   (`git cat-file -e`), o que também é verdade para commit de PR não mergeado;
4. **CI verde com suíte pulada** — o job apenas imprimia a contagem de testes
   pulados; a suíte PostgreSQL inteira podia ser pulada silenciosamente. Além
   disso `npm test | tee` sem `pipefail` mascarava a própria falha do `npm test`;
5. **backup pré-deploy não fail-closed** — se a ferramenta de backup não
   existisse, o script emitia aviso e seguia para as migrations sem backup.

## Decisão

**1. Sem rollback automático depois da etapa de migration.** Health falho passa
a: registrar a falha, **parar** `aldeia.service` (não expor aplicação
defeituosa), **preservar** `current` apontando para a release nova, a release
anterior, o backup pré-deploy e os logs, e falhar com código 9 informando SHA
novo, SHA anterior, caminho do backup e ponteiro para o runbook. Nenhuma
migration é revertida, nenhum banco é restaurado automaticamente, nenhuma
release é apagada. A volta ao código anterior passa a ser decisão humana, com
prova de compatibilidade com o schema — porque hoje não existe mecanismo capaz
de provar essa compatibilidade sozinho.

**2. Releases são imutáveis; o deploy é idempotente.** `releases/<sha>` nunca é
apagada nem sobrescrita como etapa de deploy. O build acontece em
`releases/.staging-<sha>-<pid>` e só vira release definitiva por promoção
atômica (`mv -T`) depois de completo, selado por `.aldeia-release-ok`. Daí:
- SHA inexistente localmente → constrói em staging e promove;
- release existente **e selada**, não ativa → reutilizada sem reconstruir;
- release existente **sem selo** (sobra de build interrompido, nunca a ativa) →
  descartada e reconstruída, com log explícito;
- SHA **já ativo** → reexecução idempotente: confere health, não reconstrói, não
  refaz backup, não repete migrations, não apaga nada. Health ruim nesse caso
  falha com código 10 sem alterar estado.

**3. Produção recebe somente commits incorporados à `main`,** verificado em duas
camadas independentes: o workflow recusa (`exit 1`) qualquer execução com
`PROD_DEPLOY_ENABLED=true` cuja `github.ref` não seja `refs/heads/main`, e os
steps que alcançam a VPS exigem a mesma condição; a VPS, por sua vez, exige
`git merge-base --is-ancestor <sha> refs/heads/main` — existir no repositório
não basta. Fail-closed nos dois lados: ref irresolúvel reprova.

**4. CI reprova suíte incompleta.** Com `TEST_DATABASE_URL` configurada o valor
esperado é `skipped = 0`; qualquer teste pulado reprova o job, e um resumo
ilegível também reprova (nunca é lido como zero). O step de teste passa a usar
`set -o pipefail`. Nenhum fallback para `DATABASE_URL` é introduzido: o CI jamais
se conecta ao PostgreSQL de produção. Skips intencionais no futuro exigirão
decisão explícita e lista permitida — não há exceção agora.

**5. Backup pré-deploy é fail-closed.** Nenhuma migration começa se a ferramenta
de backup estiver ausente/não executável, se ela retornar erro, ou se não
produzir no diretório de backup um arquivo novo e não vazio. Retenção e destino
não mudam (nada de off-site nesta decisão).

**6. Testabilidade.** O script aceita overrides `ALDEIA_*` (base, env file,
comando/diretório de backup, URL e tentativas de health, ref da main) usados
**exclusivamente** pelos testes automatizados; o deploy real não define nenhuma
delas — a sessão SSH é aberta com comando fixo e sem encaminhamento de ambiente.
`tests/deploy-production-script.test.js` executa o script de verdade contra um
repositório Git real e stubs de `npm`/`curl`/`sudo`/`flock`/backup, provando os
comportamentos acima; `tests/deploy-production-workflow.test.js` fixa o contrato
do YAML (gate de ref, gate de skips, host key, único parâmetro externo).

## Pontos do ADR-004 superados

| ADR-004 | ADR-005 |
|---|---|
| health falho → symlink volta para a release anterior + restart | health falho → serviço parado, estado preservado, falha para intervenção humana |
| `rm -rf "$REL"` antes de materializar a release | release imutável, build em staging com promoção atômica e selo de integridade |
| SHA validado por formato + existência (`cat-file -e`) | além disso, ancestralidade obrigatória em `refs/heads/main` |
| `workflow_dispatch` podia alcançar a VPS de qualquer ref | deploy recusado fora de `refs/heads/main`, nas duas camadas |
| contagem de testes pulados apenas informativa | `skipped != 0` (ou resumo ilegível) reprova o job |
| backup ausente → aviso e segue para migrations | backup ausente/falho/sem arquivo → migration não começa |

Permanece integralmente válido no ADR-004: destino VPS, systemd, nginx,
PostgreSQL 16 local loopback-only, release identificada por SHA, chave SSH
dedicada com host key verificada, segredos fora do Git, TLS pendente de domínio,
backup off-site pendente de decisão, e o **gate PG-6**.

## Consequências

- Um health falho pós-migration deixa o serviço **parado** até intervenção. É
  uma indisponibilidade explícita em vez de um rollback silencioso e arriscado —
  a troca é deliberada e está documentada no runbook.
- O `sudoers` do usuário `aldeia` passa a permitir também `systemctl stop
  aldeia.service` (template em `deploy/sudoers/aldeia`).
- Um redeploy do mesmo SHA vira operação segura e barata, útil como verificação.
- **Nada disto ativa produção.** `PROD_DEPLOY_ENABLED` permanece `false` e o gate
  PG-6 (ADR-003) segue sendo o bloqueador do go-live: a `main` ainda roda SQLite.
