import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * The envelope every message carries, regardless of workflow.
 *
 * `correlationId` is the thread a human follows: it is minted at the HTTP edge
 * and copied onto every message the request causes, and onto every message
 * those cause in turn. `causationId` is the immediate parent — the event or
 * request that produced this one. Together they satisfy EI-NFR4.1.1: one order
 * reconstructed from one identifier.
 */
export const envelopeSchema = z.object({
  eventId: z.uuid(),
  eventType: z.string().min(1),
  /** Major version only. A consumer that does not know this value must not guess. */
  schemaVersion: z.number().int().positive(),
  /** The thing this is about — a userId, an orderId. */
  aggregateId: z.string().min(1),
  occurredAt: z.iso.datetime(),
  producer: z.string().min(1),
  correlationId: z.string().min(1).max(128),
  causationId: z.string().min(1).max(128),
  payload: z.unknown(),
});

export type Envelope<T = unknown> = Omit<z.infer<typeof envelopeSchema>, 'payload'> & {
  payload: T;
};

export interface NewEventInput<T> {
  eventType: string;
  schemaVersion: number;
  aggregateId: string;
  producer: string;
  correlationId: string;
  /** Defaults to the correlation id when this event starts a workflow. */
  causationId?: string;
  payload: T;
}

export function createEnvelope<T>(input: NewEventInput<T>): Envelope<T> {
  return {
    eventId: randomUUID(),
    eventType: input.eventType,
    schemaVersion: input.schemaVersion,
    aggregateId: input.aggregateId,
    occurredAt: new Date().toISOString(),
    producer: input.producer,
    correlationId: input.correlationId,
    causationId: input.causationId ?? input.correlationId,
    payload: input.payload,
  };
}

/** Thrown when a message cannot be understood. These never retry — they dead-letter. */
export class UnparseableMessageError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnparseableMessageError';
  }
}

/**
 * Validates an inbound message against the envelope and the payload schema
 * registered for its type. A failure here is permanent: retrying a malformed
 * message just wastes the retry budget.
 */
export function parseEnvelope<T>(raw: Buffer, payloadSchema: z.ZodType<T>): Envelope<T> {
  let json: unknown;
  try {
    json = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new UnparseableMessageError('body is not valid JSON');
  }

  const outer = envelopeSchema.safeParse(json);
  if (!outer.success) {
    throw new UnparseableMessageError(
      `envelope invalid: ${outer.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  }

  const inner = payloadSchema.safeParse(outer.data.payload);
  if (!inner.success) {
    throw new UnparseableMessageError(
      `payload invalid: ${inner.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
    );
  }

  return { ...outer.data, payload: inner.data };
}
