import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BrokerConnection,
  EVENTS,
  EXCHANGE,
  EventConsumer,
  EventPublisher,
  Metrics,
  createEnvelope,
  type SubscribeOptions,
} from '@foc/platform';
import { createMemoryBroker, type MemoryBroker } from '@foc/test-harness';
import { CREDIT_ECONOMIC_SUBSCRIPTIONS } from '../src/closed-economy.js';
import { ReservationConsumer } from '../src/reservation-consumer.js';
import { COMPLETION_QUEUE, CompletionConsumer } from '../src/terminal-consumers.js';
import { asAdmin, createTestApp, http, issue } from './helpers/app.js';

const SUBSCRIPTIONS = CREDIT_ECONOMIC_SUBSCRIPTIONS.map(({ queue, routingKeys }) => ({
  queue,
  routingKeys: [...routingKeys],
}));

/** What `wrap` may do around the completion handler, to stand in for the service stopping. */
type Crash = 'none' | 'before-commit' | 'after-commit';

/**
 * EVT-03 — the Credit Service's real consumers over an in-memory broker with the production
 * topology, so a step can be late, repeated, in an unsupported form, or interrupted by a crash.
 * A requester and a courier start with the initial 10 credits each; the errand is worth 3.
 */
async function stack(retryDelaysMs: number[]) {
  const memory: MemoryBroker = createMemoryBroker();
  const broker = new BrokerConnection(
    'amqp://memory',
    'credit-service',
    SUBSCRIPTIONS,
    retryDelaysMs,
    { connect: memory.connect },
  );
  const t = await createTestApp({ broker });
  const metrics = new Metrics('credit-service');
  const consumer = new EventConsumer(broker, metrics);
  const crash = { next: 'none' as Crash };
  // The service stops by losing its channel: whatever it had not acknowledged is delivered again.
  const interruptible = {
    subscribe: <T>(options: SubscribeOptions<T>) =>
      consumer.subscribe({
        ...options,
        handler: async (envelope, context) => {
          const now = options.queue === COMPLETION_QUEUE ? crash.next : 'none';
          crash.next = options.queue === COMPLETION_QUEUE ? 'none' : crash.next;
          if (now === 'before-commit') {
            await broker.getChannel().close();
            throw new Error('service stopped before the transfer committed');
          }
          await options.handler(envelope, context);
          if (now === 'after-commit') await broker.getChannel().close();
        },
      }),
  } as unknown as EventConsumer;
  await new ReservationConsumer(interruptible, t.db, t.credits).onApplicationBootstrap();
  await new CompletionConsumer(interruptible, t.db, t.credits).onApplicationBootstrap();
  await broker.connect();
  await issue(t, 'requester-1');
  await issue(t, 'courier-1');

  const orderId = randomUUID();
  const order = new EventPublisher(broker, 'order-service');
  const facts = { orderId, requesterId: 'requester-1', amount: 3 };
  const send = {
    reservation: () =>
      order.publish({
        eventType: EVENTS.CREDIT_RESERVATION_REQUESTED,
        schemaVersion: 1,
        aggregateId: orderId,
        correlationId: 'trace-delivery',
        payload: facts,
      }),
    completion: () =>
      order.publish({
        eventType: EVENTS.ORDER_COMPLETION_REQUESTED,
        schemaVersion: 1,
        aggregateId: orderId,
        correlationId: 'trace-delivery',
        payload: { ...facts, courierId: 'courier-1' },
      }),
  };
  const wallet = async (userId: string) =>
    (
      await t.db.query<{ available: number; reserved: number }>(
        'SELECT available, reserved FROM wallets WHERE user_id = $1',
        [userId],
      )
    ).rows[0];
  const balances = async () => ({
    requester: await wallet('requester-1'),
    courier: await wallet('courier-1'),
  });
  const transfers = async () =>
    Number(
      (
        await t.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM credit_transactions
            WHERE order_id = $1 AND transaction_type = 'TRANSFER'`,
          [orderId],
        )
      ).rows[0]!.n,
    );
  const counted = async (metric: Metrics['eventsDeferred']) =>
    (await metric.get()).values.find((v) => v.labels.queue === COMPLETION_QUEUE)?.value ?? 0;
  const deadLetters = async () =>
    (await http(t).get('/admin/dead-letters?status=WAITING').set('Authorization', asAdmin))
      .body as {
      total: number;
      items: Array<{ id: string; failureReason: string; attempts: number; queue: string }>;
    };
  return {
    t,
    memory,
    broker,
    metrics,
    crash,
    orderId,
    facts,
    send,
    balances,
    transfers,
    counted,
    deadLetters,
    close: async () => {
      await broker.close();
      await t.close();
    },
  };
}

const START = { available: 10, reserved: 0 };
const PAID = { requester: { available: 7, reserved: 0 }, courier: { available: 13, reserved: 0 } };

describe('delivery guarantees through the broker (EVT-03)', () => {
  let s: Awaited<ReturnType<typeof stack>> | undefined;
  beforeAll(() => Logger.overrideLogger(false));
  afterEach(async () => {
    await s?.close();
    s = undefined;
  });

  it('a completion that arrives before its reservation waits, then transfers once it lands', async () => {
    s = await stack([200, 200, 200, 200]);

    await s.send.completion();
    await expect.poll(() => s!.counted(s!.metrics.eventsDeferred)).toBeGreaterThanOrEqual(1);
    // Waiting moved nothing: no outcome was guessed from the order the steps arrived in.
    expect(await s.balances()).toEqual({ requester: START, courier: START });

    await s.send.reservation();
    await expect.poll(() => s!.balances(), { timeout: 5_000 }).toEqual(PAID);
    expect(await s.transfers()).toBe(1);
    expect((await s.deadLetters()).total).toBe(0);
  });

  it('a completion whose reservation never arrives is set aside for review, and moves no credits', async () => {
    s = await stack([10, 10]);

    await s.send.completion();

    await expect.poll(async () => (await s!.deadLetters()).total, { timeout: 5_000 }).toBe(1);
    expect((await s.deadLetters()).items[0]).toMatchObject({
      queue: COMPLETION_QUEUE,
      failureReason: `Reservation for ${s.orderId} is not ready yet.`,
      attempts: 3,
    });
    expect(await s.counted(s.metrics.eventsDeferred)).toBe(3);
    expect(await s.balances()).toEqual({ requester: START, courier: START });
    expect(await s.transfers()).toBe(0);
  });

  it('a crash after the transfer commits, before it is acknowledged, moves no additional credits', async () => {
    s = await stack([10, 10]);
    await s.send.reservation();
    await expect
      .poll(async () => (await s!.balances()).requester)
      .toEqual({ available: 7, reserved: 3 });

    s.crash.next = 'after-commit';
    await s.send.completion();
    await expect.poll(() => s!.balances()).toEqual(PAID);

    // The broker delivers the unacknowledged request again once the service is back.
    await expect.poll(() => s!.counted(s!.metrics.eventsDuplicate), { timeout: 10_000 }).toBe(1);
    await expect.poll(() => s!.memory.depth(COMPLETION_QUEUE)).toBe(0);
    expect(await s.balances()).toEqual(PAID);
    expect(await s.transfers()).toBe(1);
    expect((await s.deadLetters()).total).toBe(0);
  });

  it('a crash before the transfer commits is handled again after the restart, once', async () => {
    s = await stack([10, 10]);
    await s.send.reservation();
    await expect
      .poll(async () => (await s!.balances()).requester)
      .toEqual({ available: 7, reserved: 3 });

    s.crash.next = 'before-commit';
    await s.send.completion();

    await expect.poll(() => s!.balances(), { timeout: 10_000 }).toEqual(PAID);
    await expect.poll(() => s!.memory.depth(COMPLETION_QUEUE)).toBe(0);
    expect(await s.transfers()).toBe(1);
    expect(await s.counted(s.metrics.eventsDuplicate)).toBe(0);
    expect((await s.deadLetters()).total).toBe(0);
  });

  it('an unsupported major version of a completion request is set aside whole and moves no credits', async () => {
    s = await stack([10, 10]);
    await s.send.reservation();
    await expect
      .poll(async () => (await s!.balances()).requester)
      .toEqual({ available: 7, reserved: 3 });
    // Version 2 of the request, in a shape the version 1 schema would also accept.
    const request = createEnvelope({
      eventType: EVENTS.ORDER_COMPLETION_REQUESTED,
      schemaVersion: 2,
      aggregateId: s.orderId,
      producer: 'order-service',
      correlationId: 'trace-delivery',
      payload: { ...s.facts, courierId: 'courier-1' },
    });

    s.memory.publish(EXCHANGE, EVENTS.ORDER_COMPLETION_REQUESTED, request);

    await expect.poll(async () => (await s!.deadLetters()).total, { timeout: 5_000 }).toBe(1);
    const [parked] = (await s.deadLetters()).items;
    expect(parked!.failureReason).toBe(
      'unsupported schema version 2 for order.completion-requested; supported: 1',
    );
    const detail = await http(s.t)
      .get(`/admin/dead-letters/${parked!.id}`)
      .set('Authorization', asAdmin)
      .expect(200);
    expect(detail.body.body).toEqual(JSON.parse(JSON.stringify(request)));
    expect(await s.transfers()).toBe(0);
    expect(await s.balances()).toEqual({
      requester: { available: 7, reserved: 3 },
      courier: START,
    });
  });
});
