import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createLogger, PinoLoggerService, startService } from '@foc/platform';
import { DB, type Db } from './db/db.js';
import { runMigrations } from './db/migrate.js';

async function main(): Promise<void> {
  // Imported dynamically so a configuration error surfaces as the clean message
  // below, rather than as an uncaught exception during module resolution.
  const { env, SERVICE_NAME } = await import('./config.js');
  const { AppModule } = await import('./app.module.js');

  const logger = new PinoLoggerService(createLogger(SERVICE_NAME, env.LOG_LEVEL));
  const app = await NestFactory.create(AppModule, { logger });

  // Schema first, then traffic: a request must never reach a database that is behind.
  const applied = await runMigrations(app.get<Db>(DB));
  if (applied.length > 0) logger.log(`Applied migrations: ${applied.join(', ')}`);

  await startService(app, {
    serviceName: SERVICE_NAME,
    port: env.PORT,
    corsOrigins: env.CORS_ORIGINS,
  });
}

main().catch((err: unknown) => {
  // Configuration errors happen before a logger exists, so this must use console.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
