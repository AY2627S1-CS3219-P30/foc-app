// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5), date: 2026-09-20
// Scope: Generated the initial implementation for "scaffold the four services on a shared runtime".
// Author review: Jonus Ho verified correctness, tested the change, and checked for fatal errors and
//   conflicts with our architecture before committing.

import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { createLogger, PinoLoggerService, startService } from '@foc/platform';

async function main(): Promise<void> {
  // Imported dynamically so a configuration error surfaces as the clean message
  // below, rather than as an uncaught exception during module resolution.
  const { env, SERVICE_NAME } = await import('./config.js');
  const { AppModule } = await import('./app.module.js');

  const logger = new PinoLoggerService(createLogger(SERVICE_NAME, env.LOG_LEVEL));
  const app = await NestFactory.create(AppModule, { logger });
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
