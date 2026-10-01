import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
});
