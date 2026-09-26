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

  it('never leaks an unexpected error message', () => {
    const { status, body } = run(new Error('secret db password'));
    expect(status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('secret');
  });
});
