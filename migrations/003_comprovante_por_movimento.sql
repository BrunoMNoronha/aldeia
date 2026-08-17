-- 003_comprovante_por_movimento.sql
-- Fase 4A - estado de comprovante por movimento financeiro.
--
-- Motivacao (M-04 / F-05 / F-10 / F-11):
-- A 001 ja criou a tabela `comprovante` com o vocabulario FROZEN dos quatro
-- estados ('presente', 'ausente', 'pendente', 'nao_aplicavel') e com todos os
-- vinculos OPCIONAIS — o comprovante existe por si so. O que faltava para
-- operar F-05 era:
--   1. garantir que um movimento tenha NO MAXIMO UM comprovante corrente, para
--      que "o estado do comprovante deste movimento" seja uma pergunta com uma
--      unica resposta, e nao uma colecao de linhas concorrentes;
--   2. tornar barata a consulta da fila de pendencia de evidencia, que filtra
--      por `estado`.
--
-- Esta migration e ADITIVA (somente CREATE INDEX): nenhuma coluna e criada,
-- alterada ou removida, nenhuma linha e tocada e nenhum dado e reinterpretado.
-- Roda tanto sobre um banco que ja possui 001+002 quanto sobre um banco criado
-- do zero.
--
-- O QUE ESTA MIGRATION NAO FAZ, por decisao explicita:
--   * nao cria coluna de arquivo, blob, caminho ou URL de comprovante: C-06
--     ([TO CONFIRM] armazenamento de arquivos) continua em aberto. A coluna
--     `comprovante.referencia_externa`, ja existente desde a 001, permanece
--     reservada e NAO e usada pela Fase 4A;
--   * nao torna `movimento_id` obrigatorio: comprovante sem movimento continua
--     valido (M-04), e o indice parcial abaixo nao o restringe;
--   * nao cria, altera nem remove estado de comprovante de nenhuma linha —
--     ausencia de registro continua sendo ausencia de registro, e NUNCA e
--     convertida em 'ausente'.

-- Um movimento tem, no maximo, UM comprovante.
--
-- Indice PARCIAL (`WHERE movimento_id IS NOT NULL`) porque em SQLite varios
-- NULL nao colidem em UNIQUE, mas a intencao precisa estar escrita: a restricao
-- vale para comprovante VINCULADO a movimento; comprovante independente (M-04)
-- pode existir aos montes, sem movimento nenhum.
--
-- A alteracao de estado acontece na propria linha (UPDATE) e o historico vive em
-- `audit_log`, com estado anterior e posterior — mesmo mecanismo ja usado pelo
-- ledger. Isso e possivel porque comprovante e EVIDENCIA, nao valor financeiro:
-- M-09 (nada some fisicamente) segue valendo para movimento, alocacao e ajuste,
-- que continuam com `ativo`/`inativado_em`/`motivo_inativacao` e sem DELETE.
CREATE UNIQUE INDEX ux_comprovante_movimento
  ON comprovante (movimento_id) WHERE movimento_id IS NOT NULL;

-- Fila de pendencia de evidencia (F-05 / F-10): a consulta filtra por `estado`
-- ('pendente' / 'ausente'). O indice `ix_comprovante_movimento` da 001 continua
-- existindo e nao e removido: migration historica nao se edita, e derrubar um
-- indice ja em uso nao pertence a esta fase.
CREATE INDEX ix_comprovante_estado ON comprovante (estado);
