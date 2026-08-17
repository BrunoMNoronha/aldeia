-- 001_initial_schema.sql
-- Schema inicial do MVP TechLab+ Aldeia / ACASA.
--
-- Convencoes obrigatorias (baseline FROZEN):
--   T-06 : todo valor monetario e INTEGER em CENTAVOS. Nunca REAL/FLOAT.
--   M-01 : este schema NAO espelha a planilha legada.
--   M-02 : movimento <-> competencia e N:N via `alocacao`.
--   M-05 : `movimento_financeiro.associado_id` e OPCIONAL (deposito nao identificado).
--   M-06 : status cadastral != situacao financeira (nao ha coluna de situacao financeira aqui).
--   M-07 : proveniencia do legado em `legacy_cell` / `legacy_cell_link`.
--   M-09 : correcao por INATIVACAO (`ativo = 0`), nunca por DELETE fisico.
--          Inativar SEMPRE exige `inativado_em` e `motivo_inativacao` nao vazio:
--          o banco recusa uma entidade financeira inativa sem trilha do porque.
--   M-10 : competencia e DADO (linhas), nunca coluna mensal.
--
-- Datas sao texto ISO-8601 (YYYY-MM-DD ou YYYY-MM-DDTHH:MM:SSZ), padrao do SQLite.
-- Nenhuma FK usa ON DELETE CASCADE em entidade financeira: preservacao historica.

-- ---------------------------------------------------------------------------
-- associado
-- ---------------------------------------------------------------------------
CREATE TABLE associado (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  -- ID da planilha preservado como TEXTO (pode ter zeros a esquerda / nao numerico).
  legacy_id           TEXT UNIQUE,
  nome                TEXT NOT NULL,
  -- Status CADASTRAL. Nao e situacao financeira (M-06).
  status_cadastral    TEXT NOT NULL DEFAULT 'indefinido'
                        CHECK (status_cadastral IN ('ativo', 'inativo', 'desligado', 'indefinido')),
  -- Codigo bruto da planilha ('a', 'i', 'DESLIGADO', ...) preservado SEM interpretacao.
  -- TO CONFIRM: o significado oficial destes codigos ainda nao foi decidido.
  -- Nenhum mapeamento automatico legacy_status_code -> status_cadastral deve existir.
  legacy_status_code  TEXT,
  observacoes         TEXT,
  criado_em           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  atualizado_em       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX ix_associado_nome ON associado (nome);
CREATE INDEX ix_associado_status ON associado (status_cadastral);

-- ---------------------------------------------------------------------------
-- competencia  (M-10: competencia e dado, nao coluna)
-- ---------------------------------------------------------------------------
CREATE TABLE competencia (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  ano                      INTEGER NOT NULL CHECK (ano BETWEEN 1900 AND 2999),
  mes                      INTEGER NOT NULL CHECK (mes BETWEEN 1 AND 12),
  -- Valor esperado OPCIONAL. TO CONFIRM: mensalidade e vigencias nao estao decididas.
  valor_esperado_centavos  INTEGER
                             CHECK (valor_esperado_centavos IS NULL OR valor_esperado_centavos >= 0),
  -- Identificador livre de regra aplicavel (texto). Regra em si nao e implementada aqui.
  regra                    TEXT,
  observacao               TEXT,
  criado_em                TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  atualizado_em            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (ano, mes)
);

-- ---------------------------------------------------------------------------
-- movimento_financeiro
-- ---------------------------------------------------------------------------
CREATE TABLE movimento_financeiro (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  data                  TEXT NOT NULL,
  -- T-06: centavos inteiros.
  valor_centavos        INTEGER NOT NULL CHECK (valor_centavos > 0),
  -- M-03: direcao do dinheiro e estruturada, nao texto livre.
  tipo                  TEXT NOT NULL CHECK (tipo IN ('credito', 'debito')),
  -- Origem do lancamento (deposito, transferencia, importacao...). Vocabulario ainda
  -- nao normativo, portanto texto livre com default explicito.
  origem                TEXT NOT NULL DEFAULT 'desconhecida',
  -- M-05: OPCIONAL. Deposito nao identificado existe sem associado.
  associado_id          INTEGER REFERENCES associado (id) ON DELETE RESTRICT,
  observacao            TEXT,
  estado_identificacao  TEXT NOT NULL DEFAULT 'nao_identificado'
                          CHECK (estado_identificacao IN ('identificado', 'nao_identificado', 'em_revisao')),
  -- M-09: correcao sem exclusao fisica.
  ativo                 INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
  inativado_em          TEXT,
  motivo_inativacao     TEXT,
  criado_em             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  atualizado_em         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- M-09: inativar exige QUANDO e POR QUE. Sem os dois, o banco recusa.
  CHECK (
    ativo = 1
    OR (
      inativado_em IS NOT NULL
      AND motivo_inativacao IS NOT NULL
      AND trim(motivo_inativacao) <> ''
    )
  )
);

CREATE INDEX ix_movimento_data ON movimento_financeiro (data);
CREATE INDEX ix_movimento_associado ON movimento_financeiro (associado_id);
CREATE INDEX ix_movimento_identificacao ON movimento_financeiro (estado_identificacao);

-- ---------------------------------------------------------------------------
-- alocacao  (M-02: N:N entre movimento e competencia)
-- ---------------------------------------------------------------------------
CREATE TABLE alocacao (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  movimento_id       INTEGER NOT NULL REFERENCES movimento_financeiro (id) ON DELETE RESTRICT,
  competencia_id     INTEGER NOT NULL REFERENCES competencia (id) ON DELETE RESTRICT,
  valor_centavos     INTEGER NOT NULL CHECK (valor_centavos > 0),
  observacao         TEXT,
  ativo              INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
  inativado_em       TEXT,
  motivo_inativacao  TEXT,
  criado_em          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  atualizado_em      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- M-09: inativar exige QUANDO e POR QUE. Sem os dois, o banco recusa.
  CHECK (
    ativo = 1
    OR (
      inativado_em IS NOT NULL
      AND motivo_inativacao IS NOT NULL
      AND trim(motivo_inativacao) <> ''
    )
  )
);

-- Um movimento so pode ter UMA alocacao ATIVA por competencia; alocacoes
-- inativadas permanecem no historico e nao bloqueiam uma nova (M-09).
CREATE UNIQUE INDEX ux_alocacao_ativa
  ON alocacao (movimento_id, competencia_id) WHERE ativo = 1;

CREATE INDEX ix_alocacao_movimento ON alocacao (movimento_id);
CREATE INDEX ix_alocacao_competencia ON alocacao (competencia_id);

-- ---------------------------------------------------------------------------
-- ajuste_credito_debito  (M-03)
-- ---------------------------------------------------------------------------
CREATE TABLE ajuste_credito_debito (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  associado_id       INTEGER NOT NULL REFERENCES associado (id) ON DELETE RESTRICT,
  tipo               TEXT NOT NULL CHECK (tipo IN ('credito', 'debito')),
  valor_centavos     INTEGER NOT NULL CHECK (valor_centavos > 0),
  motivo             TEXT NOT NULL,
  data               TEXT NOT NULL,
  competencia_id     INTEGER REFERENCES competencia (id) ON DELETE RESTRICT,
  observacao         TEXT,
  ativo              INTEGER NOT NULL DEFAULT 1 CHECK (ativo IN (0, 1)),
  inativado_em       TEXT,
  motivo_inativacao  TEXT,
  criado_em          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  atualizado_em      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- M-09: inativar exige QUANDO e POR QUE. Sem os dois, o banco recusa.
  CHECK (
    ativo = 1
    OR (
      inativado_em IS NOT NULL
      AND motivo_inativacao IS NOT NULL
      AND trim(motivo_inativacao) <> ''
    )
  )
);

CREATE INDEX ix_ajuste_associado ON ajuste_credito_debito (associado_id);
CREATE INDEX ix_ajuste_competencia ON ajuste_credito_debito (competencia_id);

-- ---------------------------------------------------------------------------
-- comprovante  (M-04: conceito independente do pagamento)
-- ---------------------------------------------------------------------------
CREATE TABLE comprovante (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  estado              TEXT NOT NULL DEFAULT 'pendente'
                        CHECK (estado IN ('presente', 'ausente', 'pendente', 'nao_aplicavel')),
  -- Todos os vinculos sao OPCIONAIS: o comprovante existe por si so.
  movimento_id        INTEGER REFERENCES movimento_financeiro (id) ON DELETE RESTRICT,
  associado_id        INTEGER REFERENCES associado (id) ON DELETE RESTRICT,
  competencia_id      INTEGER REFERENCES competencia (id) ON DELETE RESTRICT,
  -- Referencia futura ao arquivo/evidencia. TO CONFIRM: armazenamento de arquivos
  -- nao foi decidido; NENHUM upload e implementado nesta fase.
  referencia_externa  TEXT,
  data                TEXT,
  observacao          TEXT,
  criado_em           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  atualizado_em       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX ix_comprovante_movimento ON comprovante (movimento_id);
CREATE INDEX ix_comprovante_associado ON comprovante (associado_id);

-- ---------------------------------------------------------------------------
-- pendencia  (M-08: dado ambiguo preservado para revisao humana)
-- ---------------------------------------------------------------------------
CREATE TABLE pendencia (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  tipo           TEXT NOT NULL,
  associado_id   INTEGER REFERENCES associado (id) ON DELETE RESTRICT,
  movimento_id   INTEGER REFERENCES movimento_financeiro (id) ON DELETE RESTRICT,
  descricao      TEXT NOT NULL,
  prioridade     TEXT NOT NULL DEFAULT 'media'
                   CHECK (prioridade IN ('baixa', 'media', 'alta')),
  estado         TEXT NOT NULL DEFAULT 'aberta'
                   CHECK (estado IN ('aberta', 'em_analise', 'resolvida', 'descartada')),
  resolucao      TEXT,
  resolvida_em   TEXT,
  resolvida_por  TEXT,
  criado_em      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  atualizado_em  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (estado NOT IN ('resolvida', 'descartada') OR resolvida_em IS NOT NULL)
);

CREATE INDEX ix_pendencia_estado ON pendencia (estado);
CREATE INDEX ix_pendencia_associado ON pendencia (associado_id);

-- ---------------------------------------------------------------------------
-- importacao  (M-07)
-- ---------------------------------------------------------------------------
CREATE TABLE importacao (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  nome_arquivo       TEXT NOT NULL,
  -- UNIQUE: impede reimportacao SILENCIOSA do mesmo arquivo. Reimportar exige
  -- acao explicita (inativar/registrar a importacao anterior).
  sha256             TEXT NOT NULL UNIQUE CHECK (length(sha256) = 64),
  importado_em       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  versao_importador  TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pendente'
                       CHECK (status IN ('pendente', 'concluida', 'falhou', 'revertida')),
  -- Resumo serializado (JSON) do resultado da importacao.
  resultado          TEXT,
  observacao         TEXT
);

-- ---------------------------------------------------------------------------
-- legacy_cell  (M-07: proveniencia ate arquivo/aba/celula/valor bruto)
-- ---------------------------------------------------------------------------
CREATE TABLE legacy_cell (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  importacao_id   INTEGER NOT NULL REFERENCES importacao (id) ON DELETE RESTRICT,
  aba             TEXT NOT NULL,
  endereco        TEXT NOT NULL,
  linha           INTEGER,
  coluna          INTEGER,
  -- VALOR BRUTO ORIGINAL, sempre TEXTO. Nunca substituido por interpretacao.
  valor_bruto     TEXT,
  -- Estilo relevante da celula serializado (JSON): cor de fundo, negrito, etc.
  -- TO CONFIRM: cores nao documentadas nao possuem significado definido.
  estilo          TEXT,
  -- Classificacao atribuida posteriormente pelo importador/revisor.
  classificacao   TEXT,
  estado_revisao  TEXT NOT NULL DEFAULT 'nao_revisado'
                    CHECK (estado_revisao IN ('nao_revisado', 'revisado', 'ambiguo', 'descartado')),
  criado_em       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (importacao_id, aba, endereco)
);

CREATE INDEX ix_legacy_cell_importacao ON legacy_cell (importacao_id);
CREATE INDEX ix_legacy_cell_revisao ON legacy_cell (estado_revisao);

-- Vinculo explicito celula -> entidade produzida por ela.
-- Referencia polimorfica intencional (sem FK): aponta para varias tabelas.
CREATE TABLE legacy_cell_link (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  legacy_cell_id  INTEGER NOT NULL REFERENCES legacy_cell (id) ON DELETE RESTRICT,
  entidade_tipo   TEXT NOT NULL
                    CHECK (entidade_tipo IN ('associado', 'competencia', 'movimento_financeiro',
                                             'alocacao', 'ajuste_credito_debito', 'comprovante',
                                             'pendencia')),
  entidade_id     INTEGER NOT NULL,
  papel           TEXT NOT NULL DEFAULT 'origem',
  criado_em       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (legacy_cell_id, entidade_tipo, entidade_id, papel)
);

CREATE INDEX ix_legacy_cell_link_entidade ON legacy_cell_link (entidade_tipo, entidade_id);

-- ---------------------------------------------------------------------------
-- audit_log
-- Estrutura preparada. O preenchimento automatico e responsabilidade da
-- aplicacao em tarefas futuras (nao ha trigger nesta fase).
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ator              TEXT NOT NULL DEFAULT 'sistema',
  acao              TEXT NOT NULL,
  entidade_tipo     TEXT NOT NULL,
  entidade_id       TEXT,
  estado_anterior   TEXT,
  estado_posterior  TEXT,
  metadados         TEXT,
  criado_em         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX ix_audit_entidade ON audit_log (entidade_tipo, entidade_id);
CREATE INDEX ix_audit_criado_em ON audit_log (criado_em);
