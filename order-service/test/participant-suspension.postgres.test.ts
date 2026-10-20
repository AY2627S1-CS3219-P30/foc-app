import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENTS, createEnvelope } from '@foc/platform';
import type { PgDb } from '@foc/platform';
import {
  createEphemeralPostgres,
  TEST_POSTGRES_URL,
  type EphemeralPostgres,
} from '@foc/test-harness';
import { OrdersRepository } from '../src/orders/orders.repository.js';
import { UserDirectoryClient } from '../src/orders/user-directory.client.js';
import {
  RESERVATION_RESULTS_QUEUE,
  ReservationResultsConsumer,
} from '../src/reservation-results.consumer.js';
import {
  USER_SUSPENSIONS_QUEUE,
  UserSuspensionsConsumer,
} from '../src/user-suspensions.consumer.js';
import { subscriptionsOf } from './support/lifecycle.js';

const suite = TEST_POSTGRES_URL ? describe : describe.skip;
const SEEDED_ORDER = '00000000-0000-4000-8000-000000000129';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

suite('a reservation reply racing a suspension on real PostgreSQL (ORD-06)', () => {
  let database: EphemeralPostgres;
  let db: PgDb;
  let orders: OrdersRepository;
  let reward: number;

  // The User Service answers with the status at the moment it was asked, `ms` later, as an answer
  // still in flight when the suspension takes effect would.
  let suspended = false;
  const userService = (ms: () => number) =>
    new UserDirectoryClient(async () => {
      const status = suspended ? 'SUSPENDED' : 'ACTIVE';
      await sleep(ms());
      return Response.json({ exists: true, status });
    });
  let replyAnswerMs = 0;

  beforeAll(async () => {
    database = await createEphemeralPostgres({
      adminUrl: TEST_POSTGRES_URL!,
      label: 'participant_suspension',
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    db = database.db;
    orders = new OrdersRepository(db);
    reward = (await orders.findById(SEEDED_ORDER))!.reward;
  });
  afterAll(async () => database?.dispose());

  const pendingOrder = async (requesterId: string): Promise<string> => {
    const orderId = randomUUID();
    await db.query(
      `INSERT INTO orders (order_id, requester_id, supplier_snapshot, items, delivery_zone,
                           delivery_instructions, reward, status, version)
       SELECT $1, $3, supplier_snapshot, items, delivery_zone, delivery_instructions, reward,
              'PENDING_CREDIT', 1
         FROM orders WHERE order_id = $2`,
      [orderId, SEEDED_ORDER, requesterId],
    );
    return orderId;
  };

  const handlerOf = async (
    queue: string,
    create: Parameters<typeof subscriptionsOf>[0],
  ): Promise<(envelope: unknown) => Promise<void>> => {
    const subscription = (await subscriptionsOf(create))[queue]!;
    return (envelope) => subscription.handler(envelope as never, { attempt: 1, queue });
  };

  it('never leaves the errand open, whichever of the two runs first', async () => {
    const reply = await handlerOf(
      RESERVATION_RESULTS_QUEUE,
      (broker) =>
        new ReservationResultsConsumer(
          broker,
          db,
          orders,
          userService(() => replyAnswerMs),
        ),
    );
    const suspend = await handlerOf(
      USER_SUSPENSIONS_QUEUE,
      (broker) =>
        new UserSuspensionsConsumer(
          broker,
          db,
          orders,
          userService(() => 0),
        ),
    );

    const cancelledBy: Record<string, number> = {};
    for (let round = 0; round < 30; round++) {
      const requesterId = `race-requester-${round}`;
      const orderId = await pendingOrder(requesterId);
      suspended = false;
      replyAnswerMs = 20 + (round % 3) * 20;

      await Promise.all([
        reply(
          createEnvelope({
            eventId: randomUUID(),
            eventType: EVENTS.CREDITS_RESERVED,
            schemaVersion: 1,
            aggregateId: orderId,
            producer: 'credit-service',
            correlationId: 'corr-race',
            payload: { orderId, requesterId, amount: reward },
          }),
        ),
        sleep((round % 5) * 10).then(() => {
          suspended = true;
          return suspend(
            createEnvelope({
              eventId: randomUUID(),
              eventType: EVENTS.USER_SUSPENDED,
              schemaVersion: 1,
              aggregateId: requesterId,
              producer: 'user-service',
              correlationId: 'corr-race',
              payload: {
                userId: requesterId,
                status: 'SUSPENDED',
                occurredAt: new Date().toISOString(),
              },
            }),
          );
        }),
      ]);

      expect(await orders.findById(orderId)).toMatchObject({
        status: 'RELEASE_PENDING_CREDIT',
        releaseReason: 'CANCELLED',
      });
      const releases = await db.query(
        `SELECT 1 FROM outbox_events WHERE aggregate_id = $1 AND event_type = $2`,
        [orderId, EVENTS.CREDIT_RELEASE_REQUESTED],
      );
      expect(releases.rows).toHaveLength(1);
      // CREDIT_RESERVED: the reply found the requester suspended. REQUESTER_SUSPENDED: the reply
      // opened the errand and the suspension, waiting on its lock, then cancelled it.
      const action = (await orders.findHistory(orderId)).at(-1)!.action;
      cancelledBy[action] = (cancelledBy[action] ?? 0) + 1;
    }
    console.log('reply-vs-suspension cancelled by', cancelledBy);
    expect(Object.values(cancelledBy).reduce((sum, n) => sum + n, 0)).toBe(30);
  });
});
