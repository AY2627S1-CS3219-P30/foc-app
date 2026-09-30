import 'reflect-metadata';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createLogger, PgDb, PinoLoggerService, startService } from '@foc/platform';
import { DB, RAW_DB, type Database } from './db/db.js';
import { loadSeedSuppliers } from './admin/seed-data.js';
import { seedSuppliers } from './admin/seed.js';

async function main(): Promise<void> {
  // Imported dynamically so a configuration error surfaces as the clean message
  // below, rather than as an uncaught exception during module resolution.
  const { env, SERVICE_NAME } = await import('./config.js');
  const { AppModule } = await import('./app.module.js');

  const logger = new PinoLoggerService(createLogger(SERVICE_NAME, env.LOG_LEVEL));
  const app = await NestFactory.create(AppModule, { logger });

  // Schema first, then traffic: a request must never reach a database that is
  // behind. The Drizzle migrator applies any pending migrations from ./drizzle;
  // it is idempotent, so a database already brought up to date out-of-band (the
  // `npm run db:migrate` / CI-CD path) is left untouched. It runs over the pg
  // pool the RAW_DB port owns.
  const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
  await migrate(drizzle(app.get<PgDb>(RAW_DB).pool), { migrationsFolder });
  logger.log('Migrations up to date.');

  // Idempotent: safe to run on every boot, never overwrites an admin's edits.
  const suppliers = await loadSeedSuppliers();
  const seeded = await seedSuppliers(app.get<Database>(DB), suppliers);
  logger.log(
    `Supplier seed: ${seeded.created.length} created, ${seeded.skipped.length} already present.`,
  );

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
