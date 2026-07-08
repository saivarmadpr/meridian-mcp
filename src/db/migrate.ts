import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, closeDb } from './client.js';
import { logger } from '../logger.js';

// Migrations live in the top-level ./drizzle folder (copied into the image).
const MIGRATIONS_DIR = path.resolve(process.cwd(), 'drizzle');

export async function runMigrations(): Promise<void> {
  logger.info({ dir: MIGRATIONS_DIR }, 'running database migrations');
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  logger.info('migrations complete');
}

// Allow `npm run db:migrate` / `tsx src/db/migrate.ts` as a standalone command.
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  runMigrations()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'migration failed');
      process.exit(1);
    });
}
