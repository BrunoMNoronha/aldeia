'use strict';

// Importacao BRUTA da planilha legada (Fase 1A).
//
// O que este servico faz:
//   1. calcula o SHA-256 dos bytes reais do arquivo (identidade de conteudo);
//   2. registra uma `importacao` com nome, hash e timestamp (M-07);
//   3. grava cada celula relevante em `legacy_cell` com proveniencia completa;
//   4. faz tudo dentro de UMA transacao (T-07);
//   5. recusa reimportar o mesmo conteudo (idempotencia por hash).
//
// O que este servico NAO faz — e nao deve passar a fazer sem decisao humana:
//   * criar associado, competencia, movimento_financeiro, alocacao ou ajuste;
//   * converter valor da planilha em centavos (T-06);
//   * interpretar 'a', 'i', 'DESLIGADO', 'c20', 'f15', 'LG' (C-01..C-04);
//   * atribuir significado a cor (C-05);
//   * tratar resultado de formula legada como saldo.
//
// Dado ambiguo entra intacto e assim permanece (M-08); a analise vem depois,
// a partir de `legacy_cell` (F-07).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { withTransaction } = require('../db/connection');
const { lerWorkbookDeBytes } = require('./workbook-reader');

/** Identificacao do importador gravada em `importacao.versao_importador`. */
const VERSAO_IMPORTADOR = 'legacy-xlsx/1.0.0';

/** Colunas de proveniencia introduzidas pela migration 002. */
const COLUNAS_EXIGIDAS = Object.freeze(['tipo_original', 'formula', 'texto_formatado', 'valor_json']);

const SQL_INSERT_IMPORTACAO = `
  INSERT INTO importacao (nome_arquivo, sha256, versao_importador, status)
  VALUES (?, ?, ?, 'pendente')
`;

const SQL_INSERT_CELULA = `
  INSERT INTO legacy_cell (
    importacao_id, aba, endereco, linha, coluna,
    valor_bruto, estilo, tipo_original, formula, texto_formatado, valor_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const SQL_CONCLUIR = `
  UPDATE importacao SET status = 'concluida', resultado = ? WHERE id = ?
`;

const SQL_BUSCAR_POR_SHA = `
  SELECT id, nome_arquivo, sha256, importado_em, versao_importador, status, resultado
    FROM importacao
   WHERE sha256 = ?
`;

class ImportacaoError extends Error {
  constructor(message, codigo, options) {
    super(message, options);
    this.name = 'ImportacaoError';
    this.codigo = codigo;
  }
}

function validarCaminho(caminhoArquivo) {
  if (typeof caminhoArquivo !== 'string' || caminhoArquivo.trim() === '') {
    throw new ImportacaoError(
      'caminho do arquivo .xlsx nao informado',
      'argumento_ausente'
    );
  }

  const caminho = path.resolve(caminhoArquivo.trim());

  let stats;
  try {
    stats = fs.statSync(caminho);
  } catch (error) {
    throw new ImportacaoError(`arquivo nao encontrado: ${caminho}`, 'arquivo_inexistente', {
      cause: error,
    });
  }

  if (!stats.isFile()) {
    throw new ImportacaoError(`caminho nao e um arquivo: ${caminho}`, 'caminho_invalido');
  }

  return caminho;
}

function lerBytes(caminho) {
  try {
    return fs.readFileSync(caminho);
  } catch (error) {
    throw new ImportacaoError(`arquivo nao pode ser lido: ${caminho}`, 'arquivo_ilegivel', {
      cause: error,
    });
  }
}

/** SHA-256 dos bytes originais, antes de qualquer normalizacao (M-07). */
function calcularSha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function exigirSchemaAtualizado(db) {
  const colunas = db.prepare('PRAGMA table_info(legacy_cell)').all().map((linha) => linha.name);

  if (colunas.length === 0) {
    throw new ImportacaoError(
      'tabela legacy_cell nao existe; rode `npm run migrate`',
      'schema_desatualizado'
    );
  }

  const faltando = COLUNAS_EXIGIDAS.filter((coluna) => !colunas.includes(coluna));
  if (faltando.length > 0) {
    throw new ImportacaoError(
      `legacy_cell sem as colunas ${faltando.join(', ')}; rode \`npm run migrate\``,
      'schema_desatualizado'
    );
  }
}

function buscarPorSha256(db, sha256) {
  return db.prepare(SQL_BUSCAR_POR_SHA).get(sha256) ?? null;
}

function ehSha256Duplicado(error) {
  return (
    error !== null &&
    typeof error === 'object' &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE' &&
    typeof error.message === 'string' &&
    error.message.includes('importacao.sha256')
  );
}

function montarResultado(leitura) {
  const abas = leitura.abas.map((aba) => ({
    nome: aba.nome,
    indice: aba.indice,
    estado: aba.estado,
    intervaloUtilizado: aba.intervaloUtilizado,
    merges: aba.merges,
    celulasPersistidas: aba.celulas.length,
    ...aba.resumo,
  }));

  return {
    versaoImportador: VERSAO_IMPORTADOR,
    abas,
    totais: {
      abas: abas.length,
      celulasPersistidas: abas.reduce((t, a) => t + a.celulasPersistidas, 0),
      comValor: abas.reduce((t, a) => t + a.comValor, 0),
      comFormula: abas.reduce((t, a) => t + a.comFormula, 0),
      mescladas: abas.reduce((t, a) => t + a.mescladas, 0),
      vaziasComEstilo: abas.reduce((t, a) => t + a.vaziasComEstilo, 0),
      ignoradasVaziasSemEstilo: abas.reduce((t, a) => t + a.ignoradasVaziasSemEstilo, 0),
      ignoradasForaDoIntervalo: abas.reduce((t, a) => t + a.ignoradasForaDoIntervalo, 0),
    },
  };
}

function gravar(db, { nomeArquivo, sha256, leitura, versaoImportador }) {
  const info = db.prepare(SQL_INSERT_IMPORTACAO).run(nomeArquivo, sha256, versaoImportador);
  const importacaoId = Number(info.lastInsertRowid);

  const inserirCelula = db.prepare(SQL_INSERT_CELULA);

  for (const aba of leitura.abas) {
    for (const celula of aba.celulas) {
      inserirCelula.run(
        importacaoId,
        celula.aba,
        celula.endereco,
        celula.linha,
        celula.coluna,
        celula.valorBruto,
        celula.estilo === null ? null : JSON.stringify(celula.estilo),
        celula.tipoOriginal,
        celula.formula,
        celula.textoFormatado,
        JSON.stringify(celula.payloadBruto)
      );
    }
  }

  const resultado = montarResultado(leitura);
  db.prepare(SQL_CONCLUIR).run(JSON.stringify(resultado), importacaoId);

  return { importacaoId, resultado };
}

function respostaDuplicada(existente, { caminho, nomeArquivo, sha256 }) {
  let resultado = null;
  if (existente.resultado) {
    try {
      resultado = JSON.parse(existente.resultado);
    } catch {
      resultado = null;
    }
  }

  return {
    duplicada: true,
    importacaoId: existente.id,
    sha256,
    nomeArquivo,
    nomeArquivoOriginal: existente.nome_arquivo,
    caminho,
    importadoEm: existente.importado_em,
    status: existente.status,
    resultado,
  };
}

/**
 * Importa um arquivo .xlsx para a camada bruta.
 *
 * Idempotencia: a identidade e o SHA-256 do CONTEUDO. O mesmo arquivo com outro
 * nome tem o mesmo hash e nao gera uma segunda importacao. A garantia final e do
 * banco (`importacao.sha256 UNIQUE`), nao desta funcao.
 *
 * Atomicidade: `importacao` + todas as `legacy_cell` entram no mesmo
 * BEGIN IMMEDIATE / COMMIT. Qualquer erro faz ROLLBACK e nao deixa celula orfa.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} caminhoArquivo
 * @returns {Promise<object>} resumo da importacao (ou da duplicata detectada)
 */
async function importarPlanilhaLegada(db, caminhoArquivo, opcoes = {}) {
  const versaoImportador = opcoes.versaoImportador ?? VERSAO_IMPORTADOR;

  const caminho = validarCaminho(caminhoArquivo);
  const nomeArquivo = path.basename(caminho);

  exigirSchemaAtualizado(db);

  const bytes = lerBytes(caminho);
  const sha256 = calcularSha256(bytes);

  const jaImportado = buscarPorSha256(db, sha256);
  if (jaImportado !== null) {
    return respostaDuplicada(jaImportado, { caminho, nomeArquivo, sha256 });
  }

  // Leitura assincrona FORA da transacao: better-sqlite3 e sincrono e manter a
  // transacao aberta durante I/O so aumentaria o tempo de lock.
  const leitura = await lerWorkbookDeBytes(bytes);

  let gravado;
  try {
    gravado = withTransaction(db, (conexao) =>
      gravar(conexao, { nomeArquivo, sha256, leitura, versaoImportador })
    );
  } catch (error) {
    // Corrida com outra importacao do mesmo conteudo: o UNIQUE do banco decide.
    if (ehSha256Duplicado(error)) {
      const concorrente = buscarPorSha256(db, sha256);
      if (concorrente !== null) {
        return respostaDuplicada(concorrente, { caminho, nomeArquivo, sha256 });
      }
    }
    throw error;
  }

  const registro = db
    .prepare('SELECT importado_em, status FROM importacao WHERE id = ?')
    .get(gravado.importacaoId);

  return {
    duplicada: false,
    importacaoId: gravado.importacaoId,
    sha256,
    nomeArquivo,
    caminho,
    importadoEm: registro.importado_em,
    status: registro.status,
    resultado: gravado.resultado,
  };
}

module.exports = {
  importarPlanilhaLegada,
  calcularSha256,
  ImportacaoError,
  VERSAO_IMPORTADOR,
};
