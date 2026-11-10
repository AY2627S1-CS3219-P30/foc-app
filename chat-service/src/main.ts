// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-30 to 2026-11-06
// Scope: Generated the initial implementation for "wire the fifth service into the stack" (NTH-11,
//   #345, #346); later new features, refactoring and bug fixes.
// Author review: Anselm Long, Jonus Ho and Zhang Yuan verified correctness, tested the change, and
//   checked for fatal errors and conflicts with our architecture before committing.

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createLogger, errorMessage, PinoLoggerService, startService } from '@foc/platform';

async function main(): Promise<void> {
  // Imported dynamically so a configuration error surfaces as the clean message
  // below, rather than as an uncaught exception during module resolution.
  const { env, SERVICE_NAME } = await import('./config.js');
  const { AppModule } = await import('./app.module.js');
  const { RetentionCleanup } = await import('./chat/retention.js');
  const { ChatWsAdapter } = await import('./chat/socket/ws-adapter.js');

  const logger = new PinoLoggerService(createLogger(SERVICE_NAME, env.LOG_LEVEL));
  const app = await NestFactory.create(AppModule, { logger });
  // The chat socket (#346) shares the public port's HTTP server; the internal one takes no upgrade.
  app.useWebSocketAdapter(new ChatWsAdapter(app));

  // The schema is migrated as a separate step before the service starts (a
  // one-shot `db/migrate.ts` container in compose, `npm run db:migrate` on a
  // host, or the deploy pipeline) — never at boot.
  await startService(app, {
    serviceName: SERVICE_NAME,
    port: env.PORT,
    corsOrigins: env.CORS_ORIGINS,
  });
  // Started here, not at bootstrap, so an app built only to test never sweeps (ADR 0012 §6).
  app.get(RetentionCleanup).start();
}

main().catch((err: unknown) => {
  // Configuration errors happen before a logger exists, so this must use console.
  console.error(errorMessage(err));
  process.exit(1);
});
