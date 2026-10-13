import type { ArgumentsHost } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ApiException, ErrorEnvelopeFilter } from './errors.js';

function run(exception: unknown) {
  let status = 0;
  let body: unknown;
  const headers: Record<string, string> = {};
  const res = {
    status(s: number) {
      status = s;
      return this;
    },
    json(b: unknown) {
      body = b;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ id: 'corr-1' }) }),
  } as unknown as ArgumentsHost;
  new ErrorEnvelopeFilter().catch(exception, host);
  return { status, headers, body: body as { error: Record<string, unknown> } };
}

describe('ErrorEnvelopeFilter', () => {
  it('uses the exception code and details when an ApiException is thrown', () => {
    const details = [{ field: 'email', code: 'EMAIL_DOMAIN_NOT_ALLOWED', message: 'no' }];
    const { status, body } = run(new ApiException(422, 'VALIDATION_FAILED', 'bad', details));
    expect(status).toBe(422);
    expect(body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: 'bad',
      correlationId: 'corr-1',
      details,
    });
  });

  it('falls back to the status-derived code for a plain HttpException', () => {
    const { status, body } = run(new HttpException('nope', 409));
    expect(status).toBe(409);
    expect(body.error.code).toBe('CONFLICT');
  });

  it.each(['22021', '22P05'])('maps a Postgres %s (text it cannot store) to a 422', (sqlState) => {
    const err = Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), {
      code: sqlState,
    });
    const { status, body } = run(err);
    expect(status).toBe(422);
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(body)).not.toContain('0x00');
  });

  it('maps a text error wrapped by Drizzle to a 422', () => {
    const driver = Object.assign(new Error('invalid byte sequence'), { code: '22021' });
    const wrapped = new Error('Failed query', { cause: driver });
    const { status, body } = run(wrapped);
    expect(status).toBe(422);
    expect(body.error.code).toBe('VALIDATION_FAILED');
  });

  it('still treats other Postgres errors as internal', () => {
    const { status } = run(Object.assign(new Error('deadlock detected'), { code: '40P01' }));
    expect(status).toBe(500);
  });

  it('never leaks an unexpected error message', () => {
    const { status, body } = run(new Error('secret db password'));
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});

describe('a dependency that has gone away (PL-NFR3.1.2)', () => {
  /** What node-postgres throws when nothing listens on the database's port. */
  const refused = () =>
    Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });

  it('answers 503 with Retry-After when the database is unreachable', () => {
    const { status, headers, body } = run(refused());

    expect(status).toBe(503);
    expect(headers['retry-after']).toBe('5');
    expect(body.error).toMatchObject({ code: 'UNAVAILABLE', correlationId: 'corr-1' });
    // The address of the database is not for the caller.
    expect(JSON.stringify(body)).not.toContain('10.0.0.5');
  });

  it('finds a lost connection inside a wrapped error', () => {
    const wrapped = new Error('Failed query: insert into "users"', { cause: refused() });
    expect(run(wrapped).status).toBe(503);
  });

  it.each([
    ['57P01', 'terminating connection due to administrator command'],
    ['57P03', 'the database system is starting up'],
    ['08006', 'connection failure'],
    ['53300', 'sorry, too many clients already'],
  ])('treats SQLSTATE %s as the database being unavailable', (code, message) => {
    expect(run(Object.assign(new Error(message), { code })).status).toBe(503);
  });

  it.each([
    'Connection terminated unexpectedly',
    'timeout exceeded when trying to connect',
    // What a transaction gets on its next statement after its connection was lost.
    'Client has encountered a connection error and is not queryable',
  ])('treats the pool’s own "%s" as the database being unavailable', (message) => {
    expect(run(new Error(message)).status).toBe(503);
  });

  it('still answers 500 for any other failure', () => {
    const { status, headers, body } = run(new Error('cannot read properties of undefined'));

    expect(status).toBe(500);
    expect(headers['retry-after']).toBeUndefined();
    expect(body.error.code).toBe('INTERNAL');
  });

  it('does not take a failed query that only mentions a lost connection for an outage', () => {
    // Drizzle puts the statement and its parameters, which are user input, into its message.
    const wrapped = new Error(
      'Failed query: insert into "notes" ("body") values ($1) params: Connection terminated unexpectedly',
      { cause: Object.assign(new Error('duplicate key value'), { code: '23505' }) },
    );
    expect(run(wrapped).status).toBe(500);
  });

  it('does not mistake a constraint violation for an outage', () => {
    const unique = Object.assign(new Error('duplicate key value'), { code: '23505' });
    expect(run(unique).status).toBe(500);
  });
});
