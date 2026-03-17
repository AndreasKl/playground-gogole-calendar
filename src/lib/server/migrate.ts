// Standalone migration runner: node --experimental-strip-types src/lib/server/migrate.ts
// Note: run from project root so that the DATABASE_URL env var and paths resolve correctly.
import { runMigrations } from './db.js';

await runMigrations();
console.log('[db] migrations complete');
process.exit(0);
