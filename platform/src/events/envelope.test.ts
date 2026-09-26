import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  createEnvelope,
  envelopeSchema,
  parseEnvelope,
  UnparseableMessageError,
} from './envelope.js';

const payloadSchema = z.object({ userId: z.string().min(1) });
const base = {
  eventType: 'user.activated',
  schemaVersion: 1,
  aggregateId: 'user-1',
  producer: 'user-service',
  correlationId: 'corr-1',
  payload: { userId: 'user-1' },
};

describe('createEnvelope', () => {
  it('stamps every field a consumer needs to trace the message', () => {
    const e = createEnvelope(base);
    expect(envelopeSchema.safeParse(e).success).toBe(true);
    expect(e.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(e.correlationId).toBe('corr-1');
    expect(e.producer).toBe('user-service');
  });

  it('defaults causationId to the correlation id when the event starts a workflow', () => {
    expect(createEnvelope(base).causationId).toBe('corr-1');
  });

  it('keeps an explicit causationId when this event was caused by another', () => {
    expect(createEnvelope({ ...base, causationId: 'event-0' }).causationId).toBe('event-0');
  });

  it('gives each event its own id', () => {
    expect(createEnvelope(base).eventId).not.toBe(createEnvelope(base).eventId);
  });
});

describe('parseEnvelope', () => {
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8');

  it('round-trips a valid message', () => {
    const sent = createEnvelope(base);
    const got = parseEnvelope(encode(sent), payloadSchema);
    expect(got.eventId).toBe(sent.eventId);
    expect(got.payload.userId).toBe('user-1');
  });

  it('rejects a body that is not JSON', () => {
    expect(() => parseEnvelope(Buffer.from('not json'), payloadSchema)).toThrow(
      UnparseableMessageError,
    );
  });

  it('rejects an envelope missing a required field', () => {
    const { correlationId: _drop, ...broken } = createEnvelope(base);
    expect(() => parseEnvelope(encode(broken), payloadSchema)).toThrow(/envelope invalid/);
  });

  it('rejects a payload that does not match its schema', () => {
    const wrong = createEnvelope({ ...base, payload: { notUserId: 1 } });
    expect(() => parseEnvelope(encode(wrong), payloadSchema)).toThrow(/payload invalid/);
  });

  it('names the offending field, so an operator can act on a dead letter', () => {
    const wrong = createEnvelope({ ...base, payload: {} });
    expect(() => parseEnvelope(encode(wrong), payloadSchema)).toThrow(/userId/);
  });

  it('rejects an over-long correlation id rather than letting it bloat every log line', () => {
    const e = createEnvelope({ ...base, correlationId: 'x'.repeat(129) });
    expect(() => parseEnvelope(encode(e), payloadSchema)).toThrow(/envelope invalid/);
  });
});
