'use strict';

// Renderizacao HTML server-side sem template engine (ADR: nenhuma dependencia
// nova para a primeira superficie operacional).
//
// Regra unica e inegociavel desta camada: TODO texto que nao foi escrito aqui
// dentro passa por `escapeHtml` antes de entrar no documento. Nome vindo da
// planilha, observacao, codigo legado e query string sao conteudo NAO CONFIAVEL.
//
// O escaping acontece so na SAIDA: o dado persistido nunca e sanitizado, porque
// alterar o legado para caber numa tela seria perda silenciosa de informacao.

const MAPA_ESCAPE = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/**
 * Escapa `&`, `<`, `>`, `"` e `'` para uso em texto e em valor de atributo.
 * `null`/`undefined` viram string vazia — quem quiser um placeholder visivel
 * decide isso na view, nao aqui.
 */
function escapeHtml(valor) {
  if (valor === null || valor === undefined) return '';
  return String(valor).replace(/[&<>"']/g, (caractere) => MAPA_ESCAPE[caractere]);
}

/**
 * Centavos inteiros -> texto em reais, SO para exibicao (T-06).
 *
 * O calculo e feito sobre a representacao decimal do proprio inteiro: nao ha
 * divisao, nao ha ponto flutuante e nada aqui volta para o dominio. O valor de
 * verdade continua sendo o inteiro em centavos.
 *
 * Um valor nao inteiro e um defeito de dados, nao um numero a ser arredondado:
 * lancar e preferivel a imprimir um valor monetario inventado.
 */
function formatarCentavos(centavos) {
  if (!Number.isSafeInteger(centavos)) {
    throw new TypeError(`valor monetario deve ser um inteiro em centavos (recebido: ${centavos})`);
  }

  const sinal = centavos < 0 ? '-' : '';
  const digitos = String(Math.abs(centavos)).padStart(3, '0');
  const reais = digitos.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

  return `${sinal}R$ ${reais},${digitos.slice(-2)}`;
}

/**
 * CSS minimo e deliberadamente acromatico.
 *
 * Nenhuma cor deriva de status cadastral ou de codigo legado: verde/vermelho/
 * amarelo comunicariam adimplencia, e essa leitura nao esta autorizada (C-05
 * segue TO CONFIRM). Hierarquia visual e feita com peso, tamanho e espaco.
 */
const CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #1c1c1c;
    background: #ffffff;
  }
  .topo {
    border-bottom: 1px solid #d4d4d4;
    padding: 12px 24px;
    background: #f5f5f5;
  }
  .marca { margin: 0; font-size: 14px; letter-spacing: .04em; text-transform: uppercase; }
  main { padding: 24px; max-width: 1100px; }
  h1 { font-size: 24px; margin: 0 0 16px; }
  h2 { font-size: 17px; margin: 28px 0 8px; }
  a { color: #1c1c1c; }
  .filtros {
    display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-end;
    padding: 16px; border: 1px solid #d4d4d4; margin-bottom: 20px;
  }
  .campo { display: flex; flex-direction: column; gap: 4px; }
  .campo label { font-size: 13px; }
  .campo input { padding: 6px 8px; border: 1px solid #9e9e9e; font: inherit; min-width: 220px; }
  button { padding: 7px 16px; border: 1px solid #1c1c1c; background: #1c1c1c; color: #fff; font: inherit; cursor: pointer; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e0e0e0; vertical-align: top; }
  th { font-size: 13px; text-transform: uppercase; letter-spacing: .03em; background: #fafafa; }
  td.vazio { color: #767676; }
  .nota { font-size: 13px; color: #4a4a4a; margin: 8px 0 0; }
  .aviso { font-size: 13px; color: #4a4a4a; border-left: 3px solid #9e9e9e; padding: 6px 10px; margin: 8px 0 0; }
  .secao { border: 1px solid #d4d4d4; padding: 12px 16px; margin-bottom: 12px; }
  .secao h2 { margin-top: 0; }
  .secao p { margin: 0; color: #4a4a4a; }
  dl.ficha { display: grid; grid-template-columns: max-content 1fr; gap: 6px 20px; margin: 0; }
  dl.ficha dt { font-size: 13px; color: #4a4a4a; }
  dl.ficha dd { margin: 0; }
  .rodape-nav { margin-top: 24px; font-size: 14px; }
  ul.movimentos { list-style: none; margin: 0; padding: 0; }
  li.movimento { border: 1px solid #e0e0e0; padding: 12px 14px; margin-bottom: 10px; }
  .movimento-cabecalho { display: flex; gap: 16px; align-items: baseline; margin: 0 0 8px; }
  .movimento-valor { font-size: 18px; font-weight: 600; }
  .movimento-data { font-size: 14px; color: #4a4a4a; }
  table.alocacoes { margin-top: 10px; }
  table.alocacoes th, table.alocacoes td { padding: 5px 8px; font-size: 14px; }
  .sem-alocacao { margin: 10px 0 0; font-size: 14px; color: #4a4a4a; }
`;

/**
 * Documento completo. O cabecalho institucional e do layout para que toda
 * pagina — inclusive erro e "nao encontrado" — se identifique.
 */
function layout({ titulo, conteudo }) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(titulo)} · ACASA</title>
<style>${CSS}</style>
</head>
<body>
<header class="topo"><p class="marca">ACASA · Controle de Pagamentos</p></header>
<main>
${conteudo}
</main>
</body>
</html>
`;
}

module.exports = { escapeHtml, formatarCentavos, layout };
