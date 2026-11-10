// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 4.8, Claude Opus 5.5, Claude Opus 5), dates: 2026-09-20 to
//   2026-10-01
// Scope: Generated the initial implementation for "scaffold the four services on a shared runtime"
//   (SUP-01); later new features, refactoring and bug fixes.
// Author review: Patrick Thomas and Jonus Ho verified correctness, tested the change, and checked
//   for fatal errors and conflicts with our architecture before committing.

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createLogger, errorMessage, PinoLoggerService, startService } from '@foc/platform';
import { DB, type Database } from './db/db.js';
import { loadSeedSuppliers } from './admin/seed-data.js';
import { seedSuppliers } from './admin/seed.js';

async function main(): Promise<void> {
  // Imported dynamically so a configuration error surfaces as the clean message
  // below, rather than as an uncaught exception during module resolution.
  const { env, SERVICE_NAME } = await import('./config.js');
  const { AppModule } = await import('./app.module.js');

  const logger = new PinoLoggerService(createLogger(SERVICE_NAME, env.LOG_LEVEL));
  const app = await NestFactory.create(AppModule, { logger });

  // The schema is migrated as a separate step before the service starts (a
  // one-shot `db/migrate.ts` container in compose, `npm run db:migrate` on a
  // host, or the deploy pipeline) — never at boot.
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
  console.error(errorMessage(err));
  process.exit(1);
});
