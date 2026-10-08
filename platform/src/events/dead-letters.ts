import { Logger, type FactoryProvider, type InjectionToken } from '@nestjs/common';
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Db, Queryable, Row } from '../db.js';
import { ApiException } from '../errors.js';
import { METRICS, type Metrics } from '../metrics.js';
import type { BrokerConnection } from './connection.js';
import { BROKER } from './events.module.js';
import {
  HEADER_ATTEMPT,
  HEADER_FAILURE,
  HEADER_ORIGINAL_QUEUE,
  deadLetterQueueName,
} from './topology.js';

/**
 * PLT-05 (EI-FR3.1.2) — dead letters an operator can find, read and redrive.
 *
 * A message whose attempts are spent, or that cannot be parsed, lands in its queue's `<queue>.dlq`.
 * A queue is awkward to search, and taking one message out of the middle of it means handling every
 * other, so each service drains its own dead-letter queues into this table, in its own database:
 * searchable by correlation, order or event id, kept after it is dealt with, and counted for the
 * dashboard and its alert.
 *
 * A row is immutable but for one stamp: who redrove it, when and why. The trigger refuses any other
 * change, so a redrive provably sends the payload that failed, byte for byte.
 */
export const DEAD_LETTERS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS dead_letters (
  id                     uuid PRIMARY KEY,
  queue                  text NOT NULL,
  event_id               text,
  event_type             text,
  aggregate_id           text,
  correlation_id         text,
  failure_reason         text,
  attempts               integer NOT NULL,
  body                   bytea NOT NULL,
  properties             jsonb NOT NULL,
  parked_at              timestamptz NOT NULL DEFAULT now(),
  redriven_at            timestamptz,
  redriven_by            text,
  redrive_reason         text,
  redrive_correlation_id text,
  CONSTRAINT dead_letters_redrive_complete CHECK (
    (redriven_at IS NULL) = (redriven_by IS NULL)
    AND (redriven_at IS NULL) = (redrive_reason IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS dead_letters_waiting_idx ON dead_letters (parked_at DESC) WHERE redriven_at IS NULL;
CREATE INDEX IF NOT EXISTS dead_letters_correlation_idx ON dead_letters (correlation_id);
CREATE INDEX IF NOT EXISTS dead_letters_aggregate_idx ON dead_letters (aggregate_id);
CREATE INDEX IF NOT EXISTS dead_letters_event_idx ON dead_letters (event_id);

CREATE OR REPLACE FUNCTION dead_letters_guard() RETURNS trigger AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'dead_letters is kept: a row is never deleted' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.redriven_at IS NOT NULL
     OR (NEW.id, NEW.queue, NEW.event_id, NEW.event_type, NEW.aggregate_id, NEW.correlation_id,
         NEW.failure_reason, NEW.attempts, NEW.body, NEW.properties, NEW.parked_at)
        IS DISTINCT FROM
        (OLD.id, OLD.queue, OLD.event_id, OLD.event_type, OLD.aggregate_id, OLD.correlation_id,
         OLD.failure_reason, OLD.attempts, OLD.body, OLD.properties, OLD.parked_at) THEN
    RAISE EXCEPTION 'dead_letters rows change once, to record a redrive' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS dead_letters_guard ON dead_letters;
CREATE TRIGGER dead_letters_guard BEFORE UPDATE OR DELETE ON dead_letters
  FOR EACH ROW EXECUTE FUNCTION dead_letters_guard();
`;

/** Marks a redriven message, so its consumer's logs can name the dead letter it came from. */
export const HEADER_REDRIVE_OF = 'x-foc-redrive-of';

/** Headers that describe the failure, not the event: a redrive starts the attempts again. */
const FAILURE_HEADERS = [
  HEADER_ATTEMPT,
  HEADER_FAILURE,
  HEADER_ORIGINAL_QUEUE,
  'x-death',
  'x-first-death-exchange',
  'x-first-death-queue',
  'x-first-death-reason',
  'x-last-death-exchange',
  'x-last-death-queue',
  'x-last-death-reason',
];

/** How long to wait before taking a message back from the broker when it could not be stored. */
const PARK_RETRY_MS = 5_000;

export type DeadLetterStatus = 'WAITING' | 'REDRIVEN';

/** One dead letter, as an operator lists it. */
export interface DeadLetter {
  id: string;
  /** The queue whose consumer failed, which a redrive delivers to again. */
  queue: string;
  eventId: string | null;
  eventType: string | null;
  /** The order or user the event is about, when the message is a readable envelope. */
  aggregateId: string | null;
  correlationId: string | null;
  failureReason: string | null;
  attempts: number;
  status: DeadLetterStatus;
  parkedAt: string;
  redrivenAt: string | null;
  redrivenBy: string | null;
  redriveReason: string | null;
}

/** One dead letter with what it carried, read-only. */
export interface DeadLetterDetail extends DeadLetter {
  /** The message as received: parsed when it is JSON, its text otherwise. */
  body: unknown;
  headers: Record<string, unknown>;
}

export interface DeadLetterQuery {
  status?: DeadLetterStatus;
  queue?: string;
  /** Matches a correlation id, an aggregate (order or user) id or an event id, exactly. */
  q?: string;
  page: number;
  pageSize: number;
}

interface DeadLetterRow extends Row {
  id: string;
  queue: string;
  event_id: string | null;
  event_type: string | null;
  aggregate_id: string | null;
  correlation_id: string | null;
  failure_reason: string | null;
  attempts: number;
  body?: Uint8Array;
  properties?: Options.Publish & { headers?: Record<string, unknown> };
  parked_at: Date | string;
  redriven_at: Date | string | null;
  redriven_by: string | null;
  redrive_reason: string | null;
}

const LIST_COLUMNS = `id, queue, event_id, event_type, aggregate_id, correlation_id, failure_reason,
  attempts, parked_at, redriven_at, redriven_by, redrive_reason`;

const iso = (value: Date | string) => new Date(value).toISOString();

const toView = (r: DeadLetterRow): DeadLetter => ({
  id: r.id,
  queue: r.queue,
  eventId: r.event_id,
  eventType: r.event_type,
  aggregateId: r.aggregate_id,
  correlationId: r.correlation_id,
  failureReason: r.failure_reason,
  attempts: r.attempts,
  status: r.redriven_at ? 'REDRIVEN' : 'WAITING',
  parkedAt: iso(r.parked_at),
  redrivenAt: r.redriven_at ? iso(r.redriven_at) : null,
  redrivenBy: r.redriven_by,
  redriveReason: r.redrive_reason,
});

const text = (value: unknown, max = 200): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null;

/** The broker's own record of why a message was dead-lettered, when the platform did not add one. */
function brokerDeath(headers: Record<string, unknown>): { reason: string | null; count: number } {
  const deaths = headers['x-death'];
  const first = Array.isArray(deaths)
    ? (deaths[0] as Record<string, unknown> | undefined)
    : undefined;
  return {
    reason: text(first?.reason) ? `broker: ${String(first?.reason)}` : null,
    count: Number(first?.count) || 0,
  };
}

/** What to store of a dead-lettered message: its bytes and properties as received, and its identity. */
export function toDeadLetterRow(queue: string, message: ConsumeMessage) {
  const headers = { ...(message.properties.headers ?? {}) } as Record<string, unknown>;
  let envelope: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(message.content.toString('utf8'));
    if (parsed && typeof parsed === 'object') envelope = parsed as Record<string, unknown>;
  } catch {
    // Not JSON: stored as it came, and identified from its properties alone.
  }
  const death = brokerDeath(headers);
  return {
    id: randomUUID(),
    queue,
    eventId: text(envelope?.eventId) ?? text(message.properties.messageId),
    eventType: text(envelope?.eventType) ?? text(message.properties.type),
    aggregateId: text(envelope?.aggregateId),
    correlationId: text(envelope?.correlationId) ?? text(message.properties.correlationId),
    failureReason: text(headers[HEADER_FAILURE], 500) ?? death.reason,
    attempts: Number(headers[HEADER_ATTEMPT]) || death.count || 1,
    body: message.content,
    // Through JSON, so what is stored is exactly what a redrive can send back.
    properties: JSON.parse(JSON.stringify(message.properties)) as Record<string, unknown>,
  };
}

/** The message a redrive sends: the same bytes, the same identity, the attempts started again. */
export function redriveProperties(
  stored: Options.Publish & { headers?: Record<string, unknown> },
  deadLetterId: string,
): Options.Publish {
  const headers = { ...(stored.headers ?? {}) };
  for (const header of FAILURE_HEADERS) delete headers[header];
  headers[HEADER_REDRIVE_OF] = deadLetterId;
  return { ...stored, headers, persistent: true };
}

/**
 * Parks this service's dead letters and redrives them. Parking needs the broker; reading the table
 * does not, so a service without one can still show what was parked before.
 */
export class DeadLetters {
  private readonly logger = new Logger(DeadLetters.name);
  /** The channel the dead-letter queues are consumed on; a new one after every reconnect. */
  private consuming?: ConfirmChannel;

  constructor(
    private readonly db: Db,
    private readonly broker?: BrokerConnection,
    metrics?: Metrics,
  ) {
    if (broker) {
      broker.onConnected((channel) => this.consumeAll(channel));
      if (broker.isConnected()) void this.consumeAll(broker.getChannel());
    }
    metrics?.addGauge({
      name: 'foc_dead_letters_waiting',
      help: 'Dead letters parked for an operator and not yet redriven, by queue.',
      labelNames: ['queue'],
      collect: async (set) => {
        const { rows } = await this.db.query<{ queue: string; n: number }>(
          'SELECT queue, count(*)::int AS n FROM dead_letters WHERE redriven_at IS NULL GROUP BY queue',
        );
        const counts = new Map(rows.map((r) => [r.queue, r.n]));
        // Every dead-letter queue reads 0 until it has one, so the alert has a series to watch.
        for (const queue of new Set([...(broker?.durableQueues() ?? []), ...counts.keys()])) {
          set({ queue }, counts.get(queue) ?? 0);
        }
      },
    });
  }

  /** Newest first. */
  async list(
    query: DeadLetterQuery,
  ): Promise<{ page: number; pageSize: number; total: number; items: DeadLetter[] }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.status === 'WAITING') conditions.push('redriven_at IS NULL');
    if (query.status === 'REDRIVEN') conditions.push('redriven_at IS NOT NULL');
    if (query.queue) {
      params.push(query.queue);
      conditions.push(`queue = $${params.length}`);
    }
    if (query.q) {
      params.push(query.q);
      const p = `$${params.length}`;
      conditions.push(`(correlation_id = ${p} OR aggregate_id = ${p} OR event_id = ${p})`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const total = await this.db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM dead_letters ${where}`,
      params,
    );
    const { rows } = await this.db.query<DeadLetterRow>(
      `SELECT ${LIST_COLUMNS} FROM dead_letters ${where}
        ORDER BY parked_at DESC, id
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.pageSize, (query.page - 1) * query.pageSize],
    );
    return {
      page: query.page,
      pageSize: query.pageSize,
      total: total.rows[0]?.n ?? 0,
      items: rows.map(toView),
    };
  }

  async get(id: string): Promise<DeadLetterDetail> {
    const { rows } = await this.db.query<DeadLetterRow>(
      'SELECT * FROM dead_letters WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (!row) throw notFound();
    const raw = Buffer.from(row.body ?? new Uint8Array()).toString('utf8');
    let body: unknown = raw;
    try {
      body = JSON.parse(raw);
    } catch {
      // Shown as text: the bytes that failed are exactly what a redrive would send.
    }
    return { ...toView(row), body, headers: row.properties?.headers ?? {} };
  }

  /**
   * Delivers the dead letter again, to its own queue only, unchanged: the stored bytes and
   * properties, with the failure headers removed so the consumer's attempts start again. Published
   * and confirmed by the broker before the redrive is recorded; if the record then fails, the
   * consumer's idempotency (its inbox) makes the second delivery a no-op. A dead letter is redriven
   * once; if it fails again it comes back as a new one.
   */
  async redrive(
    id: string,
    by: { actorId: string; reason: string; correlationId: string },
  ): Promise<DeadLetter> {
    const broker = this.broker;
    if (!broker?.isConnected()) {
      throw new ApiException(
        503,
        'BROKER_UNAVAILABLE',
        'The message broker is not connected, so nothing can be redriven yet. Try again shortly.',
      );
    }
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<DeadLetterRow>(
        'SELECT * FROM dead_letters WHERE id = $1 FOR UPDATE',
        [id],
      );
      const row = rows[0];
      if (!row) throw notFound();
      if (row.redriven_at) {
        throw new ApiException(
          409,
          'ALREADY_REDRIVEN',
          'This dead letter was already redriven. If it failed again, it is waiting as a new one.',
        );
      }
      await publishToQueue(
        broker.getChannel(),
        row.queue,
        Buffer.from(row.body ?? new Uint8Array()),
        redriveProperties(row.properties ?? {}, row.id),
      );
      const updated = await tx.query<DeadLetterRow>(
        `UPDATE dead_letters
            SET redriven_at = now(), redriven_by = $2, redrive_reason = $3, redrive_correlation_id = $4
          WHERE id = $1
          RETURNING ${LIST_COLUMNS}`,
        [row.id, by.actorId, by.reason, by.correlationId],
      );
      this.logger.warn({
        deadLetterId: row.id,
        queue: row.queue,
        eventId: row.event_id,
        actorId: by.actorId,
        correlationId: by.correlationId,
        msg: 'dead letter redriven',
      });
      return toView(updated.rows[0]!);
    });
  }

  /** Stores one dead-lettered message, then acknowledges it. Exposed for tests. */
  async park(channel: ConfirmChannel, queue: string, message: ConsumeMessage): Promise<void> {
    const row = toDeadLetterRow(queue, message);
    try {
      await insert(this.db, row);
    } catch (err) {
      this.logger.error({
        err,
        queue,
        eventId: row.eventId,
        msg: 'dead letter not parked; will retry',
      });
      // Most likely the database is down: give it a moment before the broker hands it back.
      const retry = setTimeout(() => {
        try {
          channel.nack(message, false, true);
        } catch {
          // The channel closed meanwhile; the broker redelivers it on the next one.
        }
      }, PARK_RETRY_MS);
      retry.unref?.();
      return;
    }
    channel.ack(message);
    this.logger.warn({
      deadLetterId: row.id,
      queue,
      eventId: row.eventId,
      eventType: row.eventType,
      correlationId: row.correlationId,
      reason: row.failureReason,
      msg: 'dead letter parked for an operator',
    });
  }

  private async consumeAll(channel: ConfirmChannel): Promise<void> {
    if (this.consuming === channel) return; // already consuming on this channel
    this.consuming = channel;
    for (const queue of this.broker?.durableQueues() ?? []) {
      const dlq = deadLetterQueueName(queue);
      await channel.prefetch(10);
      await channel.consume(dlq, (message) => {
        if (!message) {
          this.logger.warn(`Consumer for ${dlq} cancelled by the broker; resubscribing`);
          void channel.close().catch(() => undefined);
          return;
        }
        void this.park(channel, queue, message);
      });
    }
  }
}

const notFound = () => new ApiException(404, 'NOT_FOUND', 'No such dead letter.');

async function insert(db: Queryable, r: ReturnType<typeof toDeadLetterRow>): Promise<void> {
  await db.query(
    `INSERT INTO dead_letters
       (id, queue, event_id, event_type, aggregate_id, correlation_id, failure_reason, attempts,
        body, properties)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      r.id,
      r.queue,
      r.eventId,
      r.eventType,
      r.aggregateId,
      r.correlationId,
      r.failureReason,
      r.attempts,
      r.body,
      JSON.stringify(r.properties),
    ],
  );
}

/** Publishes to one queue by name through the default exchange, and waits for the broker's confirm. */
function publishToQueue(
  channel: ConfirmChannel,
  queue: string,
  body: Buffer,
  properties: Options.Publish,
): Promise<void> {
  return new Promise((resolve, reject) => {
    channel.publish('', queue, body, properties, (err) => (err ? reject(err) : resolve()));
  });
}

// ---- The admin routes' inputs, shared by every service that mounts them ----------------------

const deadLetterQuerySchema = z.strictObject({
  status: z.enum(['WAITING', 'REDRIVEN']).optional(),
  queue: z.string().min(1).max(200).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const redriveSchema = z.strictObject({ reason: z.string().trim().min(1).max(500) });

function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  throw new ApiException(
    422,
    'VALIDATION_FAILED',
    'One or more fields are invalid.',
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(root)',
      code: 'INVALID',
      message: issue.message,
    })),
  );
}

/** `GET /admin/dead-letters` query: `status`, `queue`, `q` (a correlation, order or event id), paging. */
export const parseDeadLetterQuery = (query: unknown): DeadLetterQuery =>
  parseOrThrow(deadLetterQuerySchema, query);

/** A dead letter's id from the path. */
export function parseDeadLetterId(id: string): string {
  if (!z.uuid().safeParse(id).success) throw notFound();
  return id;
}

/** `POST /admin/dead-letters/{id}/redrive` body: the operator's reason, kept with the redrive. */
export const parseRedriveReason = (body: unknown): string =>
  parseOrThrow(redriveSchema, body).reason;

export const DEAD_LETTERS = Symbol('DEAD_LETTERS');

/**
 * The dead letters as a Nest provider, over the service's own database. The broker is optional:
 * without one, parked dead letters can still be read, and a redrive answers 503.
 *
 *   providers: [provideDeadLetters({ db: RAW_DB })]
 */
export function provideDeadLetters(options: { db: InjectionToken }): FactoryProvider<DeadLetters> {
  return {
    provide: DEAD_LETTERS,
    useFactory: (db: Db, broker?: BrokerConnection, metrics?: Metrics) =>
      new DeadLetters(db, broker, metrics),
    inject: [options.db, { token: BROKER, optional: true }, { token: METRICS, optional: true }],
  };
}
