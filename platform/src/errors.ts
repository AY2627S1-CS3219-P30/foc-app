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

@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorEnvelopeFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request & { id?: string }>();
    const correlationId = req.id ?? 'unknown';

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    let message = 'The request could not be completed.';
    let details: unknown;

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
    } else {
      // Never surface an internal error's text to a caller; log it instead.
      this.logger.error({ correlationId, err: exception }, 'Unhandled exception');
    }

    const envelope: ErrorEnvelope = {
      error: { code: codeFor(status), message, correlationId, ...(details ? { details } : {}) },
    };

    res.status(status).json(envelope);
  }
}
