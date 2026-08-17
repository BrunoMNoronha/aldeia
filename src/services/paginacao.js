'use strict';

/**
 * Configuracao de paginacao das filas operacionais.
 *
 * Por que este modulo existe (ADR-003 / PG-2B1):
 *   estes numeros nasceram em `ledger.js` e `comprovantes.js` os importava de la.
 *   Isso funcionava enquanto havia uma trilha so, mas `ledger.js` requer
 *   `../db/connection` — ou seja, `better-sqlite3`. A implementacao PostgreSQL de
 *   comprovantes importar `ledger.js` apenas para ler cinco constantes carregaria
 *   o driver SQLite inteiro para dentro da trilha PostgreSQL, que e exatamente o
 *   acoplamento que a migracao existe para desfazer.
 *
 *   A extracao e minima e deliberada: SO a configuracao de paginacao saiu.
 *   `ledger.js` continua exportando `PAGINACAO` para nao quebrar consumidor
 *   algum — o valor agora vem daqui.
 *
 * Nada aqui conhece banco, driver ou SQL.
 *
 * Paginacao por LIMIT/OFFSET, com teto: uma fila operacional e lida em pagina,
 * nunca inteira de uma vez. Sem cursor nesta fase.
 */
const PAGINACAO = Object.freeze({
  limitePadrao: 50,
  limiteMinimo: 1,
  limiteMaximo: 200,
  offsetPadrao: 0,
  offsetMinimo: 0,
});

module.exports = { PAGINACAO };
