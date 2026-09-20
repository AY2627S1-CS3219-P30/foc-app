import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { CORRELATION_HEADER, resolveCorrelationId } from './correlation.js';

const reqWith = (value: unknown): IncomingMessage =>
  ({ headers: { [CORRELATION_HEADER]: value } }) as unknown as IncomingMessage;

describe('resolveCorrelationId', () => {
  it('reuses an inbound correlation ID', () => {
    expect(resolveCorrelationId(reqWith('abc-123'))).toBe('abc-123');
  });

  it('mints one when the header is absent', () => {
    const id = resolveCorrelationId({ headers: {} } as IncomingMessage);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mints one when the header is blank', () => {
    expect(resolveCorrelationId(reqWith('   '))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('rejects an over-long header rather than bloating every log line', () => {
    expect(resolveCorrelationId(reqWith('x'.repeat(129)))).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('takes the first value when the header is repeated', () => {
    expect(resolveCorrelationId(reqWith(['first', 'second']))).toBe('first');
  });
});
