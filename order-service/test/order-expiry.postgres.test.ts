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
import { LifecycleScheduler } from '../src/orders/lifecycle.scheduler.js';
import { OrdersRepository } from '../src/orders/orders.repository.js';

const suite = TEST_POSTGRES_URL ? describe : describe.skip;
const SEEDED_ORDER = '00000000-0000-4000-8000-000000000129';

suite('accept versus expire on real PostgreSQL (OS-NFR3.1.2)', () => {
  let database: EphemeralPostgres;
  let db: PgDb;
  let orders: OrdersRepository;

  beforeAll(async () => {
    database = await createEphemeralPostgres({
      adminUrl: TEST_POSTGRES_URL!,
      label: 'order_expiry',
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    db = database.db;
    orders = new OrdersRepository(db);
  });
  afterAll(async () => database?.dispose());

  const openOrder = async (deadlineInMs: number): Promise<string> => {
    const orderId = randomUUID();
    await db.query(
      `INSERT INTO orders (order_id, requester_id, supplier_snapshot, items, delivery_zone,
                           delivery_instructions, reward, status, version, acceptance_deadline_at)
       SELECT $1, requester_id, supplier_snapshot, items, delivery_zone, delivery_instructions,
              reward, 'OPEN', 2, now() + ($3 || ' milliseconds')::interval
         FROM orders WHERE order_id = $2`,
      [orderId, SEEDED_ORDER, String(deadlineInMs)],
    );
    return orderId;
  };

  const sweeper = () =>
    new LifecycleScheduler(orders, {
      pickupTimeoutMs: 1_800_000,
      creditWaitTimeoutMs: 300_000,
      intervalMs: 10_000,
    });

  it('never both accepts and expires an order racing its deadline', async () => {
    const outcomes = { ACCEPTED: 0, RELEASE_PENDING_CREDIT: 0 } as Record<string, number>;
    for (let round = 0; round < 20; round++) {
      const orderId = await openOrder(150);
      await new Promise((resolve) => setTimeout(resolve, 140 + (round % 5) * 5));
      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) =>
          orders.accept(orderId, `courier-${round}-${i}`, 2, 'corr'),
        ),
        sweeper().sweep(),
        sweeper().sweep(),
        new Promise((resolve) => setTimeout(resolve, 20)).then(() => sweeper().sweep()),
      ]);
      await sweeper().sweep(); // whatever is still OPEN is now certainly overdue

      const order = await orders.findById(orderId);
      const releases = await db.query(
        `SELECT * FROM outbox_events WHERE aggregate_id = $1 AND event_type = $2`,
        [orderId, EVENTS.CREDIT_RELEASE_REQUESTED],
      );
      const history = await db.query<{ new_status: string }>(
        `SELECT new_status FROM order_status_history WHERE order_id = $1 ORDER BY order_version`,
        [orderId],
      );
      expect(order!.version).toBe(3);
      expect(history.rows).toHaveLength(1);
      if (order!.status === 'ACCEPTED') {
        expect(order!.courierId).not.toBeNull();
        expect(releases.rows).toHaveLength(0);
      } else {
        expect(order).toMatchObject({
          status: 'RELEASE_PENDING_CREDIT',
          courierId: null,
          releaseReason: 'EXPIRED',
        });
        expect(releases.rows).toHaveLength(1);
      }
      outcomes[order!.status] = (outcomes[order!.status] ?? 0) + 1;
    }
    console.log('accept-vs-expire outcomes', outcomes);
    expect(outcomes.ACCEPTED! + outcomes.RELEASE_PENDING_CREDIT!).toBe(20);
  });

  it('applies each overdue timer once across many concurrent scheduler instances', async () => {
    const ids = await Promise.all(Array.from({ length: 25 }, () => openOrder(-1_000)));
    const results = await Promise.all(Array.from({ length: 6 }, () => sweeper().sweep()));
    const mine = await db.query<{ aggregate_id: string }>(
      `SELECT aggregate_id FROM outbox_events WHERE event_type = $1 AND aggregate_id = ANY($2)`,
      [EVENTS.CREDIT_RELEASE_REQUESTED, ids],
    );
    expect(mine.rows).toHaveLength(25);
    expect(new Set(mine.rows.map((row) => row.aggregate_id)).size).toBe(25);
    expect(results.reduce((sum, result) => sum + result.expired, 0)).toBeGreaterThanOrEqual(25);
  });
});
