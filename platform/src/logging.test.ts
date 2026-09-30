import { Logger, NotFoundException, type ArgumentsHost } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CORRELATION_HEADER } from './correlation.js';
import { ErrorEnvelopeFilter, type ErrorEnvelope } from './errors.js';
import { createLogger, PinoLoggerService, REDACT_PATHS, requestLogger } from './logging.js';

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

  it("hides a mail recipient and a student's display name", () => {
    expect(
      logged({ mail: { to: 'e0000000@u.nus.edu' }, user: { displayName: 'Alex Tan' } }),
    ).toMatchObject({ mail: { to: '[redacted]' }, user: { displayName: '[redacted]' } });
  });

  it('leaves identifiers alone, since they are how an operator follows a request', () => {
    expect(logged({ userId: 'user-1', correlationId: 'trace-1' })).toMatchObject({
      userId: 'user-1',
      correlationId: 'trace-1',
    });
  });
});

/** A service logger, as `createLogger` builds it, writing into an array. */
function serviceLogger() {
  const lines: string[] = [];
  const logger = createLogger('test-service', 'trace', {
    write: (l: string) => void lines.push(l),
  });
  return { logger, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, any>) };
}

const EMAIL = /[a-z0-9._%+-]+(@|%40)[a-z0-9.-]+\.[a-z]{2,}/i;

/**
 * pino's own `err` serializer copies every field of an error before redaction runs, so what
 * PostgreSQL or a mailer puts in an error reached the log verbatim (US-NFR4.1.1).
 */
describe('logged errors', () => {
  const argon2 = '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo';
  const bcrypt = '$2b$12$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';

  it('keep what locates a PostgreSQL error and drop the row it quotes', () => {
    const err = Object.assign(
      new Error('duplicate key value violates unique constraint "users_email_key"'),
      {
        code: '23505',
        severity: 'ERROR',
        schema: 'public',
        table: 'users',
        constraint: 'users_email_key',
        detail: 'Key (lower(email))=(alice@u.nus.edu) already exists.',
        where: `SQL statement "INSERT INTO users VALUES ('alice@u.nus.edu', '${argon2}')"`,
      },
    );
    const { logger, lines, parsed } = serviceLogger();
    logger.error({ correlationId: 'c-1', err }, 'Unhandled exception');

    expect(parsed()[0]).toMatchObject({
      correlationId: 'c-1',
      msg: 'Unhandled exception',
      err: {
        type: 'Error',
        message: 'duplicate key value violates unique constraint "users_email_key"',
        code: '23505',
        schema: 'public',
        table: 'users',
        constraint: 'users_email_key',
        stack: expect.stringContaining('users_email_key'),
      },
    });
    expect(parsed()[0]!.err).not.toHaveProperty('detail');
    expect(parsed()[0]!.err).not.toHaveProperty('where');
    expect(lines.join('')).not.toMatch(EMAIL);
    expect(lines.join('')).not.toContain('argon2');
  });

  it('keep a socket error readable', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), {
      code: 'ECONNREFUSED',
      errno: -111,
      syscall: 'connect',
      address: '10.0.0.5',
      port: 5432,
    });
    const { logger, parsed } = serviceLogger();
    logger.error({ err }, 'Pool error');
    expect(parsed()[0]!.err).toMatchObject({
      message: 'connect ECONNREFUSED 10.0.0.5:5432',
      code: 'ECONNREFUSED',
      errno: -111,
      syscall: 'connect',
      address: '10.0.0.5',
      port: 5432,
    });
  });

  it('mask an address or a hash in the message, the stack, and the message pino copies from it', () => {
    const err = new Error(
      `550 recipient Alice.Tan@u.nus.edu rejected; alice%40u.nus.edu; ${argon2}; ${bcrypt}`,
    );
    const { logger, lines, parsed } = serviceLogger();
    logger.error(err);
    logger.error({ err }); // no message: pino fills `msg` from err.message
    const nest = new PinoLoggerService(logger);
    nest.error(err, undefined, 'SomeService');
    // How ErrorEnvelopeFilter's `Logger.error({ correlationId, err }, 'Unhandled exception')` arrives.
    nest.error({ correlationId: 'c-2', err }, 'Unhandled exception', 'ErrorEnvelopeFilter');

    expect(lines).toHaveLength(4);
    for (const line of parsed()) {
      expect(line.msg).toBe('550 recipient [email] rejected; [email]; [hash]; [hash]');
      expect(line.err.message).toBe(line.msg);
      expect(line.err.stack).toContain('[email]');
    }
    expect(lines.join('')).not.toMatch(EMAIL);
    expect(lines.join('')).not.toMatch(/argon2|\$2b\$/);
  });

  it('mask a cause, and each error of an AggregateError', () => {
    const err = new Error('lookup failed', { cause: new Error('no row for bob@u.nus.edu') });
    const aggregate = new AggregateError([new Error('carol@u.nus.edu refused')], 'send failed');
    const { logger, lines, parsed } = serviceLogger();
    logger.error({ err }, 'first');
    logger.error({ err: aggregate }, 'second');

    expect(parsed()[0]!.err.cause).toMatchObject({ message: 'no row for [email]' });
    expect(parsed()[1]!.err.aggregateErrors).toEqual([
      expect.objectContaining({ message: '[email] refused' }),
    ]);
    expect(lines.join('')).not.toMatch(EMAIL);
  });
});

/** The request line `requestLogger` writes for one request that ends with `statusCode`. */
function requestLine(url: string, statusCode = 404): Record<string, unknown> {
  const { logger, parsed } = serviceLogger();
  let finish: () => void = () => undefined;
  const req = { headers: {}, method: 'GET', url, originalUrl: url } as unknown as Request;
  const res = {
    statusCode,
    setHeader: () => undefined,
    on: (_event: string, listener: () => void) => void (finish = listener),
  } as unknown as Response;
  requestLogger(logger)(req, res, () => undefined);
  finish();
  return parsed()[0] ?? {};
}

describe('request path in the request line (US-NFR4.1.1)', () => {
  it('drops the query string', () => {
    expect(requestLine('/admin/users?q=alice%40u.nus.edu', 200).url).toBe('/admin/users');
  });

  it('masks an address in the path, raw or URL-encoded', () => {
    expect(requestLine('/admin/users/alice@u.nus.edu').url).toBe('/admin/users/[email]');
    expect(requestLine('/nope/Alice.Tan%40u.nus.edu/x').url).toBe('/nope/[email]/x');
  });

  it('leaves an ordinary path alone', () => {
    const id = '0b7c2c1e-6f1d-4c4e-9d53-2f1c7d0b9a11';
    expect(requestLine(`/admin/users/${id}/suspend`, 200).url).toBe(`/admin/users/${id}/suspend`);
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
