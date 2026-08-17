'use strict';

// Leitura BRUTA de um workbook .xlsx.
//
// Responsabilidade unica: transformar o arquivo em uma lista de celulas com a
// maior fidelidade possivel ao original. Este modulo NAO conhece o banco e NAO
// interpreta nada:
//
//   * nao converte valor em centavos (T-06);
//   * nao decide o significado de 'a', 'i', 'c20', 'f15', 'LG' (C-01..C-04);
//   * nao atribui significado a cor de preenchimento (C-05);
//   * nao usa resultado de formula legada como saldo.
//
// Tudo o que chega aqui sai como evidencia: tipo, valor, formula, texto
// formatado e estilo.

const fs = require('node:fs');
const ExcelJS = require('exceljs');

/**
 * Vocabulario estavel do importador para o tipo declarado pela biblioteca.
 * Mantido explicito para que o banco nao dependa dos numeros do ExcelJS.
 */
const TIPO_CELULA = Object.freeze({
  [ExcelJS.ValueType.Null]: 'vazio',
  [ExcelJS.ValueType.Merge]: 'merge',
  [ExcelJS.ValueType.Number]: 'numero',
  [ExcelJS.ValueType.String]: 'texto',
  [ExcelJS.ValueType.SharedString]: 'texto_compartilhado',
  [ExcelJS.ValueType.Date]: 'data',
  [ExcelJS.ValueType.Boolean]: 'booleano',
  [ExcelJS.ValueType.Formula]: 'formula',
  [ExcelJS.ValueType.Hyperlink]: 'hyperlink',
  [ExcelJS.ValueType.RichText]: 'rich_text',
  [ExcelJS.ValueType.Error]: 'erro',
});

const LADOS_BORDA = Object.freeze(['top', 'left', 'bottom', 'right', 'diagonal']);

class LeituraWorkbookError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'LeituraWorkbookError';
    this.codigo = 'workbook_invalido';
  }
}

/** 1 -> 'A', 27 -> 'AA'. Usado para descrever o intervalo utilizado da aba. */
function colunaParaLetra(coluna) {
  let restante = coluna;
  let letra = '';
  while (restante > 0) {
    const resto = (restante - 1) % 26;
    letra = String.fromCharCode(65 + resto) + letra;
    restante = Math.floor((restante - 1) / 26);
  }
  return letra;
}

/**
 * Estilo que constitui EVIDENCIA de preenchimento intencional.
 *
 * Serve apenas para decidir se vale a pena gravar uma celula VAZIA: uma planilha
 * tem dezenas de milhares de quadrados vazios com estilo default, e nenhum deles
 * e informacao. Celula visualmente marcada (cor, borda, formato, enfase) e.
 *
 * Isto NAO interpreta a cor (C-05) — apenas reconhece que ha algo a preservar.
 */
function estiloRelevante(estilo) {
  if (estilo === null || typeof estilo !== 'object') return false;

  const { fill, border, font, numFmt } = estilo;

  if (fill && (fill.type === 'gradient' || (fill.pattern && fill.pattern !== 'none'))) return true;
  if (border && LADOS_BORDA.some((lado) => border[lado] && border[lado].style)) return true;
  if (font && (font.bold || font.italic || font.underline || font.strike)) return true;
  if (numFmt) return true;

  return false;
}

function temConteudo(estilo) {
  return estilo !== null && typeof estilo === 'object' && Object.keys(estilo).length > 0;
}

/**
 * Representacao textual fiel do valor bruto (coluna `legacy_cell.valor_bruto`).
 * Nunca normaliza: '40,02' continua '40,02' e 40.02 vira exatamente '40.02'.
 */
function comoTexto(valor) {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'string') return valor;
  if (typeof valor === 'number' || typeof valor === 'boolean' || typeof valor === 'bigint') {
    return String(valor);
  }
  if (valor instanceof Date) return valor.toISOString();

  if (typeof valor === 'object') {
    if (Array.isArray(valor.richText)) return valor.richText.map((parte) => parte.text ?? '').join('');
    if (valor.error !== undefined) return String(valor.error);
    if (valor.text !== undefined) return comoTexto(valor.text);
  }

  return JSON.stringify(valor);
}

/** Nome do tipo JavaScript do resultado cacheado de uma formula. */
function tipoJs(valor) {
  if (valor === null) return 'null';
  if (valor === undefined) return 'ausente';
  if (valor instanceof Date) return 'date';
  if (Array.isArray(valor)) return 'array';
  return typeof valor;
}

/**
 * Extrai a evidencia bruta de uma celula.
 *
 * @returns {{tipo: string, valorBruto: string|null, formula: string|null,
 *            textoFormatado: string|null, payload: object}}
 */
function extrairCelula(cell) {
  const tipo = TIPO_CELULA[cell.type] ?? `desconhecido_${cell.type}`;

  if (cell.type === ExcelJS.ValueType.Null) {
    return { tipo, valorBruto: null, formula: null, textoFormatado: null, payload: { tipo } };
  }

  // Celula coberta por um merge. O conteudo pertence a celula mestre; duplicar
  // o valor aqui inventaria um dado que a planilha nao tem. Guardamos o vinculo.
  if (cell.type === ExcelJS.ValueType.Merge) {
    const master = cell.master && cell.master.address ? cell.master.address : null;
    return { tipo, valorBruto: null, formula: null, textoFormatado: null, payload: { tipo, master } };
  }

  if (cell.type === ExcelJS.ValueType.Formula) {
    const valor = cell.value;
    const formula = cell.formula ?? null;
    const resultado = valor && typeof valor === 'object' ? valor.result : undefined;

    return {
      tipo,
      // Cache do Excel, preservado como evidencia. NAO e saldo oficial.
      valorBruto: comoTexto(resultado),
      formula,
      textoFormatado: cell.text === undefined ? null : cell.text,
      payload: {
        tipo,
        formula,
        formulaCompartilhada:
          valor && typeof valor === 'object' && valor.sharedFormula ? valor.sharedFormula : null,
        resultado: resultado === undefined ? null : resultado,
        resultadoTipo: tipoJs(resultado),
      },
    };
  }

  return {
    tipo,
    valorBruto: comoTexto(cell.value),
    formula: null,
    textoFormatado: cell.text === undefined ? null : cell.text,
    payload: { tipo, valor: cell.value === undefined ? null : cell.value },
  };
}

function lerAba(worksheet, indice) {
  const dimensoes = worksheet.dimensions ? worksheet.dimensions.model : null;
  const ultimaLinha = dimensoes ? dimensoes.bottom : 0;
  const ultimaColuna = dimensoes ? dimensoes.right : 0;

  const celulas = [];
  const resumo = {
    comValor: 0,
    comFormula: 0,
    mescladas: 0,
    vaziasComEstilo: 0,
    // Explicitamente contadas: nada e descartado em silencio (M-08 / F-07).
    ignoradasVaziasSemEstilo: 0,
    ignoradasForaDoIntervalo: 0,
  };

  worksheet.eachRow({ includeEmpty: true }, (row) => {
    row.eachCell({ includeEmpty: true }, (cell) => {
      const estilo = temConteudo(cell.style) ? cell.style : null;
      const vazia = cell.type === ExcelJS.ValueType.Null;

      if (vazia) {
        if (!estiloRelevante(estilo)) {
          resumo.ignoradasVaziasSemEstilo += 1;
          return;
        }
        // Fora do intervalo utilizado, estilo de coluna/linha inteira e
        // formatacao de fundo do arquivo, nao marcacao de um dado.
        if (cell.row > ultimaLinha || cell.col > ultimaColuna) {
          resumo.ignoradasForaDoIntervalo += 1;
          return;
        }
        resumo.vaziasComEstilo += 1;
      } else if (cell.type === ExcelJS.ValueType.Merge) {
        resumo.mescladas += 1;
      } else {
        resumo.comValor += 1;
        if (cell.type === ExcelJS.ValueType.Formula) resumo.comFormula += 1;
      }

      const extraido = extrairCelula(cell);

      celulas.push({
        aba: worksheet.name,
        endereco: cell.address,
        linha: cell.row,
        coluna: cell.col,
        tipoOriginal: extraido.tipo,
        valorBruto: extraido.valorBruto,
        formula: extraido.formula,
        textoFormatado: extraido.textoFormatado,
        payloadBruto: extraido.payload,
        estilo,
      });
    });
  });

  return {
    nome: worksheet.name,
    indice,
    estado: worksheet.state ?? 'visible',
    intervaloUtilizado: dimensoes
      ? `${colunaParaLetra(dimensoes.left)}${dimensoes.top}:${colunaParaLetra(dimensoes.right)}${dimensoes.bottom}`
      : null,
    merges: Array.isArray(worksheet.model && worksheet.model.merges)
      ? [...worksheet.model.merges]
      : [],
    celulas,
    resumo,
  };
}

/**
 * Le um workbook ja carregado em memoria.
 *
 * Recebe os BYTES para que o hash de identidade e o conteudo lido venham
 * comprovadamente do mesmo arquivo.
 *
 * @param {Buffer} bytes
 * @returns {Promise<{abas: Array<object>, totalCelulas: number}>}
 */
async function lerWorkbookDeBytes(bytes) {
  const workbook = new ExcelJS.Workbook();

  try {
    await workbook.xlsx.load(bytes);
  } catch (error) {
    throw new LeituraWorkbookError(`nao foi possivel ler o workbook: ${error.message}`, {
      cause: error,
    });
  }

  const abas = workbook.worksheets.map((worksheet, posicao) => lerAba(worksheet, posicao + 1));

  if (abas.length === 0) {
    throw new LeituraWorkbookError('workbook nao possui nenhuma aba legivel');
  }

  return {
    abas,
    totalCelulas: abas.reduce((total, aba) => total + aba.celulas.length, 0),
  };
}

/** Conveniencia para uso fora do importador (inspecao manual). */
async function lerWorkbookDoArquivo(caminho) {
  return lerWorkbookDeBytes(fs.readFileSync(caminho));
}

module.exports = {
  lerWorkbookDeBytes,
  lerWorkbookDoArquivo,
  LeituraWorkbookError,
  TIPO_CELULA,
  estiloRelevante,
  colunaParaLetra,
};
