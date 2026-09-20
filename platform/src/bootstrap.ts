import { INestApplication, Logger } from '@nestjs/common';
import { CORRELATION_HEADER } from './correlation.js';
import { ErrorEnvelopeFilter } from './errors.js';

/**
 * Applies the conventions every service shares and starts listening.
 *
 * Graceful shutdown is wired here rather than per service: on SIGTERM the app
 * stops accepting connections and lets in-flight requests finish, so a
 * `docker compose restart` does not sever a request mid-write.
 */
export async function startService(
  app: INestApplication,
  options: { serviceName: string; port: number; corsOrigins: string },
): Promise<void> {
  const logger = new Logger(options.serviceName);

  app.useGlobalFilters(new ErrorEnvelopeFilter());
  app.enableShutdownHooks();

  // The browser talks to each service on its own origin, so every service
  // needs CORS. An explicit allowlist, never '*' — these endpoints carry
  // credentials once USR-02 lands.
  const origins = options.corsOrigins
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: origins,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', CORRELATION_HEADER],
    exposedHeaders: [CORRELATION_HEADER],
  });
  logger.log(`CORS allows: ${origins.join(', ')}`);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.log(`Received ${signal}, shutting down`);
    try {
      await app.close();
      logger.log('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen(options.port, '0.0.0.0');
  logger.log(`${options.serviceName} listening on port ${options.port}`);
}
