import { createServer } from 'node:http';
import { config } from './config.js';
import { logger } from './logger.js';
import { runMigrations } from './db/migrate.js';
import { seed } from './db/seed.js';
import { buildApp } from './http/app.js';
import { closeDb } from './db/client.js';

async function main(): Promise<void> {
  await runMigrations();
  if (config.SEED_ON_BOOT) {
    await seed();
  }

  const app = buildApp();
  const server = createServer(app);

  server.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, publicUrl: config.PUBLIC_URL, issuer: config.ISSUER, resource: config.RESOURCE_URL },
      'Meridian Bank MCP server listening',
    );
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      void closeDb().finally(() => process.exit(0));
    });
    // Force-exit if graceful shutdown stalls.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'fatal boot error');
  process.exit(1);
});
