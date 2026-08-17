-- 002_legacy_cell_valor_bruto_tipado.sql
-- Fase 1A - importacao bruta do legado.
--
-- Motivacao (M-07 / M-08 / F-07):
-- A 001 guarda o valor bruto da celula em UMA unica coluna de texto
-- (`legacy_cell.valor_bruto`). Isso e ambiguo: depois de gravado, `40.02`
-- (numero da planilha) e `"40.02"` (texto digitado) ficam indistinguiveis, e
-- uma celula com formula perde a expressao que a originou. Como a Fase 1 exige
-- poder rastrear cada registro ate a celula original SEM coercao destrutiva,
-- acrescentamos o minimo necessario para preservar o tipo original e a formula.
--
-- Nada aqui interpreta conteudo: continuam valendo os TO CONFIRM C-01..C-05.
-- Nenhuma coluna monetaria e criada (T-06): `valor_json` guarda o valor BRUTO
-- como o arquivo o entregou, jamais um valor financeiro normalizado.
--
-- A idempotencia da importacao ja e garantida pela 001 e NAO e alterada aqui:
--   * `importacao.sha256` e UNIQUE  -> o mesmo conteudo nao entra duas vezes;
--   * `legacy_cell` tem UNIQUE (importacao_id, aba, endereco).
--
-- Esta migration e aditiva (somente ALTER TABLE ADD COLUMN) e roda tanto sobre
-- um banco que ja possui a 001 quanto sobre um banco criado do zero.

-- Tipo declarado pela biblioteca de leitura para a celula, preservado como
-- vocabulario estavel do importador:
--   'vazio' | 'merge' | 'numero' | 'texto' | 'texto_compartilhado' | 'data'
--   'booleano' | 'formula' | 'hyperlink' | 'rich_text' | 'erro'
-- Sem CHECK: o vocabulario acompanha a biblioteca de leitura e nao e uma regra
-- de negocio FROZEN. Um tipo novo deve chegar ao banco em vez de virar erro.
ALTER TABLE legacy_cell ADD COLUMN tipo_original TEXT;

-- Expressao da formula legada, quando existir (ex.: 'SUM(C5:C17)').
-- F-07 / regra do baseline: formula legada NUNCA e saldo oficial. Fica aqui
-- apenas como evidencia; nenhum movimento financeiro deriva dela.
ALTER TABLE legacy_cell ADD COLUMN formula TEXT;

-- Representacao textual/formatada exibida pela planilha, quando disponivel.
-- Guardada separada do valor bruto porque a formatacao e do arquivo, nao do dado.
ALTER TABLE legacy_cell ADD COLUMN texto_formatado TEXT;

-- Payload bruto estruturado (JSON) da celula: { "tipo": ..., "valor": ... } ou,
-- para formulas, { "tipo": "formula", "formula": ..., "resultado": ... }.
-- E o registro nao-ambiguo: distingue numero, texto, data, booleano, formula,
-- erro e vazio sem depender de heuristica sobre `valor_bruto`.
ALTER TABLE legacy_cell ADD COLUMN valor_json TEXT;
