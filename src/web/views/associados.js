'use strict';

// Views da superficie operacional de associados (F-01 / F-02).
// Funcoes puras: recebem dados ja lidos e devolvem HTML. Nao acessam banco.

const { escapeHtml, formatarCentavos, layout } = require('../html');
const { SEM_REGISTRO } = require('../../services/comprovantes');

/** Placeholder de campo ausente. NULL nao vira "" nem 0. */
const TRACO = '—';

const NOTA_CODIGO_LEGADO =
  'Código legado: valor preservado da planilha, sem interpretação. ' +
  'Não indica situação financeira nem adimplência.';

const AVISO_CODIGO_LEGADO =
  'Dado bruto do legado, sem interpretação. Não é situação financeira.';

/**
 * Texto das areas que a tela ja reserva mas que ainda nao existem no sistema.
 *
 * Diz "indisponivel", nunca "zero"/"nenhum": ausencia de integracao NAO e
 * ausencia de dado, e um "R$ 0,00" aqui seria uma afirmacao financeira falsa.
 */
const TEXTO_SECAO_RESERVADA = 'Indisponível nesta versão. Aguardando integração com o ledger.';

const NOTA_MOVIMENTOS =
  'Apenas movimentos vinculados explicitamente a este associado. ' +
  'Depósitos ainda não identificados permanecem fora deste extrato.';

/** Celula de tabela: escapa o conteudo ou marca visivelmente a ausencia. */
function celula(valor) {
  if (valor === null || valor === undefined || valor === '') {
    return `<td class="vazio">${TRACO}</td>`;
  }
  return `<td>${escapeHtml(valor)}</td>`;
}

/** Item de ficha (detalhe): mesma regra de ausencia da tabela. */
function ficha(rotulo, valor) {
  const conteudo =
    valor === null || valor === undefined || valor === ''
      ? `<span class="vazio">${TRACO}</span>`
      : escapeHtml(valor);
  return `<dt>${escapeHtml(rotulo)}</dt><dd>${conteudo}</dd>`;
}

function linhaAssociado(associado) {
  const nome = escapeHtml(associado.nome);
  return `<tr>
      ${celula(associado.legacyId)}
      <td><a href="/associados/${encodeURIComponent(associado.id)}">${nome}</a></td>
      ${celula(associado.statusCadastral)}
      ${celula(associado.legacyStatusCode)}
    </tr>`;
}

function formularioFiltros({ nome, legacyId }) {
  return `<form class="filtros" method="get" action="/associados">
      <div class="campo">
        <label for="nome">Nome</label>
        <input id="nome" name="nome" type="text" value="${escapeHtml(nome)}">
      </div>
      <div class="campo">
        <label for="legacy_id">legacy_id</label>
        <input id="legacy_id" name="legacy_id" type="text" value="${escapeHtml(legacyId)}">
      </div>
      <button type="submit">Buscar</button>
      <a href="/associados">Limpar filtros</a>
    </form>`;
}

function tabelaAssociados(itens) {
  return `<table>
      <thead>
        <tr>
          <th>legacy_id</th>
          <th>Nome</th>
          <th>Status cadastral</th>
          <th>Código legado</th>
        </tr>
      </thead>
      <tbody>
        ${itens.map(linhaAssociado).join('\n        ')}
      </tbody>
    </table>
    <p class="nota">${escapeHtml(NOTA_CODIGO_LEGADO)}</p>`;
}

/**
 * @param {object} params
 * @param {ReturnType<import('../../services/associados').listarAssociados>} params.resultado
 */
function paginaListagem({ resultado }) {
  const { itens, total, truncado, filtros } = resultado;
  const temFiltro = filtros.nome !== null || filtros.legacyId !== null;

  const corpo =
    itens.length > 0
      ? tabelaAssociados(itens)
      : `<p>${temFiltro ? 'Nenhum associado corresponde à busca.' : 'Nenhum associado cadastrado.'}</p>`;

  // O aviso de corte e obrigatorio: uma lista truncada sem aviso e lida como
  // "estes sao todos".
  const avisoCorte = truncado
    ? `<p class="aviso">Exibindo os primeiros ${total} registros. Refine a busca para ver os demais.</p>`
    : '';

  return layout({
    titulo: 'Associados',
    conteudo: `<h1>Associados</h1>
    ${formularioFiltros(filtros)}
    ${corpo}
    ${avisoCorte}`,
  });
}

function secaoReservada(titulo) {
  return `<section class="secao">
      <h2>${escapeHtml(titulo)}</h2>
      <p>${escapeHtml(TEXTO_SECAO_RESERVADA)}</p>
    </section>`;
}

/**
 * Estado de uma alocacao INATIVADA em uma linha de texto (M-09).
 *
 * A tabela de alocacoes tem uma coluna so para o registro, entao QUANDO e POR
 * QUE moram nela, rotulados. Cada parte so entra se existir no banco: nada e
 * inventado para preencher a celula. O escaping fica com quem monta o `<td>`.
 */
function textoDeInativacao({ inativadoEm, motivoInativacao }) {
  const estado = inativadoEm ? `inativada em ${inativadoEm}` : 'inativada';
  return motivoInativacao ? `${estado} — motivo: ${motivoInativacao}` : estado;
}

/**
 * Alocacoes de UM movimento (M-02). Zero, uma ou varias — a tabela existe so
 * quando ha o que mostrar, e "sem alocacao" e dito com todas as letras em vez
 * de virar uma linha zerada.
 */
function alocacoesDoMovimento(alocacoes) {
  if (alocacoes.length === 0) {
    return '<p class="sem-alocacao">Sem alocação registrada.</p>';
  }

  const linhas = alocacoes
    .map((alocacao) => {
      // M-09: alocacao inativada continua visivel, com o estado declarado —
      // QUANDO e POR QUE inclusive. Alocacao ativa nao ganha timestamp
      // inventado: a coluna diz apenas "ativa".
      const registro = alocacao.ativo ? 'ativa' : textoDeInativacao(alocacao);
      return `<tr>
              <td>${escapeHtml(alocacao.competencia.rotulo)}</td>
              <td>${escapeHtml(formatarCentavos(alocacao.valorCentavos))}</td>
              <td>${escapeHtml(registro)}</td>
            </tr>`;
    })
    .join('\n            ');

  return `<table class="alocacoes">
          <thead>
            <tr><th>Competência</th><th>Valor alocado</th><th>Registro</th></tr>
          </thead>
          <tbody>
            ${linhas}
          </tbody>
        </table>`;
}

/**
 * Estado do comprovante em PALAVRAS (M-04 / F-05).
 *
 * O rotulo e sempre textual e explicito: a leitura nao depende de cor, icone ou
 * posicao — coerente com o CSS acromatico do projeto. Cada estado do banco tem
 * um, e um so, rotulo.
 *
 * `sem_registro` tem texto PROPRIO. "Sem registro de comprovante" nao e o mesmo
 * que "Ausente": o primeiro diz que ninguem declarou nada, o segundo que alguem
 * verificou e declarou a falta. Colapsar os dois na tela seria afirmar, para o
 * operador, algo que o sistema nao sabe.
 */
const ROTULO_COMPROVANTE = Object.freeze({
  presente: 'Presente',
  ausente: 'Ausente',
  pendente: 'Pendente',
  nao_aplicavel: 'Não aplicável',
  [SEM_REGISTRO]: 'Sem registro de comprovante',
});

/**
 * Linhas de comprovante da ficha do movimento.
 *
 * A observacao aparece SEPARADA do estado, com rotulo proprio: ela e contexto
 * humano e nunca substitui a situacao oficial, que continua sendo o estado
 * estruturado exibido acima dela.
 */
function fichaComprovante(comprovante) {
  const estadoTecnico = comprovante?.estadoTecnico ?? SEM_REGISTRO;
  const rotulo = ROTULO_COMPROVANTE[estadoTecnico] ?? estadoTecnico;
  const observacao = comprovante?.observacao
    ? `
          ${ficha('Observação do comprovante', comprovante.observacao)}`
    : '';

  return `${ficha('Comprovante', rotulo)}${observacao}`;
}

/**
 * Um movimento e UM item, sempre — inclusive quando atende varias competencias.
 * `tipo`, `origem` e `estadoIdentificacao` sao impressos com o valor bruto do
 * banco: traduzi-los seria interpretar vocabulario que o baseline nao congelou.
 */
function itemMovimento(movimento) {
  const inativacao = movimento.ativo
    ? ''
    : `${ficha('Inativado em', movimento.inativadoEm)}
          ${ficha('Motivo da inativação', movimento.motivoInativacao)}`;

  return `<li class="movimento">
        <p class="movimento-cabecalho">
          <span class="movimento-data">${escapeHtml(movimento.data)}</span>
          <span class="movimento-valor">${escapeHtml(formatarCentavos(movimento.valorCentavos))}</span>
        </p>
        <dl class="ficha">
          ${ficha('Movimento', `#${movimento.id}`)}
          ${ficha('Tipo', movimento.tipo)}
          ${ficha('Origem', movimento.origem)}
          ${ficha('Estado de identificação', movimento.estadoIdentificacao)}
          ${ficha('Registro', movimento.ativo ? 'ativo' : 'inativado')}
          ${inativacao}
          ${ficha('Observação', movimento.observacao)}
          ${fichaComprovante(movimento.comprovante)}
        </dl>
        ${alocacoesDoMovimento(movimento.alocacoes)}
      </li>`;
}

/**
 * Extrato do associado (F-02). Lista o que existe; nao soma, nao compara com
 * valor esperado e nao conclui nada sobre a situacao financeira dele.
 */
function secaoMovimentos(movimentos) {
  const corpo =
    movimentos.length === 0
      ? '<p>Nenhum movimento registrado para este associado.</p>'
      : `<ul class="movimentos">
      ${movimentos.map(itemMovimento).join('\n      ')}
    </ul>`;

  return `<section class="secao">
      <h2>Movimentos</h2>
      ${corpo}
      <p class="nota">${escapeHtml(NOTA_MOVIMENTOS)}</p>
    </section>`;
}

function paginaDetalhe({ associado, movimentos = [] }) {
  return layout({
    titulo: 'Associado',
    conteudo: `<h1>${escapeHtml(associado.nome)}</h1>
    <h2>Cadastro</h2>
    <dl class="ficha">
      ${ficha('Nome', associado.nome)}
      ${ficha('legacy_id', associado.legacyId)}
      ${ficha('Status cadastral', associado.statusCadastral)}
      ${ficha('Código legado', associado.legacyStatusCode)}
      ${ficha('Observações', associado.observacoes)}
      ${ficha('Criado em', associado.criadoEm)}
      ${ficha('Atualizado em', associado.atualizadoEm)}
    </dl>
    <p class="aviso">Código legado — ${escapeHtml(AVISO_CODIGO_LEGADO)}</p>
    ${secaoReservada('Situação financeira')}
    ${secaoReservada('Competências')}
    ${secaoMovimentos(movimentos)}
    ${secaoReservada('Pendências')}
    ${secaoReservada('Comprovantes')}
    <p class="rodape-nav"><a href="/associados">Voltar para a lista de associados</a></p>`,
  });
}

function paginaNaoEncontrado() {
  return layout({
    titulo: 'Associado não encontrado',
    conteudo: `<h1>Associado não encontrado</h1>
    <p>Nenhum associado corresponde a este endereço.</p>
    <p class="rodape-nav"><a href="/associados">Voltar para a lista de associados</a></p>`,
  });
}

/**
 * Erro tecnico nunca chega ao navegador: sem stack, sem SQL, sem caminho de
 * arquivo e sem conteudo de banco. O detalhe fica no log do servidor.
 */
function paginaErroInterno() {
  return layout({
    titulo: 'Erro interno',
    conteudo: `<h1>Erro interno</h1>
    <p>Não foi possível concluir a operação.</p>
    <p class="rodape-nav"><a href="/associados">Voltar para a lista de associados</a></p>`,
  });
}

module.exports = {
  paginaListagem,
  paginaDetalhe,
  paginaNaoEncontrado,
  paginaErroInterno,
};
