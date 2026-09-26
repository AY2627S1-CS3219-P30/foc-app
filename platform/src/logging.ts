import type { LoggerService } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import pino, { type DestinationStream, type Logger as PinoLogger } from 'pino';
import { CORRELATION_HEADER, echoCorrelationId, resolveCorrelationId } from './correlation.js';

/**
 * Credentials (US-NFR2.1.1) and email addresses (US-NFR4.1.1), wherever they
 * appear in a logged object. pino matches redaction paths exactly, so each key
 * is also listed one and two levels down: `password` alone would miss a logged
 * `{ dto: { password } }`.
 */
const SENSITIVE_KEYS = [
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'passwordHash',
  'email',
];

/** Header and body fields that must never reach a log line (US-NFR4.1.1). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-service-key"]',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

export function createLogger(
  serviceName: string,
  level: string,
  destination?: DestinationStream,
): PinoLogger {
  return pino(
    {
      level,
      base: { service: serviceName },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      formatters: {
        // Emit `"level":"info"` rather than `"level":30` — an operator reads these.
        level: (label) => ({ level: label }),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}

/**
 * Adapts pino to Nest's LoggerService so framework logs are JSON too, rather
 * than Nest's pretty-printed default. Without this, half the lines in a
 * container's output are unparseable.
 */
export class PinoLoggerService implements LoggerService {
  constructor(private readonly logger: PinoLogger) {}

  private write(
    level: 'info' | 'error' | 'warn' | 'debug' | 'trace',
    message: unknown,
    context?: unknown,
  ): void {
    const ctx = typeof context === 'string' ? { context } : {};
    if (message instanceof Error) this.logger[level]({ ...ctx, err: message }, message.message);
    else if (typeof message === 'object' && message !== null)
      this.logger[level]({ ...ctx, ...message });
    else this.logger[level](ctx, String(message));
  }

  log(message: unknown, context?: unknown): void {
    this.write('info', message, context);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest[rest.length - 1]);
  }
  warn(message: unknown, context?: unknown): void {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: unknown): void {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: unknown): void {
    this.write('trace', message, context);
  }
}

/**
 * One JSON line per request, carrying the correlation ID that ties a browser
 * action to every service that handled it (EI-NFR4.1.1). Attaches the id to the
 * request so handlers and the error filter can reuse it.
 */
export function requestLogger(logger: PinoLogger) {
  return function requestLoggerMiddleware(req: Request, res: Response, next: NextFunction): void {
    const correlationId = resolveCorrelationId(req);
    echoCorrelationId(res, correlationId);
    (req as Request & { correlationId: string }).correlationId = correlationId;

    // /health is polled by Docker every few seconds; logging it drowns the rest.
    // Nest rewrites `req.url` relative to the middleware mount point, so the
    // full path is only reliable on `originalUrl`.
    const fullPath = (req.originalUrl ?? req.url).split('?')[0];
    if (fullPath === '/health') return next();

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level](
        {
          correlationId,
          method: req.method,
          url: fullPath,
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs * 100) / 100,
        },
        'request completed',
      );
    });
    next();
  };
}

export { CORRELATION_HEADER };
