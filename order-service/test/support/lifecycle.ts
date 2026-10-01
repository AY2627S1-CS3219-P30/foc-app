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
): Promise<void> {
  await http(t)
    .post(`/orders/${SEEDED_ORDER}/accept`)
    .set('Authorization', asStranger)
    .send({ expectedVersion: 2 })
    .expect(201);
  if (to === 'ACCEPTED') return;
  await http(t)
    .post(`/orders/${SEEDED_ORDER}/pickup`)
    .set('Authorization', asStranger)
    .send({ expectedVersion: 3 })
    .expect(200);
  if (to === 'PICKED_UP') return;
  await http(t)
    .post(`/orders/${SEEDED_ORDER}/deliver`)
    .set('Authorization', asStranger)
    .send({ expectedVersion: 4 })
    .expect(200);
  if (to === 'DELIVERED') return;
  await http(t)
    .post(`/orders/${SEEDED_ORDER}/confirm-receipt`)
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
