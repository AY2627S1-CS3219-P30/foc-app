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
  // A mail message's recipient, and the name a student chose: personal data like the email.
  'to',
  'displayName',
];

/** Header and body fields that must never reach a log line (US-NFR4.1.1). */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-service-key"]',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]),
];

/**
 * An email address, plain or URL-encoded (`%40`). The bounds are the RFC maximums; they also keep
 * the scan linear on a long URL path an attacker controls.
 */
const EMAIL_PATTERN = /[a-z0-9._%+-]{1,64}(?:@|%40)[a-z0-9.-]{1,253}\.[a-z]{2,63}/gi;
/** An Argon2 or bcrypt password hash, as a database row or a PostgreSQL error message quotes it. */
const PASSWORD_HASH_PATTERN = /\$(?:argon2(?:id|i|d)|2[abxy])\$[\w$+/=,.-]*/g;

/** Replaces email addresses and password hashes in free text (US-NFR4.1.1, US-NFR2.1.1). */
export function maskPersonalData(text: string): string {
  return text.replace(EMAIL_PATTERN, '[email]').replace(PASSWORD_HASH_PATTERN, '[hash]');
}

/** Error fields that locate a fault without quoting data: SQLSTATE, constraint, socket details. */
const ERROR_FIELDS = [
  'code',
  'errno',
  'syscall',
  'address',
  'port',
  'constraint',
  'table',
  'column',
  'schema',
] as const;

type ErrorLike = Error & Record<string, unknown>;

/**
 * An error's message, masked. A Drizzle query error appends every bound value (`params: …`),
 * which can be any column of the row, so only its statement is kept.
 */
function errorMessage(err: Error): string {
  const { query, params } = err as Error & { query?: unknown; params?: unknown };
  return maskPersonalData(
    typeof query === 'string' && params !== undefined ? `Failed query: ${query}` : err.message,
  );
}

const isErrorLike = (value: unknown): value is ErrorLike =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { message?: unknown }).message === 'string';

/**
 * Replaces pino's default `err` serializer, which copies every field of an error and runs before
 * redaction can see inside a string. A PostgreSQL error's `detail` and `where` quote the row
 * (`Key (lower(email))=(alice@u.nus.edu) already exists`, `Failing row contains (…, $argon2id$…)`),
 * and a mailer's message names the recipient. This keeps the fields an operator needs to find
 * the fault, masks email addresses and password hashes in them, and drops everything else.
 */
export function serializeError(err: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof err === 'string') return maskPersonalData(err);
  if (!isErrorLike(err)) return err;
  if (seen.has(err)) return '[circular]';
  seen.add(err);

  const message = errorMessage(err);
  const out: Record<string, unknown> = {
    type: typeof err.constructor === 'function' ? err.constructor.name : err.name,
    message,
  };
  if (typeof err.stack === 'string') {
    out.stack = maskPersonalData(err.stack.replace(err.message, message));
  }
  for (const key of ERROR_FIELDS) {
    const value = err[key];
    if (typeof value === 'string') out[key] = maskPersonalData(value);
    else if (typeof value === 'number') out[key] = value;
  }
  if (err.cause !== undefined) out.cause = serializeError(err.cause, seen);
  if (Array.isArray(err.errors)) {
    out.aggregateErrors = err.errors.map((inner: unknown) => serializeError(inner, seen));
  }
  return out;
}

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
      serializers: { err: serializeError },
      hooks: {
        // Given `{ err }` and no message, pino copies `err.message` into `msg` itself, past the
        // serializer above. Hand it the masked message instead.
        logMethod(args, method) {
          const [first, message] = args as unknown[];
          if (message === undefined && typeof first === 'object' && first !== null) {
            const err =
              first instanceof Error
                ? first
                : (first as { msg?: unknown }).msg === undefined
                  ? (first as { err?: unknown }).err
                  : undefined;
            if (isErrorLike(err)) return method.apply(this, [first, errorMessage(err)]);
          }
          return method.apply(this, args);
        },
      },
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
    if (message instanceof Error)
      this.logger[level]({ ...ctx, err: message }, errorMessage(message));
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
    const fullPath = (req.originalUrl ?? req.url).split('?')[0]!;
    if (fullPath === '/health') return next();
    // The query string is dropped above; an address can still sit in the path
    // (`/admin/users/alice@u.nus.edu`, or any mistyped route), raw or `%40`-encoded.
    const loggedPath = maskPersonalData(fullPath);

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      logger[level](
        {
          correlationId,
          method: req.method,
          url: loggedPath,
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
