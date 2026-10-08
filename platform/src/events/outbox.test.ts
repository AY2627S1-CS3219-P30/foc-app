import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Logger, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db, Queryable, Row } from '../db.js';
import { Metrics } from '../metrics.js';
import { EVENTS, PAYLOAD_SCHEMAS, userStatusChangedPayload } from './catalogue.js';
import type { BrokerConnection } from './connection.js';
import { parseEnvelope, type Envelope } from './envelope.js';
import { EVENT_PUBLISHER } from './events.module.js';
import { INBOX_TABLE_SQL, processOnce } from './inbox.js';
import {
  OUTBOX_RELAY,
  OUTBOX_TABLE_SQL,
  OutboxRelay,
  insertOutboxEvent,
  provideOutboxRelay,
} from './outbox.js';
import { EventPublisher } from './publisher.js';
import { EXCHANGE } from './topology.js';

/** Runs the real outbox SQL on PGlite (PostgreSQL compiled to WASM). */
async function outboxDb(): Promise<Db> {
  const pg = await PGlite.create();
  const wrap = (q: Pick<PGlite, 'query' | 'exec'>): Queryable => ({
    query: async <T extends Row = Row>(sql: string, params?: unknown[]) => ({
      rows: (await q.query<T>(sql, params)).rows,
    }),
    exec: async (sql) => {
      await q.exec(sql);
    },
  });
  const db: Db = {
    ...wrap(pg),
    transaction: (fn) => pg.transaction((t) => fn(wrap(t))),
    close: () => pg.close(),
  };
  await db.exec(OUTBOX_TABLE_SQL);
  await db.exec(INBOX_TABLE_SQL);
  return db;
}

interface Sent {
  exchange: string;
  routingKey: string;
  messageId: string;
  body: Buffer;
  envelope: Envelope;
}

/**
 * The real EventPublisher over a fake confirm channel: every message is
 * recorded exactly as it would go on the wire, and `failWhen` makes the broker
 * refuse (nack) a message.
 */
function fakeBroker() {
  const sent: Sent[] = [];
  let failWhen: ((e: Envelope) => boolean) | undefined;
  const channel = {
    publish(
      exchange: string,
      routingKey: string,
      body: Buffer,
      options: { messageId: string },
      cb: (err: Error | null) => void,
    ) {
      const envelope = JSON.parse(body.toString('utf8')) as Envelope;
      if (failWhen?.(envelope)) {
        cb(new Error('broker nacked the message'));
        return true;
      }
      sent.push({ exchange, routingKey, messageId: options.messageId, body, envelope });
      cb(null);
      return true;
    },
  };
  const broker = { getChannel: () => channel } as unknown as BrokerConnection;
  return {
    sent,
    publisher: new EventPublisher(broker, 'test-service'),
    fail(when: ((e: Envelope) => boolean) | undefined) {
      failWhen = when;
    },
  };
}

const quietLogger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

const suspension = (userId: string) => ({
  eventType: EVENTS.USER_SUSPENDED,
  aggregateId: userId,
  correlationId: `corr-${userId}`,
  payload: {
    userId,
    status: 'SUSPENDED' as const,
    reasonRef: 'audit-1',
    occurredAt: new Date().toISOString(),
  },
});

/** Commits one event on its own, as a service would alongside its state change. */
const commit = (db: Db, userId: string, extra: { id?: string; causationId?: string } = {}) =>
  db.transaction((tx) => insertOutboxEvent(tx, { ...suspension(userId), ...extra }));

const outbox = async (db: Db) =>
  (
    await db.query<{
      id: string;
      published_at: Date | null;
      attempts: number;
      last_error: string | null;
      retry_in_ms: number;
    }>(
      `SELECT id, published_at, attempts, last_error,
              (extract(epoch FROM next_attempt_at - now()) * 1000)::float8 AS retry_in_ms
         FROM outbox_events ORDER BY seq`,
    )
  ).rows;

/** Lets a row's backoff lapse, as if the clock had moved on. */
const lapseBackoff = (db: Db) => db.exec('UPDATE outbox_events SET next_attempt_at = now()');

beforeAll(() => {
  // EventPublisher logs every publish through Nest's static logger.
  Logger.overrideLogger(false);
});

describe('insertOutboxEvent', () => {
  it('writes the event in the caller’s transaction and returns its id', async () => {
    const db = await outboxDb();
    const id = await commit(db, 'user-1');
    const { rows } = await db.query('SELECT * FROM outbox_events');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      event_type: 'user.suspended',
      schema_version: 1,
      aggregate_id: 'user-1',
      correlation_id: 'corr-user-1',
      causation_id: null,
      published_at: null,
      attempts: 0,
    });
    await db.close();
  });

  it('rolls back with the change it describes, so the event exists exactly when the change does', async () => {
    const db = await outboxDb();
    await expect(
      db.transaction(async (tx) => {
        await insertOutboxEvent(tx, suspension('user-1'));
        throw new Error('the state change failed');
      }),
    ).rejects.toThrow('the state change failed');
    expect(await outbox(db)).toEqual([]);
    await db.close();
  });

  it('refuses a payload the catalogue would not accept, failing the change instead of a consumer', async () => {
    const db = await outboxDb();
    const { occurredAt: _, ...withoutTime } = suspension('user-1').payload;
    await expect(
      db.transaction((tx) =>
        insertOutboxEvent(tx, {
          ...suspension('user-1'),
          payload: withoutTime as never,
        }),
      ),
    ).rejects.toThrow(/occurredAt/);
    expect(await outbox(db)).toEqual([]);
    await db.close();
  });
});

describe('OutboxRelay', () => {
  let relays: OutboxRelay[] = [];
  const relay = (db: Db, publisher: EventPublisher, options = {}) => {
    const r = new OutboxRelay({ db, publisher, logger: quietLogger(), ...options });
    relays.push(r);
    return r;
  };
  afterEach(async () => {
    await Promise.all(relays.map((r) => r.stop()));
    relays = [];
  });

  it('publishes an event committed while no relay was running, once, after a restart', async () => {
    const db = await outboxDb();
    const broker = fakeBroker();
    // The service committed and then crashed before anything published.
    const id = await commit(db, 'user-1');

    // A fresh relay, as on the next boot.
    const restarted = relay(db, broker.publisher);
    expect(await restarted.tick()).toBe(1);
    expect(await restarted.tick()).toBe(0);

    expect(broker.sent.map((m) => m.envelope.eventId)).toEqual([id]);
    const [row] = await outbox(db);
    expect(row!.published_at).toBeInstanceOf(Date);
    expect(row!.attempts).toBe(1);
    await db.close();
  });

  it('sends the row as the envelope: its id, time, type, aggregate and correlation survive', async () => {
    const db = await outboxDb();
    const broker = fakeBroker();
    const id = await commit(db, 'user-7', { causationId: 'request-3' });
    const { rows } = await db.query<{ occurred_at: Date }>('SELECT occurred_at FROM outbox_events');

    await relay(db, broker.publisher).tick();

    const [msg] = broker.sent;
    expect(msg!.exchange).toBe(EXCHANGE);
    expect(msg!.routingKey).toBe('user.suspended');
    expect(msg!.messageId).toBe(id);
    // Exactly what a consumer subscribed to user.suspended would parse.
    const received = parseEnvelope(msg!.body, userStatusChangedPayload);
    expect(received).toMatchObject({
      eventId: id,
      eventType: 'user.suspended',
      schemaVersion: 1,
      aggregateId: 'user-7',
      occurredAt: rows[0]!.occurred_at.toISOString(),
      producer: 'test-service',
      correlationId: 'corr-user-7',
      causationId: 'request-3',
    });
    expect(received.payload.userId).toBe('user-7');
    await db.close();
  });

  it('keeps a row the broker refused, records why, backs off, then publishes it on a later tick', async () => {
    const db = await outboxDb();
    const broker = fakeBroker();
    const logger = quietLogger();
    const r = new OutboxRelay({ db, publisher: broker.publisher, logger, backoffMs: 60_000 });
    relays.push(r);
    const id = await commit(db, 'user-1');

    broker.fail(() => true);
    expect(await r.tick()).toBe(0);
    let [row] = await outbox(db);
    expect(row).toMatchObject({ id, published_at: null, attempts: 1 });
    expect(row!.last_error).toMatch(/nacked/);
    expect(row!.retry_in_ms).toBeGreaterThan(50_000);
    expect(r.stats.failed).toBe(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: id,
        attempts: 1,
        msg: 'outbox publish failed; will retry',
      }),
    );

    // The broker is back, but the row is still backing off.
    broker.fail(undefined);
    expect(await r.tick()).toBe(0);

    await lapseBackoff(db);
    expect(await r.tick()).toBe(1);
    [row] = await outbox(db);
    expect(row).toMatchObject({ attempts: 2, last_error: null });
    expect(row!.published_at).toBeInstanceOf(Date);
    expect(broker.sent.map((m) => m.envelope.eventId)).toEqual([id]);
    await db.close();
  });

  it('doubles the backoff per failed attempt, up to the ceiling', async () => {
    const db = await outboxDb();
    const broker = fakeBroker();
    broker.fail(() => true);
    const r = relay(db, broker.publisher, { backoffMs: 1_000, maxBackoffMs: 4_000 });
    await commit(db, 'user-1');

    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      await r.tick();
      delays.push(Math.round((await outbox(db))[0]!.retry_in_ms / 1000));
      await lapseBackoff(db);
    }
    expect(delays).toEqual([1, 2, 4, 4]);
    await db.close();
  });

  it('treats a publish the broker never confirms as a failure rather than waiting forever', async () => {
    const db = await outboxDb();
    const hung = { publish: () => new Promise<never>(() => undefined) };
    const r = relay(db, hung as unknown as EventPublisher, { publishTimeoutMs: 20 });
    await commit(db, 'user-1');

    expect(await r.tick()).toBe(0);
    expect((await outbox(db))[0]!.last_error).toMatch(/did not confirm within 20 ms/);
    await db.close();
  });

  it('keeps one aggregate’s events in order while a failure holds it back, without holding up others', async () => {
    const db = await outboxDb();
    const broker = fakeBroker();
    const r = relay(db, broker.publisher, { backoffMs: 60_000 });
    const x1 = await commit(db, 'user-x');
    const x2 = await commit(db, 'user-x');
    const y1 = await commit(db, 'user-y');

    broker.fail((e) => e.eventId === x1);
    await r.tick(); // x1 fails; the claim stops there
    await r.tick(); // x1 is backing off, so x2 waits; y1 goes
    expect(broker.sent.map((m) => m.envelope.eventId)).toEqual([y1]);

    broker.fail(undefined);
    await lapseBackoff(db);
    await r.tick();
    expect(broker.sent.map((m) => m.envelope.eventId)).toEqual([y1, x1, x2]);
    await db.close();
  });

  it('drains a burst for one aggregate in a single tick, in the order it was written', async () => {
    const db = await outboxDb();
    const broker = fakeBroker();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await commit(db, 'user-1'));
    // Several events in one transaction keep their insertion order too.
    const sameTx = await db.transaction(async (tx) => [
      await insertOutboxEvent(tx, suspension('user-1')),
      await insertOutboxEvent(tx, suspension('user-1')),
    ]);

    expect(await relay(db, broker.publisher).tick()).toBe(7);
    expect(broker.sent.map((m) => m.envelope.eventId)).toEqual([...ids, ...sameTx]);
    await db.close();
  });

  it('does not let two relays publish the same row', async () => {
    const db = await outboxDb();
    const broker = fakeBroker();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add(await commit(db, `user-${i % 7}`));

    // PGlite is a single connection and runs one transaction at a time, so the
    // two relays' claims interleave rather than overlap: this proves a relay
    // skips what another has already marked, and that the drain loops stop
    // cleanly. True lock contention (FOR UPDATE SKIP LOCKED against concurrent
    // claims) is exercised on real PostgreSQL in outbox.postgres.test.ts.
    const [a, b] = await Promise.all([
      relay(db, broker.publisher, { batchSize: 5 }).tick(),
      relay(db, broker.publisher, { batchSize: 5 }).tick(),
    ]);

    expect(a + b).toBe(50);
    const sent = broker.sent.map((m) => m.envelope.eventId);
    expect(sent).toHaveLength(50);
    expect(new Set(sent)).toEqual(ids);
    await db.close();
  });

  it('never publishes a row the catalogue does not describe, and says why', async () => {
    const db = await outboxDb();
    const broker = fakeBroker();
    // A row written around insertOutboxEvent, e.g. by a hand-written data migration.
    await db.query(
      `INSERT INTO outbox_events (id, event_type, aggregate_id, payload, correlation_id)
       VALUES ($1, 'UserSuspended', 'user-1', '{}'::jsonb, 'corr')`,
      [randomUUID()],
    );

    await relay(db, broker.publisher).tick();
    expect(broker.sent).toEqual([]);
    expect((await outbox(db))[0]!.last_error).toMatch(/UserSuspended has no payload schema/);
    await db.close();
  });

  it('republishes after a crash between the broker’s confirmation and the commit, and the inbox applies it once', async () => {
    const db = await outboxDb();
    const broker = fakeBroker();
    const id = await commit(db, 'user-1');

    // Failure injection: the relay's database connection dies right after the
    // broker confirmed, so marking the row published never commits.
    const crashing: Db = {
      ...db,
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            ...tx,
            query: async (sql, params) => {
              if (sql.includes('SET published_at')) throw new Error('connection terminated');
              return tx.query(sql, params);
            },
          }),
        ),
    };
    await expect(relay(crashing, broker.publisher).tick()).rejects.toThrow('connection terminated');
    expect((await outbox(db))[0]!.published_at).toBeNull();

    // The next relay sends it again, under the same id.
    await relay(db, broker.publisher).tick();
    expect(broker.sent.map((m) => m.envelope.eventId)).toEqual([id, id]);

    // A consumer using the inbox applies the event once for both copies.
    await db.exec('CREATE TABLE suspensions_seen (user_id text NOT NULL)');
    const applied = [];
    for (const msg of broker.sent) {
      const event = parseEnvelope(msg.body, PAYLOAD_SCHEMAS[EVENTS.USER_SUSPENDED]);
      applied.push(
        await processOnce(db, 'test-consumer', event, async (tx) => {
          await tx.query('INSERT INTO suspensions_seen (user_id) VALUES ($1)', [
            event.payload.userId,
          ]);
        }),
      );
    }
    expect(applied).toEqual([true, false]);
    expect((await db.query('SELECT * FROM suspensions_seen')).rows).toHaveLength(1);
    await db.close();
  });

  it('reports what it published, what failed, and the age of the backlog', async () => {
    const db = await outboxDb();
    const broker = fakeBroker();
    const logger = quietLogger();
    const r = new OutboxRelay({ db, publisher: broker.publisher, logger });
    relays.push(r);
    await commit(db, 'user-1');
    const stuck = await commit(db, 'user-2');
    await db.query(
      `UPDATE outbox_events SET occurred_at = now() - interval '5 minutes' WHERE id = $1`,
      [stuck],
    );
    broker.fail((e) => e.eventId === stuck);

    await r.tick(); // user-1 goes; user-2 is refused
    await lapseBackoff(db);
    await r.tick(); // user-2 is refused again

    const stats = await r.logStats();
    expect(stats).toMatchObject({ published: 1, failed: 2, backlog: 1 });
    expect(stats.oldestUnpublishedAgeMs).toBeGreaterThanOrEqual(5 * 60_000);
    expect(r.stats).toEqual(stats);
    expect(logger.log).toHaveBeenCalledWith(
      expect.objectContaining({ published: 1, backlog: 1, msg: 'outbox relay stats' }),
    );
    await db.close();
  });

  it('logs the backlog on its first poll, then only every statsIntervalMs', async () => {
    const db = await outboxDb();
    const logger = quietLogger();
    const r = new OutboxRelay({ db, publisher: fakeBroker().publisher, logger });
    relays.push(r);

    await r.tick();
    await r.tick();
    const statsLines = logger.log.mock.calls.filter(([l]) => l.msg === 'outbox relay stats');
    expect(statsLines).toHaveLength(1);
    expect(statsLines[0]![0]).toMatchObject({ backlog: 0, oldestUnpublishedAgeMs: 0 });
    await db.close();
  });

  it('polls once started, and stops publishing once stopped', async () => {
    const db = await outboxDb();
    const broker = fakeBroker();
    const r = relay(db, broker.publisher, { intervalMs: 5 });
    r.start();

    const first = await commit(db, 'user-1');
    await vi.waitFor(() => expect(broker.sent).toHaveLength(1), { timeout: 5_000 });
    expect(broker.sent[0]!.envelope.eventId).toBe(first);

    await r.stop();
    await commit(db, 'user-2');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(broker.sent).toHaveLength(1);
    await db.close();
  });
});

describe('provideOutboxRelay', () => {
  it('starts the relay on application bootstrap and stops it on shutdown', async () => {
    const db = await outboxDb();
    const broker = fakeBroker();
    const DB = Symbol('DB');
    class AppModule {}
    Module({
      providers: [
        { provide: DB, useValue: db },
        { provide: EVENT_PUBLISHER, useValue: broker.publisher },
        provideOutboxRelay({ db: DB, intervalMs: 5, logger: quietLogger() }),
      ],
    })(AppModule);

    await commit(db, 'user-1');
    const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    await app.init();
    expect(app.get(OUTBOX_RELAY)).toBeInstanceOf(OutboxRelay);
    await vi.waitFor(() => expect(broker.sent).toHaveLength(1), { timeout: 5_000 });

    await app.close();
    await commit(db, 'user-2');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(broker.sent).toHaveLength(1);
    await db.close();
  });
});

describe('OutboxRelay metrics (PLT-04)', () => {
  const sample = (text: string, metric: string): number => {
    const line = text
      .split('\n')
      .find((l) => l.startsWith(`${metric}{`) || l.startsWith(`${metric} `));
    return Number(line?.split(' ').at(-1));
  };

  it('counts what the broker confirmed and what it refused', async () => {
    const db = await outboxDb();
    const broker = fakeBroker();
    const metrics = new Metrics('test-service');
    const relay = new OutboxRelay({
      db,
      publisher: broker.publisher,
      logger: quietLogger(),
      metrics,
    });
    await commit(db, 'user-1');
    await commit(db, 'user-2');
    broker.fail((e) => e.aggregateId === 'user-2');

    await relay.tick();

    const text = await metrics.render();
    expect(sample(text, 'foc_outbox_published_total')).toBe(1);
    expect(sample(text, 'foc_outbox_publish_failures_total')).toBe(1);
    await relay.stop();
    await db.close();
  });

  it('reports the backlog and the age of its oldest row as they are when scraped', async () => {
    const db = await outboxDb();
    const broker = fakeBroker();
    const metrics = new Metrics('test-service');
    const relay = new OutboxRelay({
      db,
      publisher: broker.publisher,
      logger: quietLogger(),
      metrics,
    });
    await commit(db, 'user-1');
    await commit(db, 'user-2');

    let text = await metrics.render();
    expect(sample(text, 'foc_outbox_backlog')).toBe(2);
    expect(sample(text, 'foc_outbox_oldest_unpublished_age_seconds')).toBeGreaterThanOrEqual(0);

    await relay.tick();
    text = await metrics.render();
    expect(sample(text, 'foc_outbox_backlog')).toBe(0);
    expect(sample(text, 'foc_outbox_oldest_unpublished_age_seconds')).toBe(0);
    await relay.stop();
    await db.close();
  });
});
