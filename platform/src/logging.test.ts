import { Logger, NotFoundException, type ArgumentsHost } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CORRELATION_HEADER } from './correlation.js';
import { ErrorEnvelopeFilter, type ErrorEnvelope } from './errors.js';
import { REDACT_PATHS, requestLogger } from './logging.js';

/** The JSON line one log call writes, redacted the way every service's logger is. */
function logged(fields: object): Record<string, unknown> {
  const lines: string[] = [];
  const logger = pino(
    { redact: { paths: REDACT_PATHS, censor: '[redacted]' } },
    { write: (line: string) => void lines.push(line) },
  );
  logger.info(fields);
  return JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
}

describe('log redaction', () => {
  it('hides a credential at the top level', () => {
    expect(logged({ password: 'hunter2' })).toMatchObject({ password: '[redacted]' });
  });

  it('hides a credential one level down, as in a logged DTO', () => {
    expect(logged({ dto: { password: 'hunter2' } })).toMatchObject({
      dto: { password: '[redacted]' },
    });
  });

  it('hides a credential two levels down, as in a logged request body', () => {
    expect(logged({ req: { body: { refreshToken: 'rt-1' } } })).toMatchObject({
      req: { body: { refreshToken: '[redacted]' } },
    });
  });

  it('hides an email address (US-NFR4.1.1)', () => {
    expect(logged({ user: { email: 'e0000000@u.nus.edu' } })).toMatchObject({
      user: { email: '[redacted]' },
    });
  });

  it('leaves identifiers alone, since they are how an operator follows a request', () => {
    expect(logged({ userId: 'user-1', correlationId: 'trace-1' })).toMatchObject({
      userId: 'user-1',
      correlationId: 'trace-1',
    });
  });
});

/**
 * Runs one failing request through the request logger and then the error
 * filter, the order a service runs them in. The two must agree on where the
 * correlation ID lives on the request: when they did not, every error
 * envelope said "unknown".
 */
function failRequest(exception: unknown, headers: Record<string, string> = {}) {
  const responseHeaders: Record<string, string> = {};
  let body: ErrorEnvelope | undefined;
  const req = { headers, method: 'GET', url: '/nope', originalUrl: '/nope' } as unknown as Request;
  const res = {
    headersSent: false,
    setHeader: (name: string, value: string) => void (responseHeaders[name] = value),
    on: () => res,
    status: () => res,
    json: (payload: ErrorEnvelope) => void (body = payload),
  } as unknown as Response;
  const host = {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as unknown as ArgumentsHost;

  const next = vi.fn();
  requestLogger(pino({ enabled: false }))(req, res, next as NextFunction);
  expect(next).toHaveBeenCalledOnce();
  new ErrorEnvelopeFilter().catch(exception, host);

  return { body: body as ErrorEnvelope, responseHeaders };
}

describe('correlation ID in the error envelope', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the caller's correlation ID", () => {
    const { body } = failRequest(new NotFoundException(), { [CORRELATION_HEADER]: 'trace-123' });
    expect(body.error.correlationId).toBe('trace-123');
  });

  it('reports the ID the request logger minted when the caller sent none', () => {
    const { body, responseHeaders } = failRequest(new NotFoundException());
    expect(body.error.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.error.correlationId).toBe(responseHeaders[CORRELATION_HEADER]);
  });

  it('logs an unhandled error under the same ID, so an operator can find it', () => {
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { body } = failRequest(new Error('boom'), { [CORRELATION_HEADER]: 'trace-500' });
    expect(body.error.correlationId).toBe('trace-500');
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'trace-500' }),
      'Unhandled exception',
    );
  });
});
