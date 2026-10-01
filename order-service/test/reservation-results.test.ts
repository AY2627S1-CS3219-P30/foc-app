import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVENTS,
  UnparseableMessageError,
  createEnvelope,
  type EventConsumer,
  type SubscribeOptions,
} from '@foc/platform';
import {
  RESERVATION_RESULTS_QUEUE,
  ReservationResultsConsumer,
} from '../src/reservation-results.consumer.js';
import { asRequester, createTestApp, http, type TestApp } from './helpers/app.js';

const supplierId = '00000000-0000-4000-8000-000000000125';

class RecordingConsumer {
  readonly subscriptions: SubscribeOptions<unknown>[] = [];
  async subscribe<T>(options: SubscribeOptions<T>): Promise<void> {
    this.subscriptions.push(options as SubscribeOptions<unknown>);
  }
}

async function pendingOrder(t: TestApp): Promise<string> {
  const response = await http(t)
    .post('/orders')
    .set('Authorization', asRequester)
    .set('Idempotency-Key', randomUUID())
    .send({
      supplierId,
      items: [{ name: 'Coffee', quantity: 1 }],
      deliveryZone: 'COM2 Lobby',
      deliveryInstructions: 'Call on arrival',
      reward: 3,
    })
    .expect(201);
  return response.body.orderId as string;
}

async function subscription(t: TestApp) {
  const recorder = new RecordingConsumer();
  await new ReservationResultsConsumer(
    recorder as unknown as EventConsumer,
    t.db,
    t.orders,
  ).onApplicationBootstrap();
  return recorder.subscriptions[0]!;
}

describe('Credit reservation result handling', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it('trusts only Credit and accepts both catalogue result shapes', async () => {
    t = await createTestApp();
    const sub = await subscription(t);
    expect(sub).toMatchObject({
      queue: RESERVATION_RESULTS_QUEUE,
      eventType: [EVENTS.CREDITS_RESERVED, EVENTS.CREDIT_RESERVATION_REJECTED],
      expectedProducer: 'credit-service',
    });
    expect(
      sub.payloadSchema.safeParse({
        orderId: randomUUID(),
        requesterId: 'seed-requester',
        amount: 3,
      }).success,
    ).toBe(true);
  });

  it('moves a pending order to OPEN once and starts its acceptance deadline', async () => {
    t = await createTestApp();
    const orderId = await pendingOrder(t);
    const sub = await subscription(t);
    const envelope = createEnvelope({
      eventId: randomUUID(),
      eventType: EVENTS.CREDITS_RESERVED,
      schemaVersion: 1,
      aggregateId: orderId,
      producer: 'credit-service',
      correlationId: 'corr-reserved',
      payload: { orderId, requesterId: 'seed-requester', amount: 3 },
    });
    for (let delivery = 1; delivery <= 100; delivery++) {
      await sub.handler(envelope, { attempt: delivery, queue: RESERVATION_RESULTS_QUEUE });
    }
    const order = await t.orders.findById(orderId);
    expect(order).toMatchObject({ status: 'OPEN', version: 2 });
    expect(new Date(order!.acceptanceDeadlineAt!).getTime()).toBeGreaterThan(Date.now());
    const history = await t.db.query(
      `SELECT * FROM order_status_history WHERE order_id = $1 AND new_status = 'OPEN'`,
      [orderId],
    );
    expect(history.rows).toHaveLength(1);
  });

  it('moves a refusal to REJECTED with its actionable insufficient-credit details', async () => {
    t = await createTestApp();
    const orderId = await pendingOrder(t);
    const sub = await subscription(t);
    await sub.handler(
      createEnvelope({
        eventId: randomUUID(),
        eventType: EVENTS.CREDIT_RESERVATION_REJECTED,
        schemaVersion: 1,
        aggregateId: orderId,
        producer: 'credit-service',
        correlationId: 'corr-rejected',
        payload: {
          orderId,
          requesterId: 'seed-requester',
          amount: 3,
          reason: 'INSUFFICIENT_CREDITS',
          available: 1,
        },
      }),
      { attempt: 1, queue: RESERVATION_RESULTS_QUEUE },
    );
    expect(await t.orders.findById(orderId)).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'INSUFFICIENT_CREDITS',
      availableAtRejection: 1,
    });
  });

  it('rejects a conflicting replay of an already-recorded refusal', async () => {
    t = await createTestApp();
    const orderId = await pendingOrder(t);
    const sub = await subscription(t);
    const rejection = (eventId: string, available: number) =>
      createEnvelope({
        eventId,
        eventType: EVENTS.CREDIT_RESERVATION_REJECTED,
        schemaVersion: 1,
        aggregateId: orderId,
        producer: 'credit-service',
        correlationId: 'corr-conflicting-rejection',
        payload: {
          orderId,
          requesterId: 'seed-requester',
          amount: 3,
          reason: 'INSUFFICIENT_CREDITS' as const,
          available,
        },
      });

    await sub.handler(rejection(randomUUID(), 1), {
      attempt: 1,
      queue: RESERVATION_RESULTS_QUEUE,
    });
    await expect(
      sub.handler(rejection(randomUUID(), 2), {
        attempt: 1,
        queue: RESERVATION_RESULTS_QUEUE,
      }),
    ).rejects.toBeInstanceOf(UnparseableMessageError);

    expect(await t.orders.findById(orderId)).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'INSUFFICIENT_CREDITS',
      availableAtRejection: 1,
      version: 2,
    });
    expect((await t.db.query(`SELECT * FROM processed_events`)).rows).toHaveLength(1);
  });

  it('rejects an aggregate or request-fact mismatch without mutation or inbox commit', async () => {
    t = await createTestApp();
    const orderId = await pendingOrder(t);
    const sub = await subscription(t);
    const envelope = createEnvelope({
      eventId: randomUUID(),
      eventType: EVENTS.CREDITS_RESERVED,
      schemaVersion: 1,
      aggregateId: orderId,
      producer: 'credit-service',
      correlationId: 'corr-mismatch',
      payload: { orderId, requesterId: 'someone-else', amount: 3 },
    });
    await expect(
      sub.handler(envelope, { attempt: 1, queue: RESERVATION_RESULTS_QUEUE }),
    ).rejects.toBeInstanceOf(UnparseableMessageError);
    expect(await t.orders.findById(orderId)).toMatchObject({ status: 'PENDING_CREDIT' });
    expect((await t.db.query(`SELECT * FROM processed_events`)).rows).toHaveLength(0);
  });
});
