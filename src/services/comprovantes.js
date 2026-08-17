'use strict';

// Estado de comprovante por movimento financeiro (Fase 4A).
//
// Requisitos do baseline atendidos aqui:
//   M-04 : comprovante e um ESTADO/EVIDENCIA independente do pagamento, com os
//          quatro estados previstos e observacao opcional.
//   M-07 : proveniencia do legado nao e tocada por este servico.
//   M-09 : nenhum registro financeiro e apagado, editado ou reativado aqui.
//   F-05 : controlar existencia/ausencia de comprovante e listar os movimentos
//          pendentes de evidencia.
//   F-10 : visao de pendencia de comprovante (SOMENTE ela — ver abaixo).
//   F-11 : toda mudanca de estado deixa trilha em `audit_log`.
//   T-07 : leitura, gravacao e auditoria acontecem na MESMA transacao.
//
// Duas regras estruturam tudo o que segue:
//
//   1. A SITUACAO OFICIAL DO COMPROVANTE E O CAMPO `estado`, NUNCA O TEXTO.
//      `observacao` existe para contexto humano ("Comprovante solicitado ao
//      associado.") e e preservada verbatim, mas nada neste modulo le, procura
//      palavra-chave ou deduz estado a partir dela.
//
//   2. AUSENCIA DE REGISTRO NAO E 'ausente'.
//      "Ninguem ainda disse nada sobre o comprovante deste movimento" e
//      "alguem verificou e declarou que o comprovante NAO existe" sao fatos
//      diferentes. O primeiro e o estado TECNICO `sem_registro` (nao existe
//      linha em `comprovante`); o segundo e o estado de dominio 'ausente'.
//      Somente o segundo entra na fila de pendencia.
//
// O que este servico NAO faz — e nao deve passar a fazer sem decisao humana:
//   * armazenar arquivo, blob, upload, PDF, imagem, link obrigatorio para
//     provedor externo ou qualquer integracao (C-06 segue TO CONFIRM);
//     `comprovante.referencia_externa` e `comprovante.data` permanecem
//     RESERVADAS e intocadas nesta fase;
//   * alterar valor, data, tipo, origem, associado, alocacoes, identificacao ou
//     `ativo` de qualquer movimento — comprovante e evidencia, nao dinheiro;
//   * reativar movimento inativado, nem impedir que um movimento inativado
//     receba/mantenha evidencia;
//   * misturar na fila de comprovante outras pendencias (deposito nao
//     identificado, insuficiencia de pagamento, ambiguidade do legado). Elas
//     tem origem propria e uma eventual visao consolidada de F-10 e outra fase;
//   * autenticar: o ator gravado e uma representacao tecnica, nunca um usuario
//     inventado (C-07 segue TO CONFIRM).

const { withTransaction } = require('../db/connection');
const { ESTADO_COMPROVANTE } = require('../domain/constants');
const { ATOR_PADRAO, PAGINACAO } = require('./ledger');

/**
 * Vocabulario dos quatro estados, vindo de `domain/constants` — que por sua vez
 * espelha o CHECK da migration 001. Nao ha segunda lista neste arquivo: uma
 * unica convencao ('presente' | 'ausente' | 'pendente' | 'nao_aplicavel'),
 * escrita como o resto do projeto escreve vocabulario estruturado.
 */
const ESTADOS = ESTADO_COMPROVANTE;

/**
 * Estado TECNICO de quem nao tem linha em `comprovante`. Nao e um estado de
 * dominio: nao existe no banco, nao pode ser enviado numa gravacao e nao entra
 * na fila de pendencia. Existe para que a ausencia de dado seja NOMEADA em vez
 * de virar 'ausente' por omissao.
 */
const SEM_REGISTRO = 'sem_registro';

/**
 * F-05 / F-10: os estados que significam "esta evidencia ainda precisa de
 * acompanhamento". 'presente' esta resolvido e 'nao_aplicavel' foi decidido —
 * nenhum dos dois e pendencia.
 */
const ESTADOS_PENDENTES = Object.freeze(['pendente', 'ausente']);

/** Marca na auditoria que a decisao foi tomada por uma pessoa, nao derivada. */
const ORIGEM_REGISTRO = 'manual';

const ACAO_COMPROVANTE_REGISTRADO = 'comprovante.registrado';
const ACAO_COMPROVANTE_ALTERADO = 'comprovante.alterado';

/**
 * Resultado declarado de uma gravacao, para que o chamador saiba o que
 * ACONTECEU sem comparar objetos:
 *   registrado  -> o movimento nao tinha comprovante e passou a ter;
 *   alterado    -> estado e/ou observacao mudaram;
 *   sem_mudanca -> reenvio identico; nada foi gravado e nada foi auditado.
 */
const ALTERACAO = Object.freeze({
  registrado: 'registrado',
  alterado: 'alterado',
  semMudanca: 'sem_mudanca',
});

const COLUNAS_COMPROVANTE = `
         id, movimento_id, estado, observacao, referencia_externa, data,
         criado_em, atualizado_em`;

const SQL_COMPROVANTE_POR_ID = `
  SELECT ${COLUNAS_COMPROVANTE}
    FROM comprovante
   WHERE id = ?
`;

const SQL_COMPROVANTE_POR_MOVIMENTO = `
  SELECT ${COLUNAS_COMPROVANTE}
    FROM comprovante
   WHERE movimento_id = ?
`;

/**
 * `referencia_externa` e `data` ficam FORA do INSERT de proposito: nenhuma das
 * duas e preenchida pela Fase 4A. Elas nascem NULL, e NULL aqui significa
 * exatamente "nao informado", nunca "nao existe arquivo".
 */
const SQL_INSERT_COMPROVANTE = `
  INSERT INTO comprovante (movimento_id, estado, observacao)
  VALUES (?, ?, ?)
`;

/**
 * A alteracao toca SOMENTE `estado`, `observacao` e `atualizado_em`.
 * `movimento_id`, `referencia_externa`, `data` e `criado_em` permanecem como
 * estavam: mudar a evidencia de um movimento nunca a transfere para outro.
 */
const SQL_ATUALIZAR_COMPROVANTE = `
  UPDATE comprovante
     SET estado = ?,
         observacao = ?,
         atualizado_em = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
   WHERE id = ?
`;

const SQL_MOVIMENTO_POR_ID = `
  SELECT id, data, valor_centavos, associado_id, estado_identificacao, ativo
    FROM movimento_financeiro
   WHERE id = ?
`;

const SQL_INSERT_AUDIT = `
  INSERT INTO audit_log
    (ator, acao, entidade_tipo, entidade_id, estado_anterior, estado_posterior, metadados)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Fila de pendencia de EVIDENCIA (F-05 / F-10).
 *
 * O JOIN com `movimento_financeiro` e obrigatorio, e nao um detalhe de
 * conveniencia: esta fila responde "quais MOVIMENTOS precisam de acompanhamento
 * de comprovante". Comprovante independente (sem movimento, M-04) existe e
 * continua valido, mas nao e um movimento e por isso nao aparece aqui.
 *
 * O filtro e apenas `c.estado IN (...)`: sao os estados EXPLICITAMENTE
 * declarados. Movimento sem linha em `comprovante` nao entra — ausencia de
 * registro nao e pendencia declarada, e transforma-la em uma seria inventar
 * regra de negocio.
 *
 * `m.ativo` NAO e filtrado: esconder um movimento inativado seria decidir, sem
 * requisito, que evidencia deixa de importar depois da correcao. O estado real
 * vai no retorno (`movimento.ativo`) e quem exibe decide o que fazer com ele.
 */
function sqlFiltroPendencias(placeholders) {
  return `
    FROM comprovante c
    JOIN movimento_financeiro m ON m.id = c.movimento_id
   WHERE c.estado IN (${placeholders})`;
}

/** `total` e contado ANTES de LIMIT/OFFSET: pagina e recorte, nao universo. */
function sqlContarPendencias(placeholders) {
  return `SELECT COUNT(*) AS total${sqlFiltroPendencias(placeholders)}`;
}

/** Ordenacao deterministica: backlog cronologico, desempate estavel pelo id. */
function sqlListarPendencias(placeholders) {
  return `
  SELECT c.id AS comprovante_id, c.movimento_id, c.estado, c.observacao,
         c.criado_em, c.atualizado_em,
         m.data AS movimento_data, m.valor_centavos AS movimento_valor_centavos,
         m.associado_id AS movimento_associado_id,
         m.estado_identificacao AS movimento_estado_identificacao,
         m.ativo AS movimento_ativo${sqlFiltroPendencias(placeholders)}
   ORDER BY m.data ASC, m.id ASC
   LIMIT ? OFFSET ?
`;
}

/**
 * Erro de dominio do comprovante.
 *
 * Classe propria — comprovante nao e ledger —, mas com o MESMO contrato ja
 * usado pelo projeto: `codigo` estavel, traduzido para status HTTP na camada
 * web. Os codigos reaproveitam o vocabulario existente (`id_invalido`,
 * `campo_invalido`, `movimento_inexistente`, `paginacao_invalida`); so
 * `estado_comprovante_invalido` e novo, porque o conceito e novo.
 */
class ComprovanteError extends Error {
  constructor(message, codigo, options) {
    super(message, options);
    this.name = 'ComprovanteError';
    this.codigo = codigo;
  }
}

// --- validacao de entrada ---------------------------------------------------

function descrever(valor) {
  if (typeof valor === 'string') return `string ${JSON.stringify(valor)}`;
  return `${typeof valor} ${String(valor)}`;
}

function exigirId(valor, campo) {
  if (typeof valor !== 'number' || !Number.isSafeInteger(valor) || valor <= 0) {
    throw new ComprovanteError(
      `${campo} deve ser um id inteiro positivo (recebido: ${descrever(valor)})`,
      'id_invalido'
    );
  }
  return valor;
}

function textoOpcional(valor, campo) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor !== 'string') {
    throw new ComprovanteError(
      `${campo} deve ser texto (recebido: ${descrever(valor)})`,
      'campo_invalido'
    );
  }
  const texto = valor.trim();
  return texto === '' ? null : texto;
}

function exigirAtor(valor) {
  return textoOpcional(valor, 'ator') ?? ATOR_PADRAO;
}

/**
 * M-04: o estado e vocabulario ESTRUTURADO e fechado. `trim().toLowerCase()` e a
 * mesma normalizacao que o projeto ja aplica a `origem` e a `tipo` de ajuste:
 * uniformiza a CAIXA da palavra, jamais traduz significado. 'PRESENTE' e
 * 'presente' sao a mesma palavra — e por isso a nomenclatura em caixa alta do
 * enunciado da fase e aceita sem criar uma segunda convencao no banco.
 *
 * Continuam RECUSADOS, porque interpreta-los seria inventar regra: 'OK',
 * 'nao aplicavel' (com espaco), 'N/A', 'sim', 'nao', 'sem_registro' (estado
 * tecnico, nao de dominio), vazio, `null` e qualquer outro valor fora da lista.
 */
function exigirEstado(valor) {
  const estado = typeof valor === 'string' ? valor.trim().toLowerCase() : '';
  if (!ESTADOS.includes(estado)) {
    throw new ComprovanteError(
      `estado deve ser um de: ${ESTADOS.join(', ')} (recebido: ${descrever(valor)})`,
      'estado_comprovante_invalido'
    );
  }
  return estado;
}

/** Mesma faixa e mesma recusa explicita da paginacao ja usada pelo ledger. */
function exigirParametroDePagina(valor, campo, { padrao, minimo, maximo = null }) {
  if (valor === null || valor === undefined) return padrao;

  if (typeof valor !== 'number' || !Number.isSafeInteger(valor)) {
    throw new ComprovanteError(
      `${campo} deve ser um inteiro (recebido: ${descrever(valor)})`,
      'paginacao_invalida'
    );
  }
  if (valor < minimo || (maximo !== null && valor > maximo)) {
    const faixa = maximo === null ? `>= ${minimo}` : `entre ${minimo} e ${maximo}`;
    throw new ComprovanteError(
      `${campo} deve estar ${faixa} (recebido: ${valor})`,
      'paginacao_invalida'
    );
  }
  return valor;
}

/**
 * Filtro OPCIONAL da fila. Ausente = os dois estados pendentes. Presente,
 * precisa ser um estado que a fila realmente serve: pedir 'presente' aqui seria
 * pedir uma pendencia que nao existe, e isso e recusado em vez de devolver
 * lista vazia (que seria lida como "nao ha nada pendente").
 */
function exigirEstadoPendente(valor) {
  if (valor === null || valor === undefined) return [...ESTADOS_PENDENTES];

  const estado = exigirEstado(valor);
  if (!ESTADOS_PENDENTES.includes(estado)) {
    throw new ComprovanteError(
      `a fila de pendencia de comprovante serve apenas: ${ESTADOS_PENDENTES.join(', ')} ` +
        `(recebido: ${descrever(valor)})`,
      'estado_comprovante_invalido'
    );
  }
  return [estado];
}

// --- mapeamento linha -> objeto de dominio ----------------------------------

function mapearComprovante(row) {
  if (row === undefined || row === null) return null;
  return {
    id: row.id,
    movimentoId: row.movimento_id,
    estado: row.estado,
    observacao: row.observacao,
    // Reservadas para o futuro (C-06). Vao no retorno para que o consumidor
    // veja que existem e estao vazias, em vez de supor que foram preenchidas.
    referenciaExterna: row.referencia_externa,
    data: row.data,
    criadoEm: row.criado_em,
    atualizadoEm: row.atualizado_em,
  };
}

/**
 * Evidencia de UM movimento, na forma em que servico, API e tela a consomem.
 *
 * `estado` e `estadoTecnico` sao campos diferentes de proposito:
 *   estado        -> o estado de DOMINIO, ou `null` quando nao ha registro;
 *   estadoTecnico -> sempre preenchido, valendo `sem_registro` quando nao ha
 *                    linha. Assim nenhum consumidor precisa escolher entre
 *                    "null" e "ausente" — a diferenca esta escrita.
 */
function evidenciaRegistrada(movimentoId, registro) {
  return {
    movimentoId,
    registrado: true,
    estado: registro.estado,
    estadoTecnico: registro.estado,
    pendenteDeEvidencia: ESTADOS_PENDENTES.includes(registro.estado),
    observacao: registro.observacao,
    registro,
  };
}

/**
 * M-04 / regra da Fase 4A: sem linha em `comprovante` o movimento nao esta
 * 'ausente' — nao ha declaracao alguma sobre ele. `pendenteDeEvidencia` e
 * `false` porque pendencia e algo DECLARADO, nunca deduzido de um vazio.
 */
function evidenciaSemRegistro(movimentoId) {
  return {
    movimentoId,
    registrado: false,
    estado: null,
    estadoTecnico: SEM_REGISTRO,
    pendenteDeEvidencia: false,
    observacao: null,
    registro: null,
  };
}

function evidenciaDaLinha(movimentoId, row) {
  return row === undefined || row === null
    ? evidenciaSemRegistro(movimentoId)
    : evidenciaRegistrada(movimentoId, mapearComprovante(row));
}

// --- auditoria (F-11) -------------------------------------------------------

/**
 * Mesma infraestrutura de auditoria do resto do sistema: a MESMA tabela
 * `audit_log`, as mesmas colunas, o mesmo ator tecnico padrao e o mesmo formato
 * JSON de estado anterior/posterior. Nao existe segundo mecanismo de trilha.
 */
function registrarAuditoria(
  db,
  { ator, acao, entidadeTipo, entidadeId, estadoAnterior = null, estadoPosterior = null, metadados = null }
) {
  db.prepare(SQL_INSERT_AUDIT).run(
    ator,
    acao,
    entidadeTipo,
    String(entidadeId),
    estadoAnterior === null ? null : JSON.stringify(estadoAnterior),
    estadoPosterior === null ? null : JSON.stringify(estadoPosterior),
    metadados === null ? null : JSON.stringify(metadados)
  );
}

// --- leitura ----------------------------------------------------------------

function exigirMovimento(db, movimentoId) {
  const row = db.prepare(SQL_MOVIMENTO_POR_ID).get(movimentoId);
  if (row === undefined) {
    throw new ComprovanteError(`movimento ${movimentoId} nao existe`, 'movimento_inexistente');
  }
  return row;
}

/**
 * Estado do comprovante de UM movimento (F-05).
 *
 * Leitura pura: nao grava, nao cria registro "sob demanda" e nao gera
 * `audit_log`. Movimento inexistente e erro (`movimento_inexistente`), nao um
 * "sem registro": nao existe evidencia de algo que nao existe.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} movimentoId
 * @returns {object} evidencia do movimento (ver `evidenciaRegistrada` /
 *          `evidenciaSemRegistro`).
 * @throws {ComprovanteError} `id_invalido`, `movimento_inexistente`.
 */
function obterComprovanteDoMovimento(db, movimentoId) {
  const id = exigirId(movimentoId, 'movimentoId');
  exigirMovimento(db, id);
  return evidenciaDaLinha(id, db.prepare(SQL_COMPROVANTE_POR_MOVIMENTO).get(id));
}

/**
 * Evidencia de VARIOS movimentos em uma consulta — usada pela tela de detalhe,
 * para nao fazer uma ida ao banco por movimento.
 *
 * O mapa tem uma entrada para CADA id pedido, inclusive os que nao possuem
 * linha em `comprovante`: quem exibe recebe `sem_registro` explicitamente, em
 * vez de uma chave faltando que poderia ser lida como 'ausente'.
 *
 * Os ids nao passam por `exigirId` porque vem do proprio banco (sao ids de
 * movimentos ja lidos); ainda assim nenhum valor e concatenado na SQL — os `?`
 * sao gerados a partir da QUANTIDADE de ids.
 *
 * @returns {Map<number, object>} movimentoId -> evidencia
 */
function obterComprovantesDeMovimentos(db, movimentoIds) {
  const mapa = new Map(movimentoIds.map((id) => [id, evidenciaSemRegistro(id)]));
  if (movimentoIds.length === 0) return mapa;

  const placeholders = movimentoIds.map(() => '?').join(', ');
  const linhas = db
    .prepare(
      `SELECT ${COLUNAS_COMPROVANTE}
         FROM comprovante
        WHERE movimento_id IN (${placeholders})`
    )
    .all(...movimentoIds);

  for (const row of linhas) {
    mapa.set(row.movimento_id, evidenciaRegistrada(row.movimento_id, mapearComprovante(row)));
  }

  return mapa;
}

/**
 * Fila paginada de movimentos com pendencia DECLARADA de comprovante
 * (F-05 / F-10).
 *
 * Consulta pura: nao grava, nao corrige estado e nao produz `audit_log`.
 *
 * Entra na fila quem tem registro de comprovante em 'pendente' ou 'ausente'.
 * NAO entram, por decisao explicita: 'presente' e 'nao_aplicavel' (resolvidos),
 * movimento sem registro de comprovante (nada foi declarado) e comprovante sem
 * movimento (M-04, nao e um movimento).
 *
 * Esta fila e SO de comprovante. Deposito nao identificado, insuficiencia de
 * pagamento e ambiguidade do legado tem cada um sua origem e NAO sao misturados
 * aqui — uma visao consolidada de F-10 e outra fase.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} [opcoes]
 * @param {string} [opcoes.estado] 'pendente' | 'ausente' (ausente = os dois)
 * @param {number} [opcoes.limite] 1..200 (padrao 50)
 * @param {number} [opcoes.offset] >= 0 (padrao 0)
 * @returns {{itens: object[], paginacao: {limite: number, offset: number, total: number},
 *           estados: string[]}}
 */
function listarPendenciasDeComprovante(db, opcoes = {}) {
  const estados = exigirEstadoPendente(opcoes.estado);
  const limite = exigirParametroDePagina(opcoes.limite, 'limite', {
    padrao: PAGINACAO.limitePadrao,
    minimo: PAGINACAO.limiteMinimo,
    maximo: PAGINACAO.limiteMaximo,
  });
  const offset = exigirParametroDePagina(opcoes.offset, 'offset', {
    padrao: PAGINACAO.offsetPadrao,
    minimo: PAGINACAO.offsetMinimo,
  });

  const placeholders = estados.map(() => '?').join(', ');
  const { total } = db.prepare(sqlContarPendencias(placeholders)).get(...estados);
  const itens = db
    .prepare(sqlListarPendencias(placeholders))
    .all(...estados, limite, offset)
    .map((row) => ({
      comprovanteId: row.comprovante_id,
      movimentoId: row.movimento_id,
      estado: row.estado,
      observacao: row.observacao,
      criadoEm: row.criado_em,
      atualizadoEm: row.atualizado_em,
      // O movimento vai junto para que a fila seja operavel sem uma segunda
      // consulta. Valor continua em CENTAVOS INTEIROS (T-06) e nada aqui soma,
      // compara ou classifica situacao financeira.
      movimento: {
        id: row.movimento_id,
        data: row.movimento_data,
        valorCentavos: row.movimento_valor_centavos,
        associadoId: row.movimento_associado_id,
        estadoIdentificacao: row.movimento_estado_identificacao,
        ativo: row.movimento_ativo === 1,
      },
    }));

  return { itens, paginacao: { limite, offset, total }, estados };
}

// --- escrita (sempre dentro de transacao) -----------------------------------

/**
 * Registra ou altera o estado do comprovante de um movimento (M-04 / F-05 / F-11).
 *
 * E a UNICA operacao de escrita desta fase, e ela e estreita de proposito: grava
 * `estado` e `observacao` na linha de `comprovante` daquele movimento, e mais
 * nada. Todas as transicoes entre os quatro estados sao permitidas
 * ('pendente' -> 'presente', 'ausente' -> 'presente', 'pendente' ->
 * 'nao_aplicavel', ...): nao ha maquina de estados aprovada no baseline, e
 * inventar uma seria criar regra de negocio.
 *
 * NADA de financeiro e tocado: valor, data, tipo, origem, associado,
 * identificacao, `ativo` e as alocacoes do movimento permanecem exatamente como
 * estavam. Movimento INATIVADO tambem aceita evidencia e NAO e reativado por
 * isso — a evidencia continua valendo para o historico (M-09).
 *
 * Unicidade: um movimento tem no maximo um comprovante (indice
 * `ux_comprovante_movimento`, migration 003). A alteracao acontece na propria
 * linha e o historico completo — estado anterior, estado novo, observacao,
 * ator e timestamp — fica em `audit_log`.
 *
 * IDEMPOTENCIA: reenviar exatamente o mesmo `estado` E a mesma `observacao` e
 * reconhecido como operacao SEM MUDANCA — nao ha UPDATE, `atualizado_em` nao se
 * move e nenhuma segunda linha de auditoria e criada. Isso preserva o
 * significado da trilha: cada registro em `audit_log` corresponde a uma mudanca
 * real. Mudou o estado OU a observacao, e alteracao, e e auditada.
 *
 * T-07: leitura, INSERT/UPDATE e `audit_log` na MESMA transacao. Se a auditoria
 * falhar, o ROLLBACK nao deixa comprovante para tras — nao existe mudanca de
 * evidencia sem trilha.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} entrada
 * @param {number} entrada.movimentoId
 * @param {string} entrada.estado             'presente'|'ausente'|'pendente'|'nao_aplicavel'
 * @param {string|null} [entrada.observacao]  contexto humano, OPCIONAL; nunca e
 *        lida para deduzir estado. Vazio/espacos viram `null`.
 * @param {string} [entrada.ator]             ator tecnico gravado na auditoria
 * @returns {object} a evidencia resultante, com `alteracao` ('registrado' |
 *          'alterado' | 'sem_mudanca').
 * @throws {ComprovanteError} `id_invalido`, `estado_comprovante_invalido`,
 *         `campo_invalido`, `movimento_inexistente`.
 */
function definirComprovanteDoMovimento(db, entrada = {}) {
  const movimentoId = exigirId(entrada.movimentoId, 'movimentoId');
  const estado = exigirEstado(entrada.estado);
  const observacao = textoOpcional(entrada.observacao, 'observacao');
  const ator = exigirAtor(entrada.ator);

  return withTransaction(db, (conexao) => {
    // O movimento precisa existir: evidencia so existe sobre algo que existe.
    // A linha e lida mas NAO e escrita em nenhum caminho desta funcao.
    exigirMovimento(conexao, movimentoId);

    const anteriorRow = conexao.prepare(SQL_COMPROVANTE_POR_MOVIMENTO).get(movimentoId);

    if (anteriorRow === undefined) {
      const info = conexao.prepare(SQL_INSERT_COMPROVANTE).run(movimentoId, estado, observacao);
      // Relido do banco: `criado_em`/`atualizado_em` vem dos defaults do schema,
      // entao o objeto devolvido e auditado e o que EXISTE, nao o que foi enviado.
      const registro = mapearComprovante(
        conexao.prepare(SQL_COMPROVANTE_POR_ID).get(Number(info.lastInsertRowid))
      );

      registrarAuditoria(conexao, {
        ator,
        acao: ACAO_COMPROVANTE_REGISTRADO,
        entidadeTipo: 'comprovante',
        entidadeId: registro.id,
        // Nao havia linha antes: o estado anterior e a AUSENCIA DE REGISTRO,
        // declarada nos metadados como `sem_registro` — nunca como 'ausente'.
        estadoAnterior: null,
        estadoPosterior: registro,
        metadados: {
          origemRegistro: ORIGEM_REGISTRO,
          movimentoId,
          estadoAnterior: SEM_REGISTRO,
          estadoNovo: estado,
          observacao,
        },
      });

      return { ...evidenciaRegistrada(movimentoId, registro), alteracao: ALTERACAO.registrado };
    }

    if (anteriorRow.estado === estado && anteriorRow.observacao === observacao) {
      return {
        ...evidenciaRegistrada(movimentoId, mapearComprovante(anteriorRow)),
        alteracao: ALTERACAO.semMudanca,
      };
    }

    const estadoAnterior = mapearComprovante(anteriorRow);

    const info = conexao.prepare(SQL_ATUALIZAR_COMPROVANTE).run(estado, observacao, anteriorRow.id);
    if (info.changes !== 1) {
      // Defensivo: a linha foi lida sob o mesmo lock de escrita desta transacao.
      throw new ComprovanteError(
        `comprovante do movimento ${movimentoId} nao foi atualizado`,
        'comprovante_nao_atualizado'
      );
    }

    const estadoPosterior = mapearComprovante(
      conexao.prepare(SQL_COMPROVANTE_POR_ID).get(anteriorRow.id)
    );

    registrarAuditoria(conexao, {
      ator,
      acao: ACAO_COMPROVANTE_ALTERADO,
      entidadeTipo: 'comprovante',
      entidadeId: anteriorRow.id,
      estadoAnterior,
      estadoPosterior,
      metadados: {
        origemRegistro: ORIGEM_REGISTRO,
        movimentoId,
        estadoAnterior: estadoAnterior.estado,
        estadoNovo: estado,
        observacao,
        // Prova, na propria trilha, que a observacao nao decidiu nada.
        criterio: 'estado informado explicitamente pelo operador',
      },
    });

    return { ...evidenciaRegistrada(movimentoId, estadoPosterior), alteracao: ALTERACAO.alterado };
  });
}

module.exports = {
  obterComprovanteDoMovimento,
  obterComprovantesDeMovimentos,
  definirComprovanteDoMovimento,
  listarPendenciasDeComprovante,
  ComprovanteError,
  ESTADOS,
  ESTADOS_PENDENTES,
  SEM_REGISTRO,
  ALTERACAO,
  ACAO_COMPROVANTE_REGISTRADO,
  ACAO_COMPROVANTE_ALTERADO,
};
