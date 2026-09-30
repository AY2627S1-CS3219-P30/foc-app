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

const isUnstorableText = (e: unknown): boolean =>
  e instanceof Error && UNSTORABLE_TEXT.has((e as { code?: string }).code ?? '');

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorEnvelopeFilter.name);

  catch(thrown: unknown, host: ArgumentsHost): void {
    const exception = isUnstorableText(thrown)
      ? new ApiException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'VALIDATION_FAILED',
          'The request contains text that cannot be stored.',
        )
      : thrown;
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string; correlationId?: string }>();
    // The request-logger middleware sets `correlationId`; `id` is kept as a fallback.
    const correlationId = req.correlationId ?? req.id ?? 'unknown';

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
