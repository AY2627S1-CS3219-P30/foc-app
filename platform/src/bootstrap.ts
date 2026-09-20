import { INestApplication, Logger } from '@nestjs/common';
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
  options: { serviceName: string; port: number },
): Promise<void> {
  const logger = new Logger(options.serviceName);

  app.useGlobalFilters(new ErrorEnvelopeFilter());
  app.enableShutdownHooks();

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
