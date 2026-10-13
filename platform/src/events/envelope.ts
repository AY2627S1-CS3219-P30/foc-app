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
  /**
   * Default to a fresh id and the current time. The outbox relay sets both from
   * the stored row, so an event published twice (a crash between publishing and
   * marking it published) reaches a consumer's inbox as the same event.
   */
  eventId?: string;
  occurredAt?: string;
  payload: T;
}

export function createEnvelope<T>(input: NewEventInput<T>): Envelope<T> {
  return {
    eventId: input.eventId ?? randomUUID(),
    eventType: input.eventType,
    schemaVersion: input.schemaVersion,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    producer: input.producer,
    correlationId: input.correlationId,
    causationId: input.causationId ?? input.correlationId,
    payload: input.payload,
  };
}

/**
 * Thrown by the publisher for an event the catalogue does not describe, or a payload that fails its
 * schema. Nothing reaches the broker: a shape a consumer would dead-letter fails where it was made.
 */
export class EventValidationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'EventValidationError';
  }
}

/**
 * Thrown by the publisher when the broker hands back an event that needs a consumer because no
 * queue is bound for it. The broker would otherwise confirm the message and discard it. The outbox
 * treats it as any failed publish: the row is kept and retried until a queue exists.
 */
export class UnroutableEventError extends Error {
  constructor(eventType: string) {
    super(`unroutable: no queue is bound for ${eventType}`);
    this.name = 'UnroutableEventError';
  }
}

/**
 * EI-NFR2.1.1 — thrown by a handler for a step older than a change it has already applied, such as
 * a second copy of a reply that arrives after the errand has moved on. The consumer acknowledges
 * it, counts it and logs it for operators; it is never applied, retried or dead-lettered.
 */
export class StaleEventError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'StaleEventError';
  }
}

/**
 * EI-NFR2.1.2 — thrown by a handler for a step that depends on an earlier one that has not happened
 * yet, such as a transfer whose reservation has not been recorded. The consumer counts it and
 * retries it as any failure; once its attempts are spent it is set aside for review. The handler
 * must not guess the missing step's outcome.
 */
export class PredecessorMissingError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'PredecessorMissingError';
  }
}

/** Thrown when a message cannot be understood. These never retry — they dead-letter. */
export class UnparseableMessageError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UnparseableMessageError';
  }
}

/**
 * A message that names a producer but was published by another service's broker account
 * (PLT-06). Permanent, like any message that cannot be believed: set aside at once, with who
 * really sent it, and never handled.
 */
export class UntrustedSenderError extends UnparseableMessageError {
  constructor(sender: string | undefined, eventType: string, trusted: readonly string[]) {
    super(
      `sender ${sender ?? 'unknown'} may not publish ${eventType}: only ${trusted.join(' or ')} may`,
    );
    this.name = 'UntrustedSenderError';
  }
}

/**
 * EI-NFR3.1.2 — a message in a major version this consumer was not written for. It is set aside
 * whole, stating that the form is unsupported; no part of it is acted on.
 */
export class UnsupportedVersionError extends UnparseableMessageError {
  constructor(eventType: string, schemaVersion: number, supported: readonly number[]) {
    super(
      `unsupported schema version ${schemaVersion} for ${eventType}; supported: ${supported.join(', ')}`,
    );
    this.name = 'UnsupportedVersionError';
  }
}

/** The major versions a consumer supports unless it says otherwise. */
export const DEFAULT_SUPPORTED_VERSIONS: readonly number[] = [1];

/**
 * Validates an inbound message against the envelope and the payload schema
 * registered for its type. A failure here is permanent: retrying a malformed
 * message just wastes the retry budget.
 *
 * The major version is checked before the payload is read. A newer major may
 * change what a field means while still fitting the older schema, so fitting
 * the schema is not permission to act on it.
 */
export function parseEnvelope<T>(
  raw: Buffer,
  payloadSchema: z.ZodType<T>,
  supportedVersions: readonly number[] = DEFAULT_SUPPORTED_VERSIONS,
): Envelope<T> {
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

  if (!supportedVersions.includes(outer.data.schemaVersion)) {
    throw new UnsupportedVersionError(
      outer.data.eventType,
      outer.data.schemaVersion,
      supportedVersions,
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
