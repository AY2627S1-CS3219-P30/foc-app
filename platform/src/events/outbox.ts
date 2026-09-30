import { randomUUID } from 'node:crypto';
import {
  Logger,
  type BeforeApplicationShutdown,
  type FactoryProvider,
  type InjectionToken,
  type LoggerService,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { z } from 'zod';
import type { Db, Queryable } from '../db.js';
import { PAYLOAD_SCHEMAS } from './catalogue.js';
import { EVENT_PUBLISHER } from './events.module.js';
import type { EventPublisher } from './publisher.js';

/**
 * The transactional outbox (EVT-02).
 *
 * A service never publishes a state change straight to the broker: a crash
 * between its commit and the publish would lose the event, and a publish before
 * the commit could announce a change that then rolls back. Instead it writes
 * the event to `outbox_events` in the same transaction as the change
 * ({@link insertOutboxEvent}), and the {@link OutboxRelay} publishes committed
 * rows afterwards. The event exists exactly when the change does.
 *
 * Delivery is at least once: a relay that crashes after the broker confirmed a
 * row but before marking it published sends it again after restart. The row id
 * is the envelope's eventId on every attempt, so a consumer's inbox (inbox.ts)
 * recognises the repeat.
 */

/**
 * The outbox table, for a service to include in one of its own migrations:
 *
 *   { id: '002_outbox', sql: OUTBOX_TABLE_SQL }
 *
 * Frozen, like any migration: a database that has applied it never runs it
 * again, so editing it would leave old and new databases with different tables.
 * A change is a new exported snippet that alters this one.
 *
 * `seq` is insertion order, which the relay publishes in; `occurred_at` is what
 * the envelope reports. The User Service created its table before this snippet
 * existed and reached the same columns through its migration 006.
 */
export const OUTBOX_TABLE_SQL = `
  CREATE TABLE outbox_events (
    id              uuid PRIMARY KEY,
    seq             bigint GENERATED ALWAYS AS IDENTITY,
    event_type      text NOT NULL,
    schema_version  integer NOT NULL DEFAULT 1,
    aggregate_id    text NOT NULL,
    payload         jsonb NOT NULL,
    correlation_id  text NOT NULL,
    causation_id    text,
    occurred_at     timestamptz NOT NULL DEFAULT now(),
    published_at    timestamptz,
    attempts        integer NOT NULL DEFAULT 0,
    last_error      text,
    next_attempt_at timestamptz NOT NULL DEFAULT now()
  );
  -- Only unpublished rows are ever scanned, so both stay as small as the backlog.
  CREATE INDEX outbox_events_pending_idx ON outbox_events (seq) WHERE published_at IS NULL;
  CREATE INDEX outbox_events_pending_aggregate_idx ON outbox_events (aggregate_id, seq)
    WHERE published_at IS NULL;
`;

/** Event types with an agreed payload schema: the only ones the outbox accepts. */
export type CataloguedEventType = keyof typeof PAYLOAD_SCHEMAS;

export interface NewOutboxEvent<K extends CataloguedEventType> {
  /** Defaults to a fresh UUID. It becomes the envelope's eventId, which consumers dedupe on. */
  id?: string;
  eventType: K;
  aggregateId: string;
  payload: z.input<(typeof PAYLOAD_SCHEMAS)[K]>;
  correlationId: string;
  /** The event or request that caused this one. Defaults to the correlation id. */
  causationId?: string;
  /** Defaults to 1. */
  schemaVersion?: number;
}

/**
 * Writes an event to the outbox in the caller's transaction, so it commits or
 * rolls back with the change it describes. Returns the event id.
 *
 * The payload is validated against the catalogue here: a shape a consumer
 * would dead-letter fails the change that produced it, instead of reaching the
 * broker.
 */
export async function insertOutboxEvent<K extends CataloguedEventType>(
  tx: Queryable,
  event: NewOutboxEvent<K>,
): Promise<string> {
  const id = event.id ?? randomUUID();
  const payload: unknown = PAYLOAD_SCHEMAS[event.eventType].parse(event.payload);
  await tx.query(
    `INSERT INTO outbox_events
       (id, event_type, schema_version, aggregate_id, payload, correlation_id, causation_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [
      id,
      event.eventType,
      event.schemaVersion ?? 1,
      event.aggregateId,
      JSON.stringify(payload),
      event.correlationId,
      event.causationId ?? null,
    ],
  );
  return id;
}

type OutboxRow = {
  id: string;
  event_type: string;
  schema_version: number;
  aggregate_id: string;
  payload: unknown;
  correlation_id: string;
  causation_id: string | null;
  occurred_at: Date | string;
  attempts: number;
};

/**
 * The next rows to publish, oldest first, locked for the claiming transaction.
 *
 * SKIP LOCKED lets several instances relay at once: each takes rows no other
 * holds, and none waits on another. A row that another instance published
 * after this snapshot was taken is re-checked when locked, fails
 * `published_at IS NULL`, and is left out, so no row is sent twice by two
 * healthy relays.
 *
 * A row also waits while an earlier row for the same aggregate is unpublished —
 * held by another instance, or backing off after a failure — so one aggregate's
 * events reach the broker in the order they were written: a release never
 * overtakes the reservation it releases. Other aggregates are not held up. The
 * cost is one row per aggregate per claim; {@link OutboxRelay.tick} claims
 * again until nothing is left. ("Written" is insertion order, which is the
 * order things happened as long as the producer locks the aggregate while it
 * changes it, as any state machine update must.)
 */
const CLAIM_SQL = `
  SELECT id, event_type, schema_version, aggregate_id, payload, correlation_id,
         causation_id, occurred_at, attempts
    FROM outbox_events o
   WHERE o.published_at IS NULL
     AND o.next_attempt_at <= now()
     AND NOT EXISTS (
           SELECT 1 FROM outbox_events earlier
            WHERE earlier.aggregate_id = o.aggregate_id
              AND earlier.published_at IS NULL
              AND earlier.seq < o.seq)
   ORDER BY o.seq
   LIMIT $1
   FOR UPDATE SKIP LOCKED`;

export interface OutboxRelayOptions {
  db: Db;
  /** The service's EventPublisher; anything with its `publish` will do. */
  publisher: Pick<EventPublisher, 'publish'>;
  /** Pause between polls once the outbox is drained. Default 500 ms. */
  intervalMs?: number;
  /** Rows claimed per transaction. Default 100. */
  batchSize?: number;
  /** Delay before a failed row is retried; doubles per attempt. Default 1 s. */
  backoffMs?: number;
  /** Ceiling on that delay. Default 60 s. */
  maxBackoffMs?: number;
  /** A publish the broker has not confirmed by then counts as failed. Default 10 s. */
  publishTimeoutMs?: number;
  /** How often the stats line is logged. Default 60 s. */
  statsIntervalMs?: number;
  logger?: Pick<LoggerService, 'log' | 'warn' | 'error'>;
}

export interface OutboxRelayStats {
  /** Events the broker confirmed since this relay was created. */
  published: number;
  /** Failed publish attempts since this relay was created. */
  failed: number;
  /** Unpublished rows when last sampled. Unset until the first sample. */
  backlog?: number;
  /** Age of the oldest unpublished row when last sampled; 0 when there was none. */
  oldestUnpublishedAgeMs?: number;
  sampledAt?: string;
}

/**
 * Publishes committed outbox rows to the broker.
 *
 * Each claim is one transaction: lock the next rows, publish each and await
 * the broker's confirmation, mark it published, commit. A failed publish stops
 * the claim — the broker is usually the problem, not the row — and records the
 * attempt, the error and a backoff on that row, which stays unpublished for a
 * later tick. Nothing is ever dropped: a row the relay cannot publish stays in
 * the backlog, holding back later events for its aggregate, and the stats line
 * shows its age.
 *
 * Polls every `intervalMs` from {@link start} (Nest calls it on bootstrap)
 * until {@link stop}, and drains everything claimable on each poll. Metrics
 * are structured log lines — `outbox relay stats` every `statsIntervalMs`, and
 * one warning per failed attempt — plus {@link stats} for a caller.
 */
export class OutboxRelay implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly db: Db;
  private readonly publisher: Pick<EventPublisher, 'publish'>;
  private readonly logger: Pick<LoggerService, 'log' | 'warn' | 'error'>;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly publishTimeoutMs: number;
  private readonly statsIntervalMs: number;

  private readonly counters: OutboxRelayStats = { published: 0, failed: 0 };
  private lastStatsAt = 0;
  private running = false;
  private stopping = false;
  private timer?: NodeJS.Timeout;
  private loop?: Promise<void>;

  constructor(options: OutboxRelayOptions) {
    this.db = options.db;
    this.publisher = options.publisher;
    this.logger = options.logger ?? new Logger(OutboxRelay.name);
    this.intervalMs = options.intervalMs ?? 500;
    this.batchSize = options.batchSize ?? 100;
    this.backoffMs = options.backoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.publishTimeoutMs = options.publishTimeoutMs ?? 10_000;
    this.statsIntervalMs = options.statsIntervalMs ?? 60_000;
  }

  get stats(): OutboxRelayStats {
    return { ...this.counters };
  }

  /** Starts polling. The first poll is immediate, so rows left by a crash go out at boot. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.logger.log({ intervalMs: this.intervalMs, msg: 'outbox relay started' });
    this.schedule(0);
  }

  /** Stops polling and waits for an in-flight claim to commit. */
  async stop(): Promise<void> {
    this.running = false;
    this.stopping = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await this.loop;
  }

  onApplicationBootstrap(): void {
    this.start();
  }

  /** Before the broker and the pool close in their own shutdown hooks. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /**
   * Publishes everything claimable now, one claim after another, and returns
   * how many rows went out. Stops at the first failure, which the next tick
   * retries once the row's backoff has passed.
   */
  async tick(): Promise<number> {
    let total = 0;
    while (!this.stopping) {
      const { published, failed } = await this.claimAndPublish();
      total += published;
      this.counters.published += published;
      if (failed) this.counters.failed += 1;
      if (Date.now() - this.lastStatsAt >= this.statsIntervalMs) await this.logStats();
      if (failed || published === 0) break;
    }
    return total;
  }

  /** Samples the backlog, logs the stats line, and returns what it logged. */
  async logStats(): Promise<OutboxRelayStats> {
    const { rows } = await this.db.query<{ backlog: number; oldest_age_ms: number | null }>(
      `SELECT count(*)::int AS backlog,
              (extract(epoch FROM now() - min(occurred_at)) * 1000)::float8 AS oldest_age_ms
         FROM outbox_events
        WHERE published_at IS NULL`,
    );
    this.lastStatsAt = Date.now();
    this.counters.backlog = rows[0]?.backlog ?? 0;
    this.counters.oldestUnpublishedAgeMs = Math.max(0, Math.round(rows[0]?.oldest_age_ms ?? 0));
    this.counters.sampledAt = new Date(this.lastStatsAt).toISOString();
    this.logger.log({ ...this.counters, msg: 'outbox relay stats' });
    return this.stats;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.loop = this.tick()
        .then(() => undefined)
        .catch((err: unknown) => {
          // The database is unreachable or the claim did not commit. Nothing is
          // lost: its rows are still unpublished, and the next poll sends them
          // again under the same ids (the broker may already have some).
          this.logger.error({ err, msg: 'outbox relay poll failed' });
        })
        .finally(() => {
          this.loop = undefined;
          this.schedule(this.intervalMs);
        });
    }, delayMs);
    // The service's own server keeps the process alive; the relay must not.
    this.timer.unref();
  }

  private claimAndPublish(): Promise<{ published: number; failed: boolean }> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.query<OutboxRow>(CLAIM_SQL, [this.batchSize]);
      let published = 0;
      for (const row of rows) {
        try {
          await this.publish(row);
        } catch (err) {
          await this.recordFailure(tx, row, err);
          return { published, failed: true };
        }
        await tx.query(
          `UPDATE outbox_events
              SET published_at = now(), attempts = attempts + 1, last_error = NULL
            WHERE id = $1`,
          [row.id],
        );
        published += 1;
      }
      return { published, failed: false };
    });
  }

  private async publish(row: OutboxRow): Promise<void> {
    // Re-checked here as well as on insert: a row can also arrive by hand or by
    // data migration, and an unknown type would be silently unroutable.
    const schema = (PAYLOAD_SCHEMAS as Partial<Record<string, z.ZodType>>)[row.event_type];
    if (!schema) throw new Error(`${row.event_type} has no payload schema in the event catalogue`);
    const checked = schema.safeParse(row.payload);
    if (!checked.success) {
      throw new Error(
        `payload invalid: ${checked.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
      );
    }

    await withTimeout(
      this.publisher.publish({
        // The row's own identity, so every attempt is the same event to a consumer.
        eventId: row.id,
        occurredAt: new Date(row.occurred_at).toISOString(),
        eventType: row.event_type,
        schemaVersion: row.schema_version,
        aggregateId: row.aggregate_id,
        correlationId: row.correlation_id,
        causationId: row.causation_id ?? undefined,
        payload: row.payload,
      }),
      this.publishTimeoutMs,
    );
  }

  private async recordFailure(tx: Queryable, row: OutboxRow, err: unknown): Promise<void> {
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    const retryInMs = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** row.attempts);
    await tx.query(
      `UPDATE outbox_events
          SET attempts = attempts + 1, last_error = $2,
              next_attempt_at = now() + make_interval(secs => $3)
        WHERE id = $1`,
      [row.id, reason, retryInMs / 1000],
    );
    this.logger.warn({
      correlationId: row.correlation_id,
      eventId: row.id,
      eventType: row.event_type,
      attempts: row.attempts + 1,
      retryInMs,
      reason,
      msg: 'outbox publish failed; will retry',
    });
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`broker did not confirm within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export const OUTBOX_RELAY = Symbol('OUTBOX_RELAY');

/**
 * The relay as a Nest provider, started on application bootstrap (after every
 * module's init, so after the broker has connected and after `main.ts` has
 * migrated the schema) and stopped before the broker and the pool close.
 *
 * It injects EVENT_PUBLISHER, so register it only where EventsModule is
 * imported, from a module that can see the service's Db token:
 *
 *   providers: env.RABBITMQ_URL ? [provideOutboxRelay({ db: DB })] : []
 */
export function provideOutboxRelay(
  options: { db: InjectionToken } & Omit<OutboxRelayOptions, 'db' | 'publisher'>,
): FactoryProvider<OutboxRelay> {
  const { db, ...rest } = options;
  return {
    provide: OUTBOX_RELAY,
    useFactory: (database: Db, publisher: EventPublisher) =>
      new OutboxRelay({ ...rest, db: database, publisher }),
    inject: [db, EVENT_PUBLISHER],
  };
}
