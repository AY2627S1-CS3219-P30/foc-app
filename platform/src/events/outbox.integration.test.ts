import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db, Queryable, Row } from '../db.js';
import { EVENTS, userStatusChangedPayload, type UserStatusChangedPayload } from './catalogue.js';
import { BrokerConnection } from './connection.js';
import { EventConsumer } from './consumer.js';
import { INBOX_TABLE_SQL, withInbox } from './inbox.js';
import { OUTBOX_TABLE_SQL, OutboxRelay, insertOutboxEvent } from './outbox.js';
import { EventPublisher } from './publisher.js';
import { deadLetterQueueName } from './topology.js';

/**
 * The outbox and inbox end to end through a real broker: a committed row is
 * relayed, a consumer applies it through the inbox, and a second copy of the
 * same row (the relay crashed before marking it) changes nothing. Skipped
 * unless RABBITMQ_URL is set, like broker.integration.test.ts:
 *
 *   docker compose up -d rabbitmq
 *   RABBITMQ_URL=amqp://foc:foc_dev@localhost:55672 npm test -w @foc/platform
 */
const URL = process.env.RABBITMQ_URL;
const suite = URL ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
const QUEUE = `foc.test-${RUN}.outbox`;
const USER = `user-${RUN}`;

const waitFor = async (condition: () => boolean, ms = 8000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a delivery');
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function pgliteDb(): Promise<Db> {
  const pg = await PGlite.create();
  const wrap = (q: Pick<PGlite, 'query' | 'exec'>): Queryable => ({
    query: async <T extends Row = Row>(sql: string, params?: unknown[]) => ({
      rows: (await q.query<T>(sql, params)).rows,
    }),
    exec: async (sql) => {
      await q.exec(sql);
    },
  });
  return {
    ...wrap(pg),
    transaction: (fn) => pg.transaction((t) => fn(wrap(t))),
    close: () => pg.close(),
  };
}

suite('outbox and inbox through the broker', () => {
  let broker: BrokerConnection;
  let db: Db;

  beforeAll(async () => {
    broker = new BrokerConnection(
      URL as string,
      `test-${RUN}-outbox`,
      [{ queue: QUEUE, routingKeys: [EVENTS.USER_SUSPENDED] }],
      [60, 60],
    );
    await broker.connect();
    db = await pgliteDb();
    await db.exec(OUTBOX_TABLE_SQL);
    await db.exec(INBOX_TABLE_SQL);
    await db.exec('CREATE TABLE suspensions_seen (user_id text NOT NULL)');
  }, 30_000);

  afterAll(async () => {
    try {
      const ch = broker.getChannel();
      await ch.deleteQueue(QUEUE);
      await ch.deleteQueue(deadLetterQueueName(QUEUE));
    } catch {
      /* already gone */
    }
    await broker?.close();
    await db?.close();
  });

  it('applies a relayed event once, even when the relay sends it twice', async () => {
    let handled = 0;
    const apply = withInbox<UserStatusChangedPayload>(db, QUEUE, async (event, tx) => {
      await tx.query('INSERT INTO suspensions_seen (user_id) VALUES ($1)', [event.payload.userId]);
    });
    await new EventConsumer(broker).subscribe({
      queue: QUEUE,
      eventType: EVENTS.USER_SUSPENDED,
      payloadSchema: userStatusChangedPayload,
      handler: async (envelope, context) => {
        if (envelope.aggregateId !== USER) return; // another run's message
        await apply(envelope, context);
        handled += 1;
      },
    });

    const id = await db.transaction((tx) =>
      insertOutboxEvent(tx, {
        eventType: EVENTS.USER_SUSPENDED,
        aggregateId: USER,
        correlationId: `outbox-${RUN}`,
        payload: { userId: USER, status: 'SUSPENDED', occurredAt: new Date().toISOString() },
      }),
    );
    const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const relay = new OutboxRelay({
      db,
      publisher: new EventPublisher(broker, 'user-service'),
      logger: quiet,
    });

    expect(await relay.tick()).toBe(1);
    await waitFor(() => handled >= 1);

    // As if the relay had crashed after the broker confirmed, before its mark committed.
    await db.query('UPDATE outbox_events SET published_at = NULL WHERE id = $1', [id]);
    expect(await relay.tick()).toBe(1);
    await waitFor(() => handled >= 2);

    expect((await db.query('SELECT * FROM suspensions_seen')).rows).toHaveLength(1);
    const { rows } = await db.query('SELECT event_id FROM processed_events WHERE consumer = $1', [
      QUEUE,
    ]);
    expect(rows).toEqual([{ event_id: id }]);
  }, 20_000);
});
