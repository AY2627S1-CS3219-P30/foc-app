// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 4.8, Claude Opus 5.5, Claude Sonnet 5, Claude Opus 5), dates:
//   2026-09-20 to 2026-10-01
// Scope: Generated the initial implementation for "scaffold the four services on a shared runtime"
//   (USR-01, USR-03, USR-08); later new features, refactoring and bug fixes.
// Author review: Patrick Thomas, Anselm Long and Jonus Ho validated correctness and the
//   implementation, and checked for fatal errors and architectural conflicts, before committing.

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createLogger, errorMessage, PinoLoggerService, startService } from '@foc/platform';
import { DB, type Database } from './db/db.js';
import { reportSeed, seedAdmins } from './admin/seed.js';

async function main(): Promise<void> {
  // Imported dynamically so a configuration error surfaces as the clean message
  // below, rather than as an uncaught exception during module resolution.
  const { env, SERVICE_NAME } = await import('./config.js');
  const { AppModule } = await import('./app.module.js');

  const logger = new PinoLoggerService(createLogger(SERVICE_NAME, env.LOG_LEVEL));
  const app = await NestFactory.create(AppModule, { logger });

  // The schema is migrated as a separate step before the service starts (a
  // one-shot `db/migrate.ts` container in compose, `npm run db:migrate` on a
  // host, or the deploy pipeline) — never at boot. The seed below still runs on
  // every boot, so it assumes migrations are already applied.
  const seeded = await seedAdmins(app.get<Database>(DB), {
    emails: env.ADMIN_SEED_EMAILS,
    password: env.ADMIN_SEED_PASSWORD,
    allowedDomains: env.ALLOWED_EMAIL_DOMAINS,
  });
  reportSeed(logger, seeded);

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
