import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENTS } from '@foc/platform';
import type { PgDb } from '@foc/platform';
import {
  createEphemeralPostgres,
  TEST_POSTGRES_URL,
  type EphemeralPostgres,
} from '@foc/test-harness';
import { OrdersRepository } from '../src/orders/orders.repository.js';

const suite = TEST_POSTGRES_URL ? describe : describe.skip;
const SEEDED_ORDER = '00000000-0000-4000-8000-000000000129';

suite('Order acceptance concurrency on real PostgreSQL', () => {
  let database: EphemeralPostgres;
  let db: PgDb;
  let orders: OrdersRepository;

  beforeAll(async () => {
    database = await createEphemeralPostgres({
      adminUrl: TEST_POSTGRES_URL!,
      label: 'order_acceptance',
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    db = database.db;
    orders = new OrdersRepository(db);
  });

  afterAll(async () => database?.dispose());

  it('uses one conditional update to choose one winner among 100 couriers', async () => {
    // A fresh OPEN order cloned from the seed keeps the test rerunnable against a reused database.
    const orderId = randomUUID();
    await db.query(
      `INSERT INTO orders (order_id, requester_id, supplier_snapshot, items, delivery_zone,
                           delivery_instructions, reward, status, version, acceptance_deadline_at)
       SELECT $1, requester_id, supplier_snapshot, items, delivery_zone, delivery_instructions,
              reward, 'OPEN', 2, now() + interval '60 minutes'
         FROM orders WHERE order_id = $2`,
      [orderId, SEEDED_ORDER],
    );

    const attempts = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        orders.accept(orderId, `courier-${index}`, 2, randomUUID()),
      ),
    );
    expect(attempts.filter((attempt) => attempt.accepted)).toHaveLength(1);

    const winner = attempts.find((attempt) => attempt.accepted);
    const order = await orders.findById(orderId);
    expect(order).toMatchObject({
      status: 'ACCEPTED',
      courierId: winner?.accepted ? winner.order.courierId : undefined,
      version: 3,
    });
    const history = await db.query(
      `SELECT * FROM order_status_history WHERE order_id = $1 AND new_status = 'ACCEPTED'`,
      [orderId],
    );
    expect(history.rows).toHaveLength(1);
    const events = await db.query(
      `SELECT * FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'order.status-changed'`,
      [orderId],
    );
    expect(events.rows).toHaveLength(1);
    expect(attempts.filter((attempt) => !attempt.accepted)).toHaveLength(99);
  });

  it('lets either the acceptances or the cancellation through, never both', async () => {
    const outcomes: Record<string, number> = { ACCEPTED: 0, RELEASE_PENDING_CREDIT: 0 };
    for (let round = 0; round < 20; round++) {
      const orderId = randomUUID();
      await db.query(
        `INSERT INTO orders (order_id, requester_id, supplier_snapshot, items, delivery_zone,
                             delivery_instructions, reward, status, version, acceptance_deadline_at)
         SELECT $1, requester_id, supplier_snapshot, items, delivery_zone, delivery_instructions,
                reward, 'OPEN', 2, now() + interval '60 minutes'
           FROM orders WHERE order_id = $2`,
        [orderId, SEEDED_ORDER],
      );
      const cancel = () =>
        orders.transition({
          orderId,
          action: 'CANCEL',
          expectedVersion: 2,
          actor: { kind: 'USER', id: 'seed-requester', isAdmin: false },
          correlationId: randomUUID(),
        });
      const acceptAll = () =>
        Promise.all(
          Array.from({ length: 10 }, (_, index) =>
            orders.accept(orderId, `courier-${round}-${index}`, 2, randomUUID()),
          ),
        );
      // Alternate which is sent first, so both orderings are exercised.
      let cancelled: Awaited<ReturnType<typeof cancel>>;
      let accepted: Awaited<ReturnType<typeof acceptAll>>;
      if (round % 2 === 0) [cancelled, accepted] = await Promise.all([cancel(), acceptAll()]);
      else [accepted, cancelled] = await Promise.all([acceptAll(), cancel()]);

      const order = await orders.findById(orderId);
      const releases = await db.query(
        `SELECT 1 FROM outbox_events WHERE aggregate_id = $1 AND event_type = $2`,
        [orderId, EVENTS.CREDIT_RELEASE_REQUESTED],
      );
      const history = await db.query(`SELECT 1 FROM order_status_history WHERE order_id = $1`, [
        orderId,
      ]);
      expect(order!.version).toBe(3);
      expect(history.rows).toHaveLength(1);
      if (order!.status === 'ACCEPTED') {
        expect(accepted.filter((attempt) => attempt.accepted)).toHaveLength(1);
        // The requester read version 2; the order has moved on, so the stale cancel is refused.
        expect(cancelled).toMatchObject({ kind: 'rejected', reason: 'VERSION_CONFLICT' });
        expect(releases.rows).toHaveLength(0);
      } else {
        expect(order).toMatchObject({
          status: 'RELEASE_PENDING_CREDIT',
          releaseReason: 'CANCELLED',
          courierId: null,
        });
        expect(cancelled).toMatchObject({ kind: 'applied' });
        expect(accepted.some((attempt) => attempt.accepted)).toBe(false);
        expect(releases.rows).toHaveLength(1);
      }
      outcomes[order!.status] = (outcomes[order!.status] ?? 0) + 1;
    }
    console.log('accept-vs-cancel outcomes', outcomes);
    expect(outcomes.ACCEPTED! + outcomes.RELEASE_PENDING_CREDIT!).toBe(20);
  });
});
