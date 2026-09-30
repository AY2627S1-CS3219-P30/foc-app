import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createLogger, PinoLoggerService, runMigrations, startService } from '@foc/platform';
import { DB, type Db } from './db/db.js';
import { migrations } from './db/migrations.js';
import { seedAdmins } from './admin/seed.js';

async function main(): Promise<void> {
  // Imported dynamically so a configuration error surfaces as the clean message
  // below, rather than as an uncaught exception during module resolution.
  const { env, SERVICE_NAME } = await import('./config.js');
  const { AppModule } = await import('./app.module.js');

  const logger = new PinoLoggerService(createLogger(SERVICE_NAME, env.LOG_LEVEL));
  const app = await NestFactory.create(AppModule, { logger });

  // Schema first, then traffic: a request must never reach a database that is behind.
  const applied = await runMigrations(app.get<Db>(DB), migrations);
  if (applied.length > 0) logger.log(`Applied migrations: ${applied.join(', ')}`);

  const seeded = await seedAdmins(app.get<Db>(DB), {
    emails: env.ADMIN_SEED_EMAILS,
    password: env.ADMIN_SEED_PASSWORD,
    allowedDomains: env.ALLOWED_EMAIL_DOMAINS,
  });
  // Counts only: an email address is personal data and never goes to a log (US-NFR4.1.1).
  // Who was bootstrapped is in the audit trail (ADMIN_BOOTSTRAP rows), which is where an
  // operator looks it up.
  if (seeded.created.length > 0) logger.log(`Seeded administrators: ${seeded.created.length}`);
  if (seeded.skipped.length > 0) {
    logger.warn(
      `Seed skipped ${seeded.skipped.length} address(es): an account already exists and is never promoted`,
    );
  }
  if (!env.ADMIN_SEED_EMAILS?.length) logger.warn('No seeded administrators configured.');

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
