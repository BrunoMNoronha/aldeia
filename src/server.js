'use strict';

const { createApp } = require('./web/app');
const { getDatabase, closeDatabase } = require('./db/connection');
const { resolveDbPath, resolvePort } = require('./config');

function start() {
  const dbPath = resolveDbPath();
  const port = resolvePort();

  // Falha cedo se o banco nao abrir.
  getDatabase();

  const server = createApp().listen(port, () => {
    console.log(`TechLab+ Aldeia (ACASA) escutando em http://localhost:${port}`);
    console.log(`banco: ${dbPath}`);
    console.log('health check: GET /health');
  });

  const shutdown = () => {
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

if (require.main === module) start();

module.exports = { start };
