import { getDatabase } from '../../src/db/connection';
import { verificarSaude } from '../../src/db/health';

// T-02/T-08: este handler abre SQLite via `better-sqlite3` (modulo nativo).
// O runtime Edge NAO pode executa-lo — a declaracao abaixo e obrigatoria.
export const runtime = 'nodejs';

// Health check tem que refletir o estado do banco AGORA. `force-dynamic` impede
// que o Next avalie esta rota no build e sirva um retrato congelado do momento
// em que o build rodou.
export const dynamic = 'force-dynamic';

/**
 * GET /health
 *
 * Mesmo contrato ja publicado pelo Express:
 *   200 -> { status: 'ok',   database: 'ok',   migrations: <n> }
 *   503 -> { status: 'erro', database: 'erro' }
 *
 * Nao aplica migration: subir schema e trabalho de `npm run migrate`.
 */
export async function GET() {
  const { saudavel, corpo } = verificarSaude(getDatabase);
  return Response.json(corpo, { status: saudavel ? 200 : 503 });
}
