import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

/**
 * The single error shape every service returns. Agreed here rather than per
 * service so the web app can handle failures uniformly (FND-03).
 */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    correlationId: string;
    details?: unknown;
  };
}

/**
 * An HTTP error that carries its own stable machine code and structured
 * details, for failures a client must tell apart beyond the status alone
 * (`EMAIL_ALREADY_REGISTERED` vs a generic 409). Additive: exceptions that do
 * not use it still get the status-derived code below.
 */
export class ApiException extends HttpException {
  constructor(
    status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super({ message, code }, status);
  }
}

/** Maps an HTTP status to the stable machine-readable code clients switch on. */
function codeFor(status: number): string {
  switch (status) {
    case HttpStatus.BAD_REQUEST:
      return 'BAD_REQUEST';
    case HttpStatus.UNAUTHORIZED:
      return 'UNAUTHENTICATED';
    case HttpStatus.FORBIDDEN:
      return 'FORBIDDEN';
    case HttpStatus.NOT_FOUND:
      return 'NOT_FOUND';
    case HttpStatus.CONFLICT:
      return 'CONFLICT';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'UNPROCESSABLE';
    case HttpStatus.TOO_MANY_REQUESTS:
      return 'RATE_LIMITED';
    case HttpStatus.SERVICE_UNAVAILABLE:
      return 'UNAVAILABLE';
    default:
      return status >= 500 ? 'INTERNAL' : 'ERROR';
  }
}

/**
 * SQLSTATEs Postgres raises for text it cannot store, such as a `\0` in a
 * string field: the caller's input is at fault, not the server.
 */
const UNSTORABLE_TEXT = new Set(['22021', '22P05']);

const isUnstorableText = (e: unknown): boolean => {
  let current = e;
  while (current instanceof Error) {
    if (UNSTORABLE_TEXT.has((current as Error & { code?: string }).code ?? '')) return true;
    current = current.cause;
  }
  return false;
};

/**
 * How a dependency that has gone away shows up: the socket errors Node raises, the SQLSTATEs
 * Postgres raises while it is stopping, starting or out of connections (class 08 is "connection
 * exception"), and the messages node-postgres raises itself, which carry no code. Those are
 * matched whole and only on an error with no code: a wrapper's message can quote a statement and
 * its parameters, which are user input.
 */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'EPIPE',
]);
const UNAVAILABLE_SQLSTATES = new Set(['57P01', '57P02', '57P03', '53300']);
const UNAVAILABLE_MESSAGES: ReadonlySet<string> = new Set([
  'Connection terminated',
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'Client has encountered a connection error and is not queryable',
  'Client was closed and is not queryable',
]);

const isDependencyUnavailable = (e: unknown): boolean => {
  let current = e;
  while (current instanceof Error) {
    const code = (current as Error & { code?: unknown }).code;
    if (typeof code === 'string') {
      if (NETWORK_CODES.has(code) || UNAVAILABLE_SQLSTATES.has(code)) return true;
      if (/^08[0-9A-Z]{3}$/.test(code)) return true;
    } else if (UNAVAILABLE_MESSAGES.has(current.message)) {
      return true;
    }
    current = current.cause;
  }
  return false;
};

/** Seconds a client is told to wait before trying again after a 503 for a lost dependency. */
const RETRY_AFTER_SECONDS = 5;

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorEnvelopeFilter.name);

  catch(thrown: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string; correlationId?: string }>();
    // The request-logger middleware sets `correlationId`; `id` is kept as a fallback.
    const correlationId = req.correlationId ?? req.id ?? 'unknown';

    let exception = thrown;
    if (isUnstorableText(thrown)) {
      exception = new ApiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'VALIDATION_FAILED',
        'The request contains text that cannot be stored.',
      );
    } else if (!(thrown instanceof HttpException) && isDependencyUnavailable(thrown)) {
      // PL-NFR3.1.2: say the service is unavailable and when to try again, rather than a bare
      // 500. What was lost, and where, stays in the log.
      this.logger.warn({ correlationId, err: thrown }, 'A dependency is unavailable');
      res.setHeader('Retry-After', String(RETRY_AFTER_SECONDS));
      exception = new HttpException(
        'The service cannot reach something it depends on. Try again shortly.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let message = 'The request could not be completed.';
    let details: unknown;
    let code = codeFor(status);

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        if (typeof record.message === 'string') message = record.message;
        else if (Array.isArray(record.message)) {
          message = 'The request failed validation.';
          details = record.message;
        }
      }
      if (exception instanceof ApiException) {
        code = exception.code;
        details = exception.details;
      }
    } else {
      // Never surface an internal error's text to a caller; log it instead.
      this.logger.error({ correlationId, err: exception }, 'Unhandled exception');
    }

    const envelope: ErrorEnvelope = {
      error: { code, message, correlationId, ...(details ? { details } : {}) },
    };

    res.status(status).json(envelope);
  }
}
