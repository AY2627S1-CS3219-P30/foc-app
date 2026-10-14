import { PGlite } from '@electric-sql/pglite';
import amqp from 'amqplib';
import { afterAll, describe, expect, it } from 'vitest';
import type { Db, Queryable, Row } from '../db.js';
import { userActivatedPayload } from './catalogue.js';
import { BrokerConnection } from './connection.js';
import { EventConsumer } from './consumer.js';
import { DEAD_LETTERS_TABLE_SQL, DeadLetters, HEADER_REDRIVE_OF } from './dead-letters.js';
import { EventPublisher } from './publisher.js';
import { deadLetterQueueName, retryExchangeName, retryQueueName } from './topology.js';

/**
 * PLT-05 against the real broker: a message that fails every attempt reaches its dead-letter queue,
 * is parked in the database and acknowledged there, and a redrive puts it back on the queue it
 * failed on, where it is handled. Skipped unless RABBITMQ_URL is set (see broker.integration.test.ts).
 */
const URL = process.env.RABBITMQ_URL;
const suite = URL ? describe : describe.skip;

const RUN = Math.random().toString(36).slice(2, 8);
const NAMESPACE = `test-${RUN}-dead-letters`;
const QUEUE = `foc.test-${RUN}.dead-letters`;
const DELAYS = [60, 60];

async function deadLetterDb(): Promise<Db> {
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
  await db.exec(DEAD_LETTERS_TABLE_SQL);
  return db;
}

const waitFor = async <T>(fn: () => Promise<T | undefined> | T | undefined, ms = 15_000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};

suite('dead letters against the real broker (PLT-05)', () => {
  let broker: BrokerConnection | undefined;
  let db: Db | undefined;

  afterAll(async () => {
    await broker?.close();
    await db?.close();
    if (!URL) return;
    const conn = await amqp.connect(URL);
    try {
      const ch = await conn.createChannel();
      await ch.deleteQueue(QUEUE);
      await ch.deleteQueue(deadLetterQueueName(QUEUE));
      for (let attempt = 1; attempt <= DELAYS.length; attempt += 1) {
        await ch.deleteQueue(retryQueueName(NAMESPACE, attempt));
        await ch.deleteExchange(retryExchangeName(NAMESPACE, attempt));
      }
    } finally {
      await conn.close();
    }
  });

  it('parks a message that failed every attempt, and redrives it unchanged', async () => {
    db = await deadLetterDb();
    broker = new BrokerConnection(
      URL as string,
      NAMESPACE,
      [{ queue: QUEUE, routingKeys: [`test.dead-letters-${RUN}`] }],
      DELAYS,
    );
    const letters = new DeadLetters(db, broker);
    const handled: Array<{ attempt: number; eventId: string }> = [];
    let fixed = false;
    await broker.connect();
    await new EventConsumer(broker).subscribe({
      queue: QUEUE,
      eventType: `test.dead-letters-${RUN}`,
      payloadSchema: userActivatedPayload,
      handler: (envelope, ctx) => {
        if (!fixed) throw new Error('dependency down');
        handled.push({ attempt: ctx.attempt, eventId: envelope.eventId });
      },
    });

    const sent = await new EventPublisher(broker, 'test').publish({
      eventType: `test.dead-letters-${RUN}`,
      schemaVersion: 1,
      aggregateId: 'user-77',
      correlationId: `dead-letter-trace-${RUN}`,
      payload: { userId: 'user-77', activatedAt: new Date().toISOString() },
    });

    const parked = await waitFor(async () => {
      const page = await letters.list({ status: 'WAITING', page: 1, pageSize: 10 });
      return page.items[0];
    });
    expect(parked).toMatchObject({
      queue: QUEUE,
      eventId: sent.eventId,
      correlationId: `dead-letter-trace-${RUN}`,
      attempts: DELAYS.length + 1,
      failureReason: 'dependency down',
    });
    // Acknowledged once parked: the dead-letter queue does not hold it as well.
    const depth = await waitFor(async () => {
      const { messageCount } = await broker!.getChannel().checkQueue(deadLetterQueueName(QUEUE));
      return messageCount === 0 ? messageCount : undefined;
    });
    expect(depth).toBe(0);
    expect(handled).toEqual([]);

    fixed = true;
    const done = await letters.redrive(parked.id, {
      actorId: 'admin-1',
      reason: 'dependency restored',
      correlationId: 'operator-trace',
    });
    expect(done.status).toBe('REDRIVEN');

    const [delivery] = await waitFor(() => (handled.length ? handled : undefined));
    // The same event, its attempts started again; the parked copy keeps what it failed with.
    expect(delivery).toEqual({ attempt: 1, eventId: sent.eventId });
    const kept = await letters.get(parked.id);
    expect(kept.headers).not.toHaveProperty(HEADER_REDRIVE_OF);
    expect(kept.status).toBe('REDRIVEN');
  }, 40_000);
});
