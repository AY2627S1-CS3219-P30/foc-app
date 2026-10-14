import { PGlite } from '@electric-sql/pglite';
import { Logger } from '@nestjs/common';
import type { ConfirmChannel, ConsumeMessage, Options } from 'amqplib';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db, Queryable, Row } from '../db.js';
import { Metrics } from '../metrics.js';
import type { BrokerConnection } from './connection.js';
import {
  DEAD_LETTERS_TABLE_SQL,
  DeadLetters,
  HEADER_REDRIVE_OF,
  parseDeadLetterId,
  parseDeadLetterQuery,
  parseRedriveReason,
} from './dead-letters.js';
import { createEnvelope } from './envelope.js';
import { HEADER_ATTEMPT, HEADER_FAILURE, HEADER_ORIGINAL_QUEUE } from './topology.js';

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

/** A channel that records what was consumed, settled and published. */
class FakeChannel {
  readonly consumed: string[] = [];
  readonly acked: ConsumeMessage[] = [];
  readonly nacked: Array<{ message: ConsumeMessage; requeue: boolean }> = [];
  readonly published: Array<{
    exchange: string;
    routingKey: string;
    content: Buffer;
    options: Options.Publish;
  }> = [];
  failPublish = false;

  async prefetch() {}
  async consume(queue: string) {
    this.consumed.push(queue);
    return { consumerTag: queue };
  }
  ack(message: ConsumeMessage) {
    this.acked.push(message);
  }
  nack(message: ConsumeMessage, _allUpTo = false, requeue = true) {
    this.nacked.push({ message, requeue });
  }
  publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Options.Publish,
    done: (err: unknown) => void,
  ) {
    if (this.failPublish) {
      done(new Error('nack from the broker'));
      return false;
    }
    this.published.push({ exchange, routingKey, content, options });
    done(null);
    return true;
  }
  async close() {}
}

/** The part of a broker connection dead letters use. */
function fakeBroker(channel: FakeChannel, connected = true) {
  const listeners: Array<(ch: ConfirmChannel) => Promise<void>> = [];
  const broker = {
    connected,
    durableQueues: () => ['foc.credit.wallet-provisioning', 'foc.credit.reservations'],
    onConnected: (listener: (ch: ConfirmChannel) => Promise<void>) => listeners.push(listener),
    isConnected: () => broker.connected,
    getChannel: () => channel as unknown as ConfirmChannel,
    /** The broker (re)connects: every listener runs on the channel. */
    connect: async () => {
      for (const listener of listeners) await listener(channel as unknown as ConfirmChannel);
    },
  };
  return broker;
}

const activation = createEnvelope({
  eventType: 'user.activated',
  schemaVersion: 1,
  aggregateId: 'user-42',
  producer: 'user-service',
  correlationId: 'trace-activation',
  payload: { userId: 'user-42', activatedAt: '2026-10-08T08:00:00.000Z' },
});

/** A message as the dead-letter queue delivers it after five failed attempts. */
function deadLettered(body: unknown = activation, headers: Record<string, unknown> = {}) {
  return {
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    fields: { routingKey: 'foc.credit.wallet-provisioning', deliveryTag: 1 },
    properties: {
      contentType: 'application/json',
      messageId: activation.eventId,
      correlationId: activation.correlationId,
      type: 'user.activated',
      headers: {
        [HEADER_ATTEMPT]: 5,
        [HEADER_FAILURE]: 'connect ECONNREFUSED credit database',
        [HEADER_ORIGINAL_QUEUE]: 'foc.credit.wallet-provisioning',
        'x-tenant-note': 'kept',
        ...headers,
      },
    },
  } as unknown as ConsumeMessage;
}

const QUEUE = 'foc.credit.wallet-provisioning';
const operator = { actorId: 'admin-1', reason: 'credit database is back', correlationId: 'ops-1' };

beforeAll(() => Logger.overrideLogger(false));
afterEach(() => vi.useRealTimers());

describe('parking (PLT-05)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await deadLetterDb();
  });

  it("consumes every durable queue's dead-letter queue once connected", async () => {
    const channel = new FakeChannel();
    // As in an app: providers are built before the broker connects.
    const broker = fakeBroker(channel, false);
    new DeadLetters(db, broker as unknown as BrokerConnection);
    broker.connected = true;
    await broker.connect();
    await broker.connect(); // the same channel again: nothing consumed twice
    expect(channel.consumed).toEqual([
      'foc.credit.wallet-provisioning.dlq',
      'foc.credit.reservations.dlq',
    ]);
  });

  it('stores a dead letter with its identity, failure and attempts, then acknowledges it', async () => {
    const channel = new FakeChannel();
    const letters = new DeadLetters(db);
    const message = deadLettered();
    await letters.park(channel as unknown as ConfirmChannel, QUEUE, message);

    expect(channel.acked).toEqual([message]);
    const { items } = await letters.list({ page: 1, pageSize: 10 });
    expect(items).toEqual([
      expect.objectContaining({
        queue: QUEUE,
        eventId: activation.eventId,
        eventType: 'user.activated',
        aggregateId: 'user-42',
        correlationId: 'trace-activation',
        failureReason: 'connect ECONNREFUSED credit database',
        attempts: 5,
        status: 'WAITING',
        redrivenAt: null,
      }),
    ]);
    const detail = await letters.get(items[0]!.id);
    expect(detail.body).toEqual(JSON.parse(JSON.stringify(activation)));
    expect(detail.headers).toMatchObject({ 'x-tenant-note': 'kept' });
  });

  it('stores a message that is not JSON as it came, identified by its properties', async () => {
    const letters = new DeadLetters(db);
    await letters.park(
      new FakeChannel() as unknown as ConfirmChannel,
      QUEUE,
      deadLettered('{oops'),
    );
    const [item] = (await letters.list({ page: 1, pageSize: 10 })).items;
    expect(item).toMatchObject({ eventId: activation.eventId, aggregateId: null });
    expect((await letters.get(item!.id)).body).toBe('{oops');
  });

  it('gives a message back to the broker, after a pause, when it cannot be stored', async () => {
    vi.useFakeTimers();
    const channel = new FakeChannel();
    await db.close(); // the database is down
    const message = deadLettered();
    await new DeadLetters(db).park(channel as unknown as ConfirmChannel, QUEUE, message);
    expect(channel.acked).toEqual([]);
    expect(channel.nacked).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(channel.nacked).toEqual([{ message, requeue: true }]);
  });
});

describe('finding and reading (PLT-05)', () => {
  it('searches by correlation, order or event id, by status and by queue, newest first', async () => {
    const db = await deadLetterDb();
    const letters = new DeadLetters(db);
    const channel = new FakeChannel() as unknown as ConfirmChannel;
    await letters.park(channel, QUEUE, deadLettered());
    const order = createEnvelope({
      eventType: 'order.reservation-requested',
      schemaVersion: 1,
      aggregateId: 'order-7',
      producer: 'order-service',
      correlationId: 'trace-order',
      payload: {},
    });
    await letters.park(channel, 'foc.credit.reservations', deadLettered(order));

    const all = await letters.list({ page: 1, pageSize: 10 });
    expect(all.items.map((i) => i.aggregateId)).toEqual(['order-7', 'user-42']);
    for (const q of ['order-7', 'trace-order', order.eventId]) {
      expect(
        (await letters.list({ q, page: 1, pageSize: 10 })).items.map((i) => i.aggregateId),
      ).toEqual(['order-7']);
    }
    expect((await letters.list({ queue: QUEUE, page: 1, pageSize: 10 })).total).toBe(1);
    expect((await letters.list({ status: 'REDRIVEN', page: 1, pageSize: 10 })).total).toBe(0);
    expect((await letters.list({ page: 2, pageSize: 1 })).items.map((i) => i.aggregateId)).toEqual([
      'user-42',
    ]);
    await expect(letters.get('00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('redrive (PLT-05)', () => {
  async function parked() {
    const db = await deadLetterDb();
    const channel = new FakeChannel();
    const broker = fakeBroker(channel);
    const letters = new DeadLetters(db, broker as unknown as BrokerConnection);
    const message = deadLettered();
    await letters.park(channel as unknown as ConfirmChannel, QUEUE, message);
    const [item] = (await letters.list({ page: 1, pageSize: 10 })).items;
    return { db, channel, broker, letters, message, id: item!.id };
  }

  it('sends the same bytes to its own queue only, with the attempts started again, and records who and why', async () => {
    const { channel, letters, message, id } = await parked();
    const done = await letters.redrive(id, operator);

    expect(channel.published).toHaveLength(1);
    const sent = channel.published[0]!;
    expect(sent.exchange).toBe(''); // the default exchange: this queue, not every one bound to the type
    expect(sent.routingKey).toBe(QUEUE);
    expect(sent.content.equals(message.content)).toBe(true); // the payload, byte for byte
    expect(sent.options).toMatchObject({
      messageId: activation.eventId,
      correlationId: 'trace-activation',
      type: 'user.activated',
      persistent: true,
    });
    expect(sent.options.headers).toEqual({ 'x-tenant-note': 'kept', [HEADER_REDRIVE_OF]: id });

    expect(done).toMatchObject({
      status: 'REDRIVEN',
      redrivenBy: 'admin-1',
      redriveReason: 'credit database is back',
    });
  });

  it('redrives a dead letter once; a second attempt is refused and sends nothing', async () => {
    const { channel, letters, id } = await parked();
    await letters.redrive(id, operator);
    await expect(letters.redrive(id, operator)).rejects.toMatchObject({ code: 'ALREADY_REDRIVEN' });
    expect(channel.published).toHaveLength(1);
  });

  it('records nothing when the broker is away or refuses the message', async () => {
    const { channel, broker, letters, id } = await parked();
    broker.connected = false;
    await expect(letters.redrive(id, operator)).rejects.toMatchObject({
      code: 'BROKER_UNAVAILABLE',
    });
    broker.connected = true;
    channel.failPublish = true;
    await expect(letters.redrive(id, operator)).rejects.toThrow('nack from the broker');
    expect((await letters.get(id)).status).toBe('WAITING');
  });

  it('is refused by the table itself: no edited payload, no second redrive, no delete', async () => {
    const { db, letters, id } = await parked();
    await expect(
      db.query("UPDATE dead_letters SET body = convert_to('{}', 'UTF8') WHERE id = $1", [id]),
    ).rejects.toThrow(/change once/);
    await letters.redrive(id, operator);
    await expect(
      db.query("UPDATE dead_letters SET redrive_reason = 'rewritten' WHERE id = $1", [id]),
    ).rejects.toThrow(/change once/);
    await expect(db.query('DELETE FROM dead_letters WHERE id = $1', [id])).rejects.toThrow(
      /never deleted/,
    );
  });
});

describe('the dead-letter metric (PLT-05)', () => {
  it('counts waiting dead letters per queue, every dead-letter queue from zero', async () => {
    const db = await deadLetterDb();
    const channel = new FakeChannel();
    const metrics = new Metrics('credit-service');
    const letters = new DeadLetters(
      db,
      fakeBroker(channel) as unknown as BrokerConnection,
      metrics,
    );
    await letters.park(channel as unknown as ConfirmChannel, QUEUE, deadLettered());

    const body = await metrics.render();
    expect(body).toMatch(
      /foc_dead_letters_waiting\{queue="foc\.credit\.wallet-provisioning"[^}]*\} 1/,
    );
    expect(body).toMatch(/foc_dead_letters_waiting\{queue="foc\.credit\.reservations"[^}]*\} 0/);
  });
});

describe("the admin routes' inputs", () => {
  it('defaults paging and refuses unknown filters', () => {
    expect(parseDeadLetterQuery({})).toEqual({ page: 1, pageSize: 20 });
    expect(parseDeadLetterQuery({ status: 'WAITING', q: ' trace-1 ', pageSize: '5' })).toEqual({
      status: 'WAITING',
      q: 'trace-1',
      page: 1,
      pageSize: 5,
    });
    for (const bad of [{ status: 'LOST' }, { pageSize: '101' }, { orderBy: 'id' }]) {
      expect(() => parseDeadLetterQuery(bad)).toThrow('One or more fields are invalid.');
    }
  });

  it('wants a reason to redrive, and a well-formed id', () => {
    expect(parseRedriveReason({ reason: '  database back  ' })).toBe('database back');
    expect(() => parseRedriveReason({})).toThrow('One or more fields are invalid.');
    expect(() => parseRedriveReason({ reason: ' ' })).toThrow('One or more fields are invalid.');
    expect(() => parseDeadLetterId('not-an-id')).toThrow('No such dead letter.');
  });
});
