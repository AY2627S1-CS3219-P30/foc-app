import { randomUUID } from 'node:crypto';
import { EVENTS, createEnvelope, type EventConsumer, type SubscribeOptions } from '@foc/platform';
import {
  CreditTerminalResultsConsumer,
  TRANSFER_RESULTS_QUEUE,
} from '../../src/credit-terminal-results.consumer.js';
import { asRequester, asStranger, http, type TestApp } from '../helpers/app.js';

export const SEEDED_ORDER = '00000000-0000-4000-8000-000000000129';
export const REQUESTER = 'seed-requester';
export const COURIER = 'unrelated-student';
export const SEEDED_REWARD = 2;

class RecordingConsumer {
  readonly subscriptions: SubscribeOptions<unknown>[] = [];
  async subscribe<T>(options: SubscribeOptions<T>): Promise<void> {
    this.subscriptions.push(options as SubscribeOptions<unknown>);
  }
}

/** Boots the terminal-results consumer against a recording broker and returns its subscriptions. */
export async function terminalSubscriptions(t: TestApp) {
  const recorder = new RecordingConsumer();
  await new CreditTerminalResultsConsumer(
    recorder as unknown as EventConsumer,
    t.db,
    t.orders,
  ).onApplicationBootstrap();
  return Object.fromEntries(recorder.subscriptions.map((sub) => [sub.queue, sub]));
}

export const transferred = (
  overrides: Partial<{
    orderId: string;
    requesterId: string;
    courierId: string;
    amount: number;
    transactionId: string;
    eventId: string;
    aggregateId: string;
  }> = {},
) => {
  const orderId = overrides.orderId ?? SEEDED_ORDER;
  const amount = overrides.amount ?? SEEDED_REWARD;
  return createEnvelope({
    eventId: overrides.eventId ?? randomUUID(),
    eventType: EVENTS.CREDITS_TRANSFERRED,
    schemaVersion: 1,
    aggregateId: overrides.aggregateId ?? orderId,
    producer: 'credit-service',
    correlationId: 'corr-transfer',
    payload: {
      orderId,
      requesterId: overrides.requesterId ?? REQUESTER,
      courierId: overrides.courierId ?? COURIER,
      amount,
      transactionId: overrides.transactionId ?? randomUUID(),
      requesterBalance: { available: 10, reserved: 0, total: 10 },
      courierBalance: { available: 10 + amount, reserved: 0, total: 10 + amount },
    },
  });
};

export const deliver = (t: TestApp, queue: string, envelope: unknown) =>
  terminalSubscriptions(t).then((subs) =>
    subs[queue]!.handler(envelope as never, { attempt: 1, queue }),
  );

/** Drives the seeded OPEN order through the HTTP API up to the given status. */
export async function advance(
  t: TestApp,
  to: 'ACCEPTED' | 'PICKED_UP' | 'DELIVERED' | 'COMPLETION_PENDING_CREDIT',
  orderId = SEEDED_ORDER,
): Promise<void> {
  await http(t)
    .post(`/orders/${orderId}/accept`)
    .set('Authorization', asStranger)
    .send({ expectedVersion: 2 })
    .expect(201);
  if (to === 'ACCEPTED') return;
  await http(t)
    .post(`/orders/${orderId}/pickup`)
    .set('Authorization', asStranger)
    .send({ expectedVersion: 3 })
    .expect(200);
  if (to === 'PICKED_UP') return;
  await http(t)
    .post(`/orders/${orderId}/deliver`)
    .set('Authorization', asStranger)
    .send({ expectedVersion: 4 })
    .expect(200);
  if (to === 'DELIVERED') return;
  await http(t)
    .post(`/orders/${orderId}/confirm-receipt`)
    .set('Authorization', asRequester)
    .send({ expectedVersion: 5 })
    .expect(200);
}

/** Everything a refused command must leave untouched. */
export async function footprint(t: TestApp, orderId = SEEDED_ORDER) {
  const [order, history, outbox] = await Promise.all([
    t.orders.findById(orderId),
    t.db.query(`SELECT count(*)::int AS n FROM order_status_history WHERE order_id = $1`, [
      orderId,
    ]),
    t.db.query(`SELECT count(*)::int AS n FROM outbox_events WHERE aggregate_id = $1`, [orderId]),
  ]);
  return {
    order,
    history: (history.rows[0] as { n: number }).n,
    outbox: (outbox.rows[0] as { n: number }).n,
  };
}

export { TRANSFER_RESULTS_QUEUE };

/**
 * Makes the next transaction fail when it reaches a statement matching `boundary`, after every
 * earlier write of that transaction has run — a crash at that exact write boundary.
 */
export function failAt(t: TestApp, boundary: RegExp): () => void {
  const db = t.db as unknown as {
    transaction: <T>(fn: (tx: import('@foc/platform').Queryable) => Promise<T>) => Promise<T>;
  };
  const original = db.transaction.bind(db);
  let armed = true;
  db.transaction = (fn) =>
    original((tx) =>
      fn({
        ...tx,
        query: async (sql: string, params?: unknown[]) => {
          if (armed && boundary.test(sql)) {
            armed = false;
            throw new Error(`injected fault at ${boundary}`);
          }
          return tx.query(sql, params);
        },
      } as typeof tx),
    );
  return () => {
    db.transaction = original;
  };
}

export { RELEASE_RESULTS_QUEUE } from '../../src/credit-terminal-results.consumer.js';

export const released = (
  overrides: Partial<{
    orderId: string;
    requesterId: string;
    amount: number;
    transactionId: string;
    eventId: string;
    aggregateId: string;
  }> = {},
) => {
  const orderId = overrides.orderId ?? SEEDED_ORDER;
  return createEnvelope({
    eventId: overrides.eventId ?? randomUUID(),
    eventType: EVENTS.CREDITS_RELEASED,
    schemaVersion: 1,
    aggregateId: overrides.aggregateId ?? orderId,
    producer: 'credit-service',
    correlationId: 'corr-release',
    payload: {
      orderId,
      requesterId: overrides.requesterId ?? REQUESTER,
      amount: overrides.amount ?? SEEDED_REWARD,
      transactionId: overrides.transactionId ?? randomUUID(),
      requesterBalance: { available: 10, reserved: 0, total: 10 },
    },
  });
};

/** Moves the seeded order's clocks so a timer is due without waiting for it. */
export async function backdate(
  t: TestApp,
  column: 'acceptance_deadline_at' | 'accepted_at',
  msAgo: number,
  orderId = SEEDED_ORDER,
): Promise<void> {
  await t.db.query(
    `UPDATE orders SET ${column} = now() - ($2 || ' milliseconds')::interval WHERE order_id = $1`,
    [orderId, String(msAgo)],
  );
}

export async function outboxOf(t: TestApp, eventType: string, orderId = SEEDED_ORDER) {
  const result = await t.db.query<{ payload: unknown }>(
    `SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = $2 ORDER BY seq`,
    [orderId, eventType],
  );
  return result.rows.map((row) => row.payload);
}

export const SECRET = {
  instructions: 'SECRET-INSTRUCTIONS-meet-at-locker-42',
  note: 'SECRET-NOTE-no-onions',
};

/** Creates a PENDING_CREDIT order through the API, carrying the private markers above. */
export async function createPending(t: TestApp): Promise<string> {
  const response = await http(t)
    .post('/orders')
    .set('Authorization', asRequester)
    .set('Idempotency-Key', randomUUID())
    .send({
      supplierId: '00000000-0000-4000-8000-000000000125',
      items: [{ name: 'Coffee', quantity: 1, note: SECRET.note }],
      deliveryZone: 'COM2 Lobby',
      deliveryInstructions: SECRET.instructions,
      reward: SEEDED_REWARD,
    })
    .expect(201);
  return response.body.orderId as string;
}

/** Delivers Credit's reservation reply for an order created by {@link createPending}. */
export async function reservationReply(t: TestApp, orderId: string, rejected = false) {
  const { ReservationResultsConsumer, RESERVATION_RESULTS_QUEUE } =
    await import('../../src/reservation-results.consumer.js');
  const recorder = new RecordingConsumer();
  await new ReservationResultsConsumer(
    recorder as unknown as EventConsumer,
    t.db,
    t.orders,
  ).onApplicationBootstrap();
  await recorder.subscriptions[0]!.handler(
    createEnvelope({
      eventId: randomUUID(),
      eventType: rejected ? EVENTS.CREDIT_RESERVATION_REJECTED : EVENTS.CREDITS_RESERVED,
      schemaVersion: 1,
      aggregateId: orderId,
      producer: 'credit-service',
      correlationId: 'corr-reservation',
      payload: rejected
        ? {
            orderId,
            requesterId: REQUESTER,
            amount: SEEDED_REWARD,
            reason: 'INSUFFICIENT_CREDITS',
            available: 0,
          }
        : { orderId, requesterId: REQUESTER, amount: SEEDED_REWARD },
    }),
    { attempt: 1, queue: RESERVATION_RESULTS_QUEUE },
  );
}

/** Records the administrator a dispute was referred to. ORD-11 (#171) owns doing this for real. */
export async function referTo(t: TestApp, adminId: string, orderId = SEEDED_ORDER) {
  await t.db.query(`UPDATE orders SET referred_admin_id = $2 WHERE order_id = $1`, [
    orderId,
    adminId,
  ]);
}
