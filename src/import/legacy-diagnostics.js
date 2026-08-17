'use strict';

// Diagnostico ESTRUTURADO do legado (Fase 1C).
//
// Entrada : `legacy_cell` de UMA importacao concluida (evidencia bruta da Fase 1A)
//           + os vinculos de `legacy_cell_link` produzidos pela Fase 1B.
// Saida   : um relatorio auditavel gravado no namespace `diagnosticoLegado` de
//           `importacao.resultado`.
//
// A pergunta que esta fase responde e APENAS:
//   "o que existe no legado, onde existe, em que formato existe e quais padroes
//    precisam de decisao antes da normalizacao?"
//
// O que este servico NAO faz — e nao deve passar a fazer sem decisao humana:
//   * criar movimento_financeiro, alocacao, competencia, ajuste ou comprovante;
//   * converter valor da planilha em centavos (T-06);
//   * usar a formula de BJ como saldo oficial;
//   * interpretar 'a', 'i', 'DESLIGADO' (C-01) nem alterar status_cadastral;
//   * atribuir significado a cor de preenchimento (C-05);
//   * transformar a coincidencia centavos <-> legacy_id em vinculo (C-02);
//   * alterar `legacy_cell.valor_bruto` ou qualquer evidencia.
//
// Toda agregacao aqui e DERIVADA e descartavel: o relatorio pode ser recalculado
// do zero a partir de `legacy_cell` a qualquer momento (M-07 / M-08 / F-07).

const { withTransaction } = require('../db/connection');

/** Identificacao da regra de diagnostico gravada no relatorio. */
const VERSAO_DIAGNOSTICO = 'legacy-diagnostico/1.0.0';

/**
 * Faixas de colunas OBSERVADAS no arquivo canonico e registradas no baseline.
 *
 * Sao evidencia do arquivo, NAO schema de banco (M-01) e NAO competencia
 * (M-10): nenhuma coluna mensal e criada a partir daqui. Servem so para
 * localizar a evidencia no relatorio e sao substituiveis por opcao.
 */
const FAIXAS_PADRAO = Object.freeze({
  cadastro: 'A:B',
  lancamentos: 'C:BH',
  totalParcialLegado: 'BJ',
  consolidado: 'BL:BN',
  nomeConsolidado: 'BL',
  situacaoLegada: 'BM',
  observacoes: 'BN',
});

/** Sub-blocos anuais observados dentro de C:BH. Rotulo descritivo, nao regra. */
const BLOCOS_ANUAIS_PADRAO = Object.freeze([
  Object.freeze({ rotulo: '2024', faixa: 'C:Y' }),
  Object.freeze({ rotulo: '2025', faixa: 'Z:AV' }),
  Object.freeze({ rotulo: '2026', faixa: 'AW:BH' }),
]);

/** Rotulos de area usados na distribuicao de tipos. */
const AREA = Object.freeze({
  CADASTRO: 'A:B',
  LANCAMENTOS: 'C:BH',
  TOTAL_PARCIAL: 'BJ',
  CONSOLIDADO: 'BL:BN',
  OUTRAS: 'outras',
});

/** Areas cujo conteudo textual entra no inventario de tokens. */
const AREAS_TEXTUAIS = Object.freeze([AREA.LANCAMENTOS, AREA.TOTAL_PARCIAL, AREA.CONSOLIDADO]);

/**
 * Codigos ESTAVEIS de ocorrencia. Sao contrato: relatorios e telas futuras
 * dependem deles. Nao renomear sem migrar o consumidor.
 */
const OCORRENCIA = Object.freeze({
  /** Texto em area de lancamento cujo significado nao esta documentado (C-03/C-04). */
  TOKEN_TEXTUAL_NAO_DOCUMENTADO: 'token_textual_nao_documentado',
  /** Texto com aparencia de data em area de lancamento. NAO e convertido em data. */
  POSSIVEL_DATA_EM_TEXTO: 'possivel_data_em_texto',
  /** Formula dentro de C:BH: o valor exibido e calculado, nao digitado. */
  FORMULA_EM_AREA_DE_LANCAMENTO: 'formula_em_area_de_lancamento',
  /** Formula em BJ. Evidencia do total parcial legado; JAMAIS saldo oficial. */
  FORMULA_TOTAL_PARCIAL_LEGADO: 'formula_total_parcial_legado',
  /** Assinatura de preenchimento sem significado confirmado (C-05). */
  PREENCHIMENTO_SEM_SIGNIFICADO_CONFIRMADO: 'preenchimento_sem_significado_confirmado',
  /** Numero que nao e representavel como decimal simples (expoente, >2 casas, negativo). */
  VALOR_NUMERICO_FORA_DO_PADRAO: 'valor_numerico_fora_do_padrao',
  /** Sufixo decimal coincide com um legacy_id conhecido. HIPOTESE, nao vinculo (C-02). */
  CENTAVOS_COINCIDEM_COM_LEGACY_ID: 'centavos_coincidem_com_legacy_id',
  /** Uma casa decimal: '40.2' pode ter sido '40,20' na planilha. Ambiguidade real. */
  CENTAVOS_AMBIGUOS_POR_ZERO_A_DIREITA: 'centavos_ambiguos_por_zero_a_direita',
  /** Codigo em BM ('a', 'i', 'DESLIGADO', ...) preservado sem interpretacao (C-01). */
  BM_CODIGO_NAO_INTERPRETADO: 'bm_codigo_nao_interpretado',
  /** Observacao em BN que exige leitura humana. Nao vira comprovante nem pendencia. */
  BN_OBSERVACAO_PARA_REVISAO: 'bn_observacao_para_revisao',
  /** Conteudo fora das linhas de associado: notas, saldos, pendentes, casos especiais. */
  REGISTRO_FORA_DA_TABELA_PRINCIPAL: 'registro_fora_da_tabela_principal',
  /** Celula com erro do Excel (#REF!, #DIV/0!, ...). */
  CELULA_DE_ERRO: 'celula_de_erro',
  /** Tipo original que o vocabulario do importador nao reconhece. */
  TIPO_ORIGINAL_DESCONHECIDO: 'tipo_original_desconhecido',
});

/** Categorias diagnosticas das ocorrencias. */
const CATEGORIA = Object.freeze({
  ESTRUTURA: 'estrutura',
  AMBIGUIDADE: 'ambiguidade',
  HIPOTESE: 'hipotese',
  ESTILO: 'estilo',
  FORA_DA_TABELA: 'fora_da_tabela',
});

/** Marcador unico usado no relatorio para tudo que continua TO CONFIRM. */
const SIGNIFICADO_NAO_CONFIRMADO = 'significado_nao_confirmado';
const HIPOTESE_NAO_APLICADA = 'hipotese_nao_aplicada';

/**
 * O baseline registra, como EVIDENCIA TEXTUAL, o uso de tres cores no controle
 * manual. Isso e citado no relatorio e nada mais: nao vira pagamento, status,
 * ledger ou competencia. Cores fora desta lista nao recebem nome inventado —
 * so o ARGB observado.
 */
const EVIDENCIA_TEXTUAL_BASELINE = Object.freeze({
  FFFFFF00: 'baseline (evidencia textual): amarelo = controle da gestao anterior',
  FFFF0000: 'baseline (evidencia textual): vermelho = controle da gestao atual',
  FFFFFFFF: 'baseline (evidencia textual): branco = ausencia de pagamento',
});

/** Pontos que continuam TO CONFIRM e que este diagnostico NAO resolve. */
const NAO_INTERPRETADO = Object.freeze([
  "significado de 'a' e 'i' em BM",
  'regra dos centavos como possivel identificador',
  'valor da contribuicao mensal e vigencias',
  "significado de 'c', 'f15', 'LG', 'TLA', 'TMC', 'TRA'",
  'significado de cores nao documentadas',
  'politica definitiva de comprovantes',
  'politica de transferencias/titularidade',
]);

/** Tipos de `legacy_cell.tipo_original` que carregam texto. */
const TIPOS_TEXTUAIS = Object.freeze(['texto', 'texto_compartilhado', 'rich_text']);

/** Tipos sem conteudo proprio. */
const TIPOS_SEM_CONTEUDO = Object.freeze(['vazio', 'merge']);

/** Limites de amostragem. O relatorio agrega o repetitivo e amostra o resto. */
const LIMITES_PADRAO = Object.freeze({
  amostrasPorGrupo: 3,
  ocorrenciasPorCodigo: 25,
  valoresTextuaisListados: 200,
  valoresNumericosListados: 40,
  formulasListadas: 60,
  linhasForaDaTabelaListadas: 60,
  sufixosListados: 60,
});

const SQL_IMPORTACAO = `
  SELECT id, nome_arquivo, sha256, status, resultado FROM importacao WHERE id = ?
`;

const SQL_CELULAS = `
  SELECT id, aba, endereco, linha, coluna, valor_bruto, estilo,
         tipo_original, formula, texto_formatado, valor_json
    FROM legacy_cell
   WHERE importacao_id = ?
   ORDER BY aba, linha, coluna
`;

/** Linhas que a Fase 1B reconheceu como linhas de associado nesta importacao. */
const SQL_LINHAS_DE_ASSOCIADO = `
  SELECT DISTINCT c.aba, c.linha, l.entidade_id AS associado_id
    FROM legacy_cell_link l
    JOIN legacy_cell c ON c.id = l.legacy_cell_id
   WHERE l.entidade_tipo = 'associado' AND c.importacao_id = ?
`;

const SQL_ASSOCIADOS_DA_IMPORTACAO = `
  SELECT DISTINCT a.id, a.legacy_id, a.nome
    FROM legacy_cell_link l
    JOIN legacy_cell c ON c.id = l.legacy_cell_id
    JOIN associado a ON a.id = l.entidade_id
   WHERE l.entidade_tipo = 'associado' AND c.importacao_id = ?
`;

class DiagnosticoError extends Error {
  constructor(message, codigo, options) {
    super(message, options);
    this.name = 'DiagnosticoError';
    this.codigo = codigo;
  }
}

// ---------------------------------------------------------------------------
// utilitarios de coluna
//
// Deliberadamente locais: este servico le SOMENTE o banco e nao deve carregar o
// leitor de .xlsx (nem a dependencia do ExcelJS) so para converter uma letra.
// ---------------------------------------------------------------------------

/** 1 -> 'A', 27 -> 'AA'. */
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

/** 'A' -> 1, 'AA' -> 27. */
function letraParaColuna(letra) {
  let total = 0;
  for (const caractere of String(letra).toUpperCase()) {
    const valor = caractere.charCodeAt(0) - 64;
    if (valor < 1 || valor > 26) {
      throw new DiagnosticoError(`faixa de coluna invalida: ${letra}`, 'faixa_invalida');
    }
    total = total * 26 + valor;
  }
  return total;
}

/** 'C:BH' -> { inicio: 3, fim: 60 }. Aceita tambem uma coluna unica ('BJ'). */
function interpretarFaixa(faixa) {
  const partes = String(faixa).split(':');
  const inicio = letraParaColuna(partes[0]);
  const fim = partes.length > 1 ? letraParaColuna(partes[1]) : inicio;
  return { inicio, fim };
}

function dentroDaFaixa(coluna, faixa) {
  return coluna >= faixa.inicio && coluna <= faixa.fim;
}

// ---------------------------------------------------------------------------
// utilitarios gerais
// ---------------------------------------------------------------------------

function parseJsonSeguro(texto) {
  if (typeof texto !== 'string' || texto === '') return null;
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

function temConteudo(celula) {
  return !TIPOS_SEM_CONTEUDO.includes(celula.tipo_original);
}

/** Trilha minima de auditoria de uma celula (M-07). */
function referenciaCelula(celula) {
  return {
    legacyCellId: celula.id,
    aba: celula.aba,
    endereco: celula.endereco,
    linha: celula.linha,
    coluna: celula.coluna,
    tipoOriginal: celula.tipo_original,
    valorBruto: celula.valor_bruto,
    formula: celula.formula ?? null,
  };
}

/** Ordena por frequencia desc e depois pela chave, sem depender de locale. */
function ordenarPorFrequencia(a, b) {
  if (b.ocorrencias !== a.ocorrencias) return b.ocorrencias - a.ocorrencias;
  if (a.chaveOrdenacao === b.chaveOrdenacao) return 0;
  return a.chaveOrdenacao < b.chaveOrdenacao ? -1 : 1;
}

/** Recorta uma lista ja ordenada e informa explicitamente o que ficou de fora. */
function recortar(lista, limite) {
  if (lista.length <= limite) return { itens: lista, total: lista.length, truncado: false };
  return { itens: lista.slice(0, limite), total: lista.length, truncado: true };
}

function incrementar(contagem, chave) {
  contagem[chave] = (contagem[chave] ?? 0) + 1;
}

// ---------------------------------------------------------------------------
// coletor de ocorrencias
// ---------------------------------------------------------------------------

/**
 * Ocorrencia e para ANOMALIA, AMBIGUIDADE e padrao que exige decisao — nunca
 * uma linha por celula normal. O total detectado e sempre contado; apenas as
 * primeiras N de cada codigo sao materializadas no relatorio.
 */
function criarColetor(importacaoId, limitePorCodigo) {
  const ocorrencias = [];
  const detectadas = {};

  return {
    registrar(codigo, categoria, celula, descricao, extra = {}) {
      incrementar(detectadas, codigo);
      if (detectadas[codigo] > limitePorCodigo) return;

      ocorrencias.push({
        codigo,
        categoria,
        importacaoId,
        ...referenciaCelula(celula),
        descricao,
        ...extra,
      });
    },
    resultado() {
      const truncadas = {};
      for (const [codigo, total] of Object.entries(detectadas)) {
        if (total > limitePorCodigo) truncadas[codigo] = { detectadas: total, listadas: limitePorCodigo };
      }
      return { ocorrencias, ocorrenciasPorCodigo: detectadas, ocorrenciasTruncadas: truncadas };
    },
  };
}

// ---------------------------------------------------------------------------
// classificacao de area
// ---------------------------------------------------------------------------

function montarFaixas(opcoes) {
  const faixas = { ...FAIXAS_PADRAO, ...(opcoes.faixas ?? {}) };
  const blocos = opcoes.blocosAnuais ?? BLOCOS_ANUAIS_PADRAO;

  return {
    rotulos: faixas,
    cadastro: interpretarFaixa(faixas.cadastro),
    lancamentos: interpretarFaixa(faixas.lancamentos),
    totalParcial: interpretarFaixa(faixas.totalParcialLegado),
    consolidado: interpretarFaixa(faixas.consolidado),
    nomeConsolidado: interpretarFaixa(faixas.nomeConsolidado),
    situacaoLegada: interpretarFaixa(faixas.situacaoLegada),
    observacoes: interpretarFaixa(faixas.observacoes),
    blocosAnuais: blocos.map((bloco) => ({ ...bloco, ...interpretarFaixa(bloco.faixa) })),
  };
}

function areaDaColuna(coluna, faixas) {
  if (coluna === null || coluna === undefined) return AREA.OUTRAS;
  if (dentroDaFaixa(coluna, faixas.cadastro)) return AREA.CADASTRO;
  if (dentroDaFaixa(coluna, faixas.lancamentos)) return AREA.LANCAMENTOS;
  if (dentroDaFaixa(coluna, faixas.totalParcial)) return AREA.TOTAL_PARCIAL;
  if (dentroDaFaixa(coluna, faixas.consolidado)) return AREA.CONSOLIDADO;
  return AREA.OUTRAS;
}

function blocoAnualDaColuna(coluna, faixas) {
  const bloco = faixas.blocosAnuais.find((candidato) => dentroDaFaixa(coluna, candidato));
  return bloco === undefined ? null : bloco.rotulo;
}

// ---------------------------------------------------------------------------
// 8.2 distribuicao de tipos
// ---------------------------------------------------------------------------

function distribuicaoDeTipos(celulas, faixas) {
  const total = {};
  const porArea = {};
  const porBlocoAnual = {};

  for (const rotulo of Object.values(AREA)) porArea[rotulo] = {};
  for (const bloco of faixas.blocosAnuais) porBlocoAnual[`${bloco.rotulo} (${bloco.faixa})`] = {};

  for (const celula of celulas) {
    const tipo = celula.tipo_original ?? 'nao_registrado';
    incrementar(total, tipo);
    incrementar(porArea[areaDaColuna(celula.coluna, faixas)], tipo);

    const bloco = blocoAnualDaColuna(celula.coluna, faixas);
    if (bloco !== null) {
      const chaveBloco = faixas.blocosAnuais.find((item) => item.rotulo === bloco);
      incrementar(porBlocoAnual[`${chaveBloco.rotulo} (${chaveBloco.faixa})`], tipo);
    }
  }

  return {
    // Contagem de celulas PERSISTIDAS por tipo original. Nenhuma semantica
    // financeira e derivada do tipo (M-01).
    total,
    porArea,
    porBlocoAnual,
  };
}

// ---------------------------------------------------------------------------
// 8.3 inventario de textos / tokens
// ---------------------------------------------------------------------------

const PADRAO_POSSIVEL_DATA = /^\s*\d{1,2}\s*[/.-]\s*\d{1,2}(\s*[/.-]\s*\d{2,4})?\s*$/;

function ehTextual(celula) {
  return TIPOS_TEXTUAIS.includes(celula.tipo_original) && typeof celula.valor_bruto === 'string';
}

function inventarioDeTextos(celulas, faixas, limites, coletor) {
  const grupos = new Map();
  let totalCelulas = 0;

  for (const celula of celulas) {
    if (!ehTextual(celula)) continue;
    const area = areaDaColuna(celula.coluna, faixas);
    if (!AREAS_TEXTUAIS.includes(area)) continue;

    totalCelulas += 1;

    // O agrupamento usa uma CHAVE derivada (trim + case-fold). Ela existe apenas
    // para juntar 'ok', 'OK ' e ' Ok' na mesma linha do relatorio; o valor bruto
    // original continua sendo o dado e nunca e substituido (M-08).
    const valorBruto = celula.valor_bruto;
    const chaveAgrupamento = valorBruto.trim().toLowerCase();
    const chave = `${chaveAgrupamento} ${valorBruto}`;

    let grupo = grupos.get(chave);
    if (grupo === undefined) {
      grupo = {
        valorBruto,
        chaveAgrupamento,
        comprimento: valorBruto.length,
        ocorrencias: 0,
        areas: {},
        amostras: [],
        chaveOrdenacao: chave,
      };
      grupos.set(chave, grupo);
    }

    grupo.ocorrencias += 1;
    incrementar(grupo.areas, area);
    if (grupo.amostras.length < limites.amostrasPorGrupo) {
      grupo.amostras.push(referenciaCelula(celula));
    }

    // Ocorrencias: apenas texto em area de LANCAMENTO, onde a presenca de texto
    // no lugar de um valor e o que exige decisao. BM/BN tem secao propria.
    if (area === AREA.LANCAMENTOS) {
      if (PADRAO_POSSIVEL_DATA.test(valorBruto)) {
        coletor.registrar(
          OCORRENCIA.POSSIVEL_DATA_EM_TEXTO,
          CATEGORIA.AMBIGUIDADE,
          celula,
          'texto com aparencia de data em area de lancamento; nenhuma conversao foi feita'
        );
      } else {
        coletor.registrar(
          OCORRENCIA.TOKEN_TEXTUAL_NAO_DOCUMENTADO,
          CATEGORIA.AMBIGUIDADE,
          celula,
          'texto em area de lancamento sem significado documentado',
          { chaveAgrupamento, significado: SIGNIFICADO_NAO_CONFIRMADO }
        );
      }
    }
  }

  const lista = [...grupos.values()].sort(ordenarPorFrequencia);
  const curtos = lista.filter((grupo) => grupo.chaveAgrupamento.length > 0 && grupo.chaveAgrupamento.length <= 5);

  const recorte = recortar(lista, limites.valoresTextuaisListados);
  const recorteCurtos = recortar(curtos, limites.valoresTextuaisListados);

  return {
    areasConsideradas: AREAS_TEXTUAIS,
    celulasTextuais: totalCelulas,
    valoresDistintos: lista.length,
    chaveAgrupamento: 'trim() + minusculas — SOMENTE para agrupar; valor_bruto preservado',
    significado: SIGNIFICADO_NAO_CONFIRMADO,
    valores: recorte.itens.map(({ chaveOrdenacao, ...grupo }) => grupo),
    valoresTruncados: recorte.truncado,
    tokensCurtos: {
      criterio: 'chave de agrupamento com ate 5 caracteres',
      distintos: curtos.length,
      valores: recorteCurtos.itens.map(({ chaveOrdenacao, ...grupo }) => grupo),
      truncado: recorteCurtos.truncado,
    },
  };
}

// ---------------------------------------------------------------------------
// 8.4 formulas
// ---------------------------------------------------------------------------

/**
 * Padrao de formula: referencias de celula viram '#REF' e numeros literais viram
 * '#N'. E uma chave de AGRUPAMENTO diagnostico — a formula original continua
 * inteira em `formulas[].formula` e em `legacy_cell.formula`.
 */
function padraoDeFormula(formula) {
  return formula
    .replace(/\$?[A-Z]{1,3}\$?\d+/g, '#REF')
    .replace(/\d+(\.\d+)?/g, '#N');
}

function inventarioDeFormulas(celulas, faixas, limites, coletor) {
  const porFormula = new Map();
  const porPadrao = new Map();
  const porColuna = {};
  let total = 0;

  for (const celula of celulas) {
    if (celula.tipo_original !== 'formula') continue;
    total += 1;

    const formula = celula.formula ?? '(formula nao registrada)';
    const padrao = padraoDeFormula(formula);
    const letra = colunaParaLetra(celula.coluna ?? 0) || '?';
    incrementar(porColuna, letra);

    let grupo = porFormula.get(formula);
    if (grupo === undefined) {
      grupo = { formula, padrao, ocorrencias: 0, colunas: {}, amostras: [], chaveOrdenacao: formula };
      porFormula.set(formula, grupo);
    }
    grupo.ocorrencias += 1;
    incrementar(grupo.colunas, letra);
    if (grupo.amostras.length < limites.amostrasPorGrupo) grupo.amostras.push(referenciaCelula(celula));

    let agrupado = porPadrao.get(padrao);
    if (agrupado === undefined) {
      agrupado = {
        padrao,
        ocorrencias: 0,
        formulasDistintas: new Set(),
        colunas: {},
        // O padrao carrega amostra propria: quando ha centenas de formulas todas
        // distintas, a lista por texto exato e truncada e o padrao passa a ser a
        // unica via de rastreio ate a celula.
        amostras: [],
        chaveOrdenacao: padrao,
      };
      porPadrao.set(padrao, agrupado);
    }
    agrupado.ocorrencias += 1;
    agrupado.formulasDistintas.add(formula);
    incrementar(agrupado.colunas, letra);
    if (agrupado.amostras.length < limites.amostrasPorGrupo) agrupado.amostras.push(referenciaCelula(celula));

    const area = areaDaColuna(celula.coluna, faixas);
    if (area === AREA.TOTAL_PARCIAL) {
      coletor.registrar(
        OCORRENCIA.FORMULA_TOTAL_PARCIAL_LEGADO,
        CATEGORIA.ESTRUTURA,
        celula,
        'total parcial calculado pela planilha legada; evidencia apenas, nunca saldo oficial',
        { usoPermitido: 'evidencia', saldoOficial: false }
      );
    } else if (area === AREA.LANCAMENTOS) {
      coletor.registrar(
        OCORRENCIA.FORMULA_EM_AREA_DE_LANCAMENTO,
        CATEGORIA.ESTRUTURA,
        celula,
        'valor da area de lancamento e resultado de formula, nao um valor digitado'
      );
    }
  }

  const listaFormulas = [...porFormula.values()].sort(ordenarPorFrequencia);
  const listaPadroes = [...porPadrao.values()]
    .map((item) => ({ ...item, formulasDistintas: item.formulasDistintas.size }))
    .sort(ordenarPorFrequencia);

  const recorteFormulas = recortar(listaFormulas, limites.formulasListadas);
  const recortePadroes = recortar(listaPadroes, limites.formulasListadas);

  return {
    total,
    distintas: listaFormulas.length,
    padroesDistintos: listaPadroes.length,
    porColuna,
    formulas: recorteFormulas.itens.map(({ chaveOrdenacao, ...grupo }) => grupo),
    formulasTruncadas: recorteFormulas.truncado,
    padroes: recortePadroes.itens.map(({ chaveOrdenacao, ...grupo }) => grupo),
    padroesTruncados: recortePadroes.truncado,
    observacao: 'resultado de formula legada e evidencia; nunca saldo, pagamento ou movimento',
  };
}

// ---------------------------------------------------------------------------
// 8.5 estilos / preenchimentos
// ---------------------------------------------------------------------------

/** Cor como o arquivo a entregou. Tema/indexada ficam explicitos, sem inventar ARGB. */
function descreverCor(cor) {
  if (cor === null || typeof cor !== 'object') return null;
  if (typeof cor.argb === 'string') return cor.argb.toUpperCase();
  if (typeof cor.theme === 'number') {
    return `theme:${cor.theme}${typeof cor.tint === 'number' ? `+tint:${cor.tint}` : ''}`;
  }
  if (typeof cor.indexed === 'number') return `indexed:${cor.indexed}`;
  return null;
}

function assinaturaDePreenchimento(fill) {
  if (fill === null || typeof fill !== 'object') return null;

  const tipo = fill.type ?? null;
  if (tipo === 'gradient') {
    const paradas = Array.isArray(fill.stops)
      ? fill.stops.map((stop) => descreverCor(stop.color) ?? '?').join(',')
      : '';
    return {
      tipo,
      pattern: null,
      fgArgb: null,
      bgArgb: null,
      paradasGradiente: paradas,
      chave: `gradient|${paradas}`,
    };
  }

  const pattern = fill.pattern ?? null;
  if (pattern === null || pattern === 'none') return null;

  const fgArgb = descreverCor(fill.fgColor);
  const bgArgb = descreverCor(fill.bgColor);

  return {
    tipo,
    pattern,
    fgArgb,
    bgArgb,
    paradasGradiente: null,
    chave: `${tipo ?? '?'}|${pattern}|${fgArgb ?? '-'}|${bgArgb ?? '-'}`,
  };
}

function inventarioDeEstilos(celulas, limites, coletor) {
  const assinaturas = new Map();
  let comEstilo = 0;
  let comPreenchimento = 0;

  for (const celula of celulas) {
    const estilo = parseJsonSeguro(celula.estilo);
    if (estilo === null) continue;
    comEstilo += 1;

    const assinatura = assinaturaDePreenchimento(estilo.fill ?? null);
    if (assinatura === null) continue;
    comPreenchimento += 1;

    let grupo = assinaturas.get(assinatura.chave);
    if (grupo === undefined) {
      const notaBaseline =
        assinatura.fgArgb !== null ? EVIDENCIA_TEXTUAL_BASELINE[assinatura.fgArgb] ?? null : null;

      grupo = {
        assinatura: assinatura.chave,
        tipoFill: assinatura.tipo,
        pattern: assinatura.pattern,
        fgArgb: assinatura.fgArgb,
        bgArgb: assinatura.bgArgb,
        paradasGradiente: assinatura.paradasGradiente,
        // C-05 continua TO CONFIRM para TODA cor, inclusive as tres citadas pelo
        // baseline: a citacao e evidencia textual, nao regra aplicada.
        significado: SIGNIFICADO_NAO_CONFIRMADO,
        notaBaseline,
        ocorrencias: 0,
        amostras: [],
        chaveOrdenacao: assinatura.chave,
      };
      assinaturas.set(assinatura.chave, grupo);
    }

    grupo.ocorrencias += 1;
    if (grupo.amostras.length < limites.amostrasPorGrupo) grupo.amostras.push(referenciaCelula(celula));

    if (grupo.notaBaseline === null) {
      coletor.registrar(
        OCORRENCIA.PREENCHIMENTO_SEM_SIGNIFICADO_CONFIRMADO,
        CATEGORIA.ESTILO,
        celula,
        'preenchimento sem legenda conhecida; nenhum significado de dominio foi atribuido',
        { assinatura: assinatura.chave, significado: SIGNIFICADO_NAO_CONFIRMADO }
      );
    }
  }

  const lista = [...assinaturas.values()].sort(ordenarPorFrequencia);
  const recorte = recortar(lista, limites.valoresTextuaisListados);

  return {
    celulasComEstilo: comEstilo,
    celulasComPreenchimento: comPreenchimento,
    assinaturasDistintas: lista.length,
    assinaturas: recorte.itens.map(({ chaveOrdenacao, ...grupo }) => grupo),
    truncado: recorte.truncado,
    observacao:
      'cor NAO e pagamento, status nem ledger; as notas do baseline sao evidencia textual (C-05)',
  };
}

// ---------------------------------------------------------------------------
// 8.6 valores numericos
// ---------------------------------------------------------------------------

/**
 * Decimal SEGURO a partir da representacao textual original.
 *
 * `legacy_cell.valor_bruto` guarda a forma decimal exata que o arquivo entregou.
 * Contar casas decimais em cima do texto evita usar ponto flutuante binario como
 * base de decisao monetaria (T-06).
 */
const PADRAO_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

function analisarDecimal(valorBruto) {
  if (typeof valorBruto !== 'string') return null;
  const encontrado = PADRAO_DECIMAL.exec(valorBruto.trim());
  if (encontrado === null) return null;

  const fracao = encontrado[3] ?? '';
  return {
    negativo: encontrado[1] === '-',
    parteInteira: encontrado[2],
    fracao,
    casasDecimais: fracao.length,
    inteiro: fracao === '',
  };
}

function inventarioNumerico(celulas, faixas, limites, coletor) {
  const grupos = new Map();
  const casasDecimais = {};
  const porArea = {};
  let quantidade = 0;
  let inteiros = 0;
  let comCentavos = 0;
  let foraDoPadrao = 0;
  let emResultadoDeFormula = 0;
  let minimo = null;
  let maximo = null;

  for (const celula of celulas) {
    if (celula.tipo_original === 'formula') {
      const payload = parseJsonSeguro(celula.valor_json);
      if (payload !== null && payload.resultadoTipo === 'number') emResultadoDeFormula += 1;
      continue;
    }
    if (celula.tipo_original !== 'numero') continue;

    quantidade += 1;
    incrementar(porArea, areaDaColuna(celula.coluna, faixas));

    const decimal = analisarDecimal(celula.valor_bruto);
    if (decimal === null) {
      foraDoPadrao += 1;
      incrementar(casasDecimais, 'nao_analisavel');
      coletor.registrar(
        OCORRENCIA.VALOR_NUMERICO_FORA_DO_PADRAO,
        CATEGORIA.AMBIGUIDADE,
        celula,
        'numero cuja representacao original nao e um decimal simples (notacao cientifica ou similar)'
      );
    } else {
      incrementar(casasDecimais, String(decimal.casasDecimais));
      if (decimal.inteiro) inteiros += 1;
      if (decimal.casasDecimais === 2) comCentavos += 1;
      if (decimal.negativo || decimal.casasDecimais > 2) {
        foraDoPadrao += 1;
        coletor.registrar(
          OCORRENCIA.VALOR_NUMERICO_FORA_DO_PADRAO,
          CATEGORIA.AMBIGUIDADE,
          celula,
          decimal.negativo
            ? 'valor numerico negativo na planilha; natureza (estorno? correcao?) nao decidida'
            : `valor com ${decimal.casasDecimais} casas decimais; nao e um valor monetario de 2 casas`
        );
      }
    }

    // Comparacao de ordem apenas para localizar minimo/maximo; o dado reportado
    // continua sendo a representacao textual original.
    const payload = parseJsonSeguro(celula.valor_json);
    const numero = payload !== null && typeof payload.valor === 'number' ? payload.valor : null;
    if (numero !== null) {
      if (minimo === null || numero < minimo.numero) minimo = { numero, celula };
      if (maximo === null || numero > maximo.numero) maximo = { numero, celula };
    }

    const chave = celula.valor_bruto ?? '(nulo)';
    let grupo = grupos.get(chave);
    if (grupo === undefined) {
      grupo = { valorBruto: chave, ocorrencias: 0, amostras: [], chaveOrdenacao: chave };
      grupos.set(chave, grupo);
    }
    grupo.ocorrencias += 1;
    if (grupo.amostras.length < limites.amostrasPorGrupo) grupo.amostras.push(referenciaCelula(celula));
  }

  const lista = [...grupos.values()].sort(ordenarPorFrequencia);
  const recorte = recortar(lista, limites.valoresNumericosListados);

  return {
    representacao: 'decimal textual de legacy_cell.valor_bruto (sem aritmetica de ponto flutuante)',
    quantidade,
    valoresDistintos: lista.length,
    inteiros,
    comDuasCasasDecimais: comCentavos,
    foraDoPadraoDecimal: foraDoPadrao,
    porCasasDecimais: casasDecimais,
    porArea,
    numerosEmResultadoDeFormula: emResultadoDeFormula,
    minimo: minimo === null ? null : { valorBruto: minimo.celula.valor_bruto, ...referenciaCelula(minimo.celula) },
    maximo: maximo === null ? null : { valorBruto: maximo.celula.valor_bruto, ...referenciaCelula(maximo.celula) },
    maisFrequentes: recorte.itens.map(({ chaveOrdenacao, ...grupo }) => grupo),
    truncado: recorte.truncado,
    observacao: 'nenhum valor foi convertido em centavos, pagamento, movimento ou saldo (T-06)',
  };
}

// ---------------------------------------------------------------------------
// 8.7 padrao de centavos versus legacy_id
// ---------------------------------------------------------------------------

/**
 * Mede — e SOMENTE mede — a hipotese do baseline de que certos centavos
 * coincidem com o ID do associado.
 *
 * Nada e removido, alterado ou vinculado: e estatistica sobre evidencia.
 *
 * Ambiguidade real e reportada: a planilha guarda numeros em binario, entao
 * '40,20' e '40,2' sao o MESMO numero e chegam como '40.2'. Por isso a
 * coincidencia e medida em duas leituras distintas e separadas.
 */
/** Sufixos de duas casas que podem coincidir com um ID: '01'..'99'. */
const SUFIXOS_POSSIVEIS = 99;

/**
 * Quantos dos 99 sufixos possiveis tem um legacy_id correspondente.
 *
 * Se TODOS tiverem, a coincidencia acontece por construcao e nao distingue nada:
 * medir isso evita que uma taxa de acerto de 100% seja lida como confirmacao da
 * hipotese. E o proprio teste dizendo o quanto ele vale.
 */
function poderDiscriminante(consideradas) {
  const alcancados = new Set();
  for (const legacyId of consideradas) {
    const numero = Number.parseInt(legacyId, 10);
    if (Number.isInteger(numero) && numero >= 1 && numero <= SUFIXOS_POSSIVEIS) alcancados.add(numero);
  }

  const todos = alcancados.size === SUFIXOS_POSSIVEIS;

  return {
    sufixosPossiveis: SUFIXOS_POSSIVEIS,
    sufixosAlcancadosPorAlgumLegacyId: alcancados.size,
    todosOsSufixosSaoAlcancaveis: todos,
    observacao: todos
      ? 'os legacy_ids conhecidos cobrem TODOS os sufixos de 01 a 99: qualquer valor com ' +
        'centavos coincide por construcao e a coincidencia NAO e evidencia de vinculo'
      : 'nem todo sufixo possui legacy_id correspondente; a coincidencia e mensuravel, ' +
        'mas continua sendo apenas evidencia',
  };
}

function analiseDeCentavos(celulas, faixas, legacyIds, limites, coletor) {
  const consideradas = new Set(legacyIds);
  const avaliada = consideradas.size > 0;

  const sufixos = new Map();
  let duasCasas = 0;
  let umaCasa = 0;
  let coincidenciasExatas = 0;
  let coincidenciasComZeroAdicionado = 0;
  let semCoincidencia = 0;
  const amostras = [];

  for (const celula of celulas) {
    if (celula.tipo_original !== 'numero') continue;
    const area = areaDaColuna(celula.coluna, faixas);
    if (area !== AREA.LANCAMENTOS) continue;

    const decimal = analisarDecimal(celula.valor_bruto);
    if (decimal === null || decimal.casasDecimais === 0 || decimal.casasDecimais > 2) continue;

    const exata = decimal.casasDecimais === 2;
    if (exata) duasCasas += 1;
    else umaCasa += 1;

    // '02' -> 2 ; '2' (uma casa) -> '20' -> 20.
    const fracaoNormalizada = decimal.fracao.padEnd(2, '0');
    const sufixo = Number.parseInt(fracaoNormalizada, 10);
    const legacyId = String(sufixo);
    const coincide = sufixo > 0 && consideradas.has(legacyId);

    if (coincide) {
      if (exata) coincidenciasExatas += 1;
      else coincidenciasComZeroAdicionado += 1;
    } else {
      semCoincidencia += 1;
    }

    let grupo = sufixos.get(fracaoNormalizada);
    if (grupo === undefined) {
      grupo = {
        sufixo: fracaoNormalizada,
        legacyIdEquivalente: legacyId,
        coincide,
        leituraExata: 0,
        leituraComZeroAdicionado: 0,
        ocorrencias: 0,
        amostras: [],
        chaveOrdenacao: fracaoNormalizada,
      };
      sufixos.set(fracaoNormalizada, grupo);
    }
    grupo.ocorrencias += 1;
    if (exata) grupo.leituraExata += 1;
    else grupo.leituraComZeroAdicionado += 1;
    if (grupo.amostras.length < limites.amostrasPorGrupo) grupo.amostras.push(referenciaCelula(celula));

    if (coincide && amostras.length < limites.valoresNumericosListados) {
      amostras.push({ ...referenciaCelula(celula), sufixo: fracaoNormalizada, legacyIdEquivalente: legacyId });
    }

    if (coincide) {
      coletor.registrar(
        OCORRENCIA.CENTAVOS_COINCIDEM_COM_LEGACY_ID,
        CATEGORIA.HIPOTESE,
        celula,
        'sufixo decimal coincide com um legacy_id conhecido; coincidencia estatistica, nenhum vinculo criado',
        { sufixo: fracaoNormalizada, legacyIdEquivalente: legacyId, hipotese: HIPOTESE_NAO_APLICADA }
      );
    }
    if (!exata) {
      coletor.registrar(
        OCORRENCIA.CENTAVOS_AMBIGUOS_POR_ZERO_A_DIREITA,
        CATEGORIA.AMBIGUIDADE,
        celula,
        `uma casa decimal: o arquivo nao distingue '${celula.valor_bruto}' de '${celula.valor_bruto}0'`,
        { sufixoSeExata: decimal.fracao, sufixoSeZeroAdicionado: fracaoNormalizada }
      );
    }
  }

  const lista = [...sufixos.values()].sort(ordenarPorFrequencia);
  const recorte = recortar(lista, limites.sufixosListados);

  return {
    hipotese: HIPOTESE_NAO_APLICADA,
    avaliada,
    motivoNaoAvaliada: avaliada
      ? null
      : 'nenhum associado materializado para esta importacao; sem legacy_id de referencia',
    area: faixas.rotulos.lancamentos,
    legacyIdsConsiderados: consideradas.size,
    poderDiscriminante: poderDiscriminante(consideradas),
    valoresComDuasCasasDecimais: duasCasas,
    valoresComUmaCasaDecimal: umaCasa,
    coincidencias: {
      leituraExataDuasCasas: coincidenciasExatas,
      leituraComZeroAdicionado: coincidenciasComZeroAdicionado,
      total: coincidenciasExatas + coincidenciasComZeroAdicionado,
    },
    semCoincidencia,
    distribuicaoPorSufixo: recorte.itens.map(({ chaveOrdenacao, ...grupo }) => grupo),
    distribuicaoTruncada: recorte.truncado,
    amostras,
    observacao:
      'PROIBIDO derivar identidade daqui: nenhum centavo foi removido, nenhum deposito vinculado, ' +
      'nenhum pagamento ou alocacao gerado (C-02 continua TO CONFIRM)',
  };
}

// ---------------------------------------------------------------------------
// 8.8 / 8.9 colunas BM e BN
// ---------------------------------------------------------------------------

function celulasDaFaixa(celulas, faixa) {
  return celulas.filter((celula) => celula.coluna !== null && dentroDaFaixa(celula.coluna, faixa));
}

function agruparValores(celulas, limites) {
  const grupos = new Map();

  for (const celula of celulas) {
    const valorBruto = celula.valor_bruto;
    const chave = `${celula.tipo_original} ${valorBruto}`;

    let grupo = grupos.get(chave);
    if (grupo === undefined) {
      grupo = {
        valorBruto,
        tipoOriginal: celula.tipo_original,
        chaveAgrupamento: typeof valorBruto === 'string' ? valorBruto.trim().toLowerCase() : null,
        ocorrencias: 0,
        amostras: [],
        chaveOrdenacao: chave,
      };
      grupos.set(chave, grupo);
    }
    grupo.ocorrencias += 1;
    if (grupo.amostras.length < limites.amostrasPorGrupo) grupo.amostras.push(referenciaCelula(celula));
  }

  return [...grupos.values()].sort(ordenarPorFrequencia);
}

/**
 * Separa o que esta em uma linha de associado do que nao esta.
 *
 * Uma coluna como BM tem 140 codigos de associado E o rotulo do cabecalho; sem
 * essa separacao os dois viram o mesmo numero e o relatorio mente por omissao.
 */
function proveniencia(celulasDoBloco, linhasDeAssociado) {
  let emLinhaDeAssociado = 0;
  for (const celula of celulasDoBloco) {
    if (linhasDeAssociado.has(`${celula.aba} ${celula.linha}`)) emLinhaDeAssociado += 1;
  }
  return {
    emLinhaDeAssociado,
    foraDeLinhaDeAssociado: celulasDoBloco.length - emLinhaDeAssociado,
  };
}

function inventarioBM(celulas, faixas, limites, linhasDeAssociado, coletor) {
  const doBloco = celulasDaFaixa(celulas, faixas.situacaoLegada).filter(temConteudo);
  const lista = agruparValores(doBloco, limites);
  const totalPorValor = new Map(
    lista.map((grupo) => [`${grupo.tipoOriginal} ${grupo.valorBruto}`, grupo.ocorrencias])
  );

  // Uma ocorrencia por VALOR DISTINTO, ancorada na primeira celula que o exibe:
  // o que exige decisao e o codigo, nao cada uma das linhas que o repete.
  const jaRegistrados = new Set();
  for (const celula of doBloco) {
    const chave = `${celula.tipo_original} ${celula.valor_bruto}`;
    if (jaRegistrados.has(chave)) continue;
    jaRegistrados.add(chave);

    coletor.registrar(
      OCORRENCIA.BM_CODIGO_NAO_INTERPRETADO,
      CATEGORIA.AMBIGUIDADE,
      celula,
      `codigo legado em ${faixas.rotulos.situacaoLegada} preservado sem interpretacao`,
      { ocorrenciasDoValor: totalPorValor.get(chave) ?? 1, significado: SIGNIFICADO_NAO_CONFIRMADO }
    );
  }

  const recorte = recortar(lista, limites.valoresTextuaisListados);

  return {
    coluna: faixas.rotulos.situacaoLegada,
    preenchidas: doBloco.length,
    ...proveniencia(doBloco, linhasDeAssociado),
    valoresDistintos: lista.length,
    valores: recorte.itens.map(({ chaveOrdenacao, ...grupo }) => grupo),
    truncado: recorte.truncado,
    interpretacao: 'nao_aplicada',
    observacao:
      "'a' / 'i' / 'DESLIGADO' NAO viram adimplente, inadimplente, ativo, inativo nem " +
      'status_cadastral; C-01 continua TO CONFIRM',
  };
}

/** Texto que provavelmente precisa de leitura humana, nao de parser. */
function textoComplexo(valorBruto) {
  if (typeof valorBruto !== 'string') return false;
  return valorBruto.length > 40 || /[\n;]/.test(valorBruto);
}

function inventarioBN(celulas, faixas, limites, linhasDeAssociado, linhaParaAssociado, coletor) {
  const doBloco = celulasDaFaixa(celulas, faixas.observacoes).filter(temConteudo);
  const lista = agruparValores(doBloco, limites);
  const complexos = [];

  for (const celula of doBloco) {
    const associado = linhaParaAssociado.get(`${celula.aba} ${celula.linha}`) ?? null;
    const extra = {
      associado: associado === null ? null : { id: associado.id, legacyId: associado.legacy_id, nome: associado.nome },
      vinculoInequivoco: associado !== null,
      complexo: textoComplexo(celula.valor_bruto),
    };

    if (extra.complexo && complexos.length < limites.valoresTextuaisListados) {
      complexos.push({ ...referenciaCelula(celula), ...extra });
    }

    coletor.registrar(
      OCORRENCIA.BN_OBSERVACAO_PARA_REVISAO,
      CATEGORIA.AMBIGUIDADE,
      celula,
      `observacao legada em ${faixas.rotulos.observacoes}; nenhum comprovante, credito, debito ou pendencia foi criado`,
      extra
    );
  }

  const recorte = recortar(lista, limites.valoresTextuaisListados);

  return {
    coluna: faixas.rotulos.observacoes,
    preenchidas: doBloco.length,
    ...proveniencia(doBloco, linhasDeAssociado),
    valoresDistintos: lista.length,
    maisFrequentes: recorte.itens.map(({ chaveOrdenacao, ...grupo }) => grupo),
    truncado: recorte.truncado,
    textosComplexos: complexos,
    observacao:
      'M-04 / F-07: comprovante e conceito independente e sua politica continua TO CONFIRM; ' +
      'nada aqui virou comprovante ou pendencia',
  };
}

function inventarioDeColuna(celulas, faixa, rotulo, limites) {
  const doBloco = celulasDaFaixa(celulas, faixa);
  const comConteudo = doBloco.filter(temConteudo);
  const tipos = {};
  for (const celula of doBloco) incrementar(tipos, celula.tipo_original ?? 'nao_registrado');

  const lista = agruparValores(comConteudo, limites);
  const recorte = recortar(lista, limites.valoresTextuaisListados);

  return {
    coluna: rotulo,
    celulas: doBloco.length,
    preenchidas: comConteudo.length,
    porTipo: tipos,
    valoresDistintos: lista.length,
    valores: recorte.itens.map(({ chaveOrdenacao, ...grupo }) => grupo),
    truncado: recorte.truncado,
  };
}

// ---------------------------------------------------------------------------
// 8.10 registros fora da tabela principal
// ---------------------------------------------------------------------------

function registrosForaDaTabelaPrincipal(celulas, linhasDeAssociado, limites, coletor) {
  const conhecidas = linhasDeAssociado.size > 0;
  const porLinha = new Map();
  /** Ancora da ocorrencia: primeira celula com conteudo da linha. Nao e serializada. */
  const ancoras = new Map();

  for (const celula of celulas) {
    if (!temConteudo(celula)) continue;
    const chave = `${celula.aba} ${celula.linha}`;
    if (linhasDeAssociado.has(chave)) continue;

    let linha = porLinha.get(chave);
    if (linha === undefined) {
      linha = {
        aba: celula.aba,
        linha: celula.linha,
        celulasComConteudo: 0,
        enderecos: [],
        celulas: [],
        chaveOrdenacao: chave,
      };
      porLinha.set(chave, linha);
      ancoras.set(chave, celula);
    }
    linha.celulasComConteudo += 1;
    linha.enderecos.push(celula.endereco);
    if (linha.celulas.length < limites.amostrasPorGrupo) linha.celulas.push(referenciaCelula(celula));
  }

  const lista = [...porLinha.values()].sort((a, b) => {
    if (a.aba !== b.aba) return a.aba < b.aba ? -1 : 1;
    return (a.linha ?? 0) - (b.linha ?? 0);
  });

  for (const linha of lista) {
    coletor.registrar(
      OCORRENCIA.REGISTRO_FORA_DA_TABELA_PRINCIPAL,
      CATEGORIA.FORA_DA_TABELA,
      ancoras.get(linha.chaveOrdenacao),
      'conteudo fora das linhas de associado (nota, saldo, pendencia, caso especial); nada foi convertido',
      { enderecos: linha.enderecos.slice(0, 20), celulasComConteudo: linha.celulasComConteudo }
    );
  }

  const recorte = recortar(lista, limites.linhasForaDaTabelaListadas);

  return {
    linhasDeAssociadoConhecidas: conhecidas,
    origemDasLinhasDeAssociado: conhecidas
      ? 'legacy_cell_link (papel legacy_id / nome) da Fase 1B'
      : 'nenhuma: a Fase 1B nao materializou associados para esta importacao',
    linhasDeAssociado: linhasDeAssociado.size,
    linhasForaDaTabela: lista.length,
    celulasForaDaTabela: lista.reduce((total, linha) => total + linha.celulasComConteudo, 0),
    linhas: recorte.itens.map(({ chaveOrdenacao, enderecos, ...linha }) => ({
      ...linha,
      enderecos: enderecos.slice(0, 20),
      enderecosTruncados: enderecos.length > 20,
    })),
    truncado: recorte.truncado,
    observacao:
      'nenhum destes registros virou associado, movimento, credito, debito ou comprovante',
  };
}

// ---------------------------------------------------------------------------
// varredura de anomalias simples
// ---------------------------------------------------------------------------

function registrarAnomaliasDeTipo(celulas, coletor) {
  for (const celula of celulas) {
    if (celula.tipo_original === 'erro') {
      coletor.registrar(
        OCORRENCIA.CELULA_DE_ERRO,
        CATEGORIA.ESTRUTURA,
        celula,
        'celula com erro do Excel preservado como evidencia'
      );
    } else if (typeof celula.tipo_original === 'string' && celula.tipo_original.startsWith('desconhecido')) {
      coletor.registrar(
        OCORRENCIA.TIPO_ORIGINAL_DESCONHECIDO,
        CATEGORIA.ESTRUTURA,
        celula,
        'tipo original fora do vocabulario conhecido do importador'
      );
    }
  }
}

// ---------------------------------------------------------------------------
// carga e persistencia
// ---------------------------------------------------------------------------

function normalizarId(valor) {
  const numero = typeof valor === 'string' ? Number.parseInt(valor, 10) : valor;
  if (!Number.isSafeInteger(numero) || numero <= 0) {
    throw new DiagnosticoError(`importacao_id invalido: ${String(valor)}`, 'importacao_id_invalido');
  }
  return numero;
}

function carregarImportacao(db, importacaoId) {
  const importacao = db.prepare(SQL_IMPORTACAO).get(importacaoId);

  if (importacao === undefined) {
    throw new DiagnosticoError(`importacao ${importacaoId} nao encontrada`, 'importacao_inexistente');
  }
  if (importacao.status !== 'concluida') {
    throw new DiagnosticoError(
      `importacao ${importacaoId} esta com status "${importacao.status}"; ` +
        'somente uma importacao concluida pode ser diagnosticada',
      'importacao_nao_concluida'
    );
  }

  return importacao;
}

/** Le o `resultado` existente. Conteudo nao estruturado aborta em vez de ser destruido. */
function lerResultadoExistente(importacao) {
  if (importacao.resultado === null || importacao.resultado === '') return {};

  const atual = parseJsonSeguro(importacao.resultado);
  if (atual === null || typeof atual !== 'object' || Array.isArray(atual)) {
    throw new DiagnosticoError(
      `importacao.resultado da importacao ${importacao.id} nao e um objeto JSON; ` +
        'o diagnostico foi abortado para nao sobrescrever o conteudo existente',
      'resultado_nao_estruturado'
    );
  }

  return atual;
}

/** Metadados de aba conhecidos pela Fase 1A, quando disponiveis. */
function intervalosConhecidos(resultadoExistente) {
  const abas = Array.isArray(resultadoExistente.abas) ? resultadoExistente.abas : [];
  const mapa = new Map();
  for (const aba of abas) {
    if (aba && typeof aba.nome === 'string') mapa.set(aba.nome, aba.intervaloUtilizado ?? null);
  }
  return mapa;
}

function resumoDasAbas(celulas, intervalos) {
  const abas = new Map();

  for (const celula of celulas) {
    let aba = abas.get(celula.aba);
    if (aba === undefined) {
      aba = {
        nome: celula.aba,
        intervaloUtilizado: intervalos.get(celula.aba) ?? null,
        celulas: 0,
        primeiraLinha: celula.linha,
        ultimaLinha: celula.linha,
      };
      abas.set(celula.aba, aba);
    }
    aba.celulas += 1;
    if (celula.linha !== null) {
      if (aba.primeiraLinha === null || celula.linha < aba.primeiraLinha) aba.primeiraLinha = celula.linha;
      if (aba.ultimaLinha === null || celula.linha > aba.ultimaLinha) aba.ultimaLinha = celula.linha;
    }
  }

  return [...abas.values()];
}

/**
 * Diagnostica o conteudo legado de uma importacao concluida.
 *
 * Somente-leitura sobre a evidencia: a UNICA escrita e o namespace
 * `diagnosticoLegado` de `importacao.resultado`, feita em uma transacao (T-07).
 * Reexecutar recalcula e substitui esse namespace sem criar nenhuma entidade.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number|string} importacaoId
 * @param {{limites?: object, faixas?: object, blocosAnuais?: Array<object>,
 *          persistir?: boolean}} [opcoes]
 * @returns {object} relatorio estruturado do diagnostico
 */
function diagnosticarLegado(db, importacaoId, opcoes = {}) {
  const id = normalizarId(importacaoId);
  const limites = { ...LIMITES_PADRAO, ...(opcoes.limites ?? {}) };
  const faixas = montarFaixas(opcoes);
  const persistir = opcoes.persistir !== false;

  const importacao = carregarImportacao(db, id);
  const resultadoExistente = lerResultadoExistente(importacao);

  const celulas = db.prepare(SQL_CELULAS).all(id);

  const linhasDeAssociado = new Set();
  const linhaParaAssociado = new Map();
  const associadosPorId = new Map(
    db.prepare(SQL_ASSOCIADOS_DA_IMPORTACAO).all(id).map((associado) => [associado.id, associado])
  );
  for (const registro of db.prepare(SQL_LINHAS_DE_ASSOCIADO).all(id)) {
    const chave = `${registro.aba} ${registro.linha}`;
    linhasDeAssociado.add(chave);
    const associado = associadosPorId.get(registro.associado_id);
    if (associado !== undefined && !linhaParaAssociado.has(chave)) linhaParaAssociado.set(chave, associado);
  }

  const legacyIds = [...associadosPorId.values()]
    .map((associado) => associado.legacy_id)
    .filter((legacyId) => typeof legacyId === 'string' && legacyId !== '');

  const coletor = criarColetor(id, limites.ocorrenciasPorCodigo);

  const relatorioParcial = {
    versaoDiagnostico: VERSAO_DIAGNOSTICO,
    importacaoId: id,
    nomeArquivo: importacao.nome_arquivo,
    sha256: importacao.sha256,
    abas: resumoDasAbas(celulas, intervalosConhecidos(resultadoExistente)),
    faixasDeEvidencia: {
      ...faixas.rotulos,
      blocosAnuais: faixas.blocosAnuais.map((bloco) => ({ rotulo: bloco.rotulo, faixa: bloco.faixa })),
      observacao:
        'faixas OBSERVADAS no arquivo canonico; evidencia de leitura, nunca schema de banco ' +
        '(M-01) nem competencia (M-10)',
    },
    // O relatorio nao carimba horario proprio: ele e uma funcao determinística de
    // `legacy_cell`, e um timestamp o tornaria diferente a cada recalculo sem
    // que nenhuma evidencia tivesse mudado. A ancora temporal e
    // `importacao.importado_em`.
    determinismo: 'relatorio derivado exclusivamente de legacy_cell; recalculavel a qualquer momento',
    totais: {
      legacyCells: celulas.length,
      comConteudo: celulas.filter(temConteudo).length,
      associadosVinculados: associadosPorId.size,
    },
  };

  registrarAnomaliasDeTipo(celulas, coletor);

  const relatorio = {
    ...relatorioParcial,
    distribuicaoTipos: distribuicaoDeTipos(celulas, faixas),
    textos: inventarioDeTextos(celulas, faixas, limites, coletor),
    formulas: inventarioDeFormulas(celulas, faixas, limites, coletor),
    estilos: inventarioDeEstilos(celulas, limites, coletor),
    numeros: inventarioNumerico(celulas, faixas, limites, coletor),
    centavosVersusLegacyId: analiseDeCentavos(celulas, faixas, legacyIds, limites, coletor),
    totalParcialLegado: {
      ...inventarioDeColuna(celulas, faixas.totalParcial, faixas.rotulos.totalParcialLegado, limites),
      usoPermitido: 'evidencia',
      saldoOficial: false,
      observacao: 'BJ NAO e fonte de verdade: nenhum saldo, movimento ou situacao financeira sai daqui',
    },
    nomeConsolidado: {
      ...inventarioDeColuna(celulas, faixas.nomeConsolidado, faixas.rotulos.nomeConsolidado, limites),
      observacao: 'BL nao substitui o nome cadastral vindo de B (Fase 1B)',
    },
    situacaoLegada: inventarioBM(celulas, faixas, limites, linhasDeAssociado, coletor),
    observacoesLegadas: inventarioBN(
      celulas,
      faixas,
      limites,
      linhasDeAssociado,
      linhaParaAssociado,
      coletor
    ),
    foraDaTabelaPrincipal: registrosForaDaTabelaPrincipal(celulas, linhasDeAssociado, limites, coletor),
    naoInterpretado: {
      itens: NAO_INTERPRETADO,
      situacao: 'to_confirm',
      observacao: 'nenhum item acima gerou movimento, competencia, pagamento, status ou correcao automatica',
    },
    ...coletor.resultado(),
    limites,
  };

  if (!persistir) return relatorio;

  return withTransaction(db, (conexao) => {
    // Releitura DENTRO da transacao: o resultado pode ter mudado entre a leitura
    // inicial e o commit. Os namespaces anteriores (Fase 1A, associados) sao
    // preservados integralmente; so `diagnosticoLegado` e escrito.
    const atual = lerResultadoExistente(carregarImportacao(conexao, id));
    const resultado = { ...atual, diagnosticoLegado: relatorio };

    conexao
      .prepare('UPDATE importacao SET resultado = ? WHERE id = ?')
      .run(JSON.stringify(resultado), id);

    return relatorio;
  });
}

module.exports = {
  diagnosticarLegado,
  DiagnosticoError,
  OCORRENCIA,
  CATEGORIA,
  VERSAO_DIAGNOSTICO,
  FAIXAS_PADRAO,
  BLOCOS_ANUAIS_PADRAO,
  AREA,
  SIGNIFICADO_NAO_CONFIRMADO,
  HIPOTESE_NAO_APLICADA,
  colunaParaLetra,
  letraParaColuna,
};
