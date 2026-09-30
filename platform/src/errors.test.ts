import type { ArgumentsHost } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ApiException, ErrorEnvelopeFilter } from './errors.js';

function run(exception: unknown) {
  let status = 0;
  let body: unknown;
  const res = {
    status(s: number) {
      status = s;
      return this;
    },
    json(b: unknown) {
      body = b;
    },
  };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ id: 'corr-1' }) }),
  } as unknown as ArgumentsHost;
  new ErrorEnvelopeFilter().catch(exception, host);
  return { status, body: body as { error: Record<string, unknown> } };
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
