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
import { UserDirectoryClient } from '../src/orders/user-directory.client.js';

const suite = TEST_POSTGRES_URL ? describe : describe.skip;
const SEEDED_ORDER = '00000000-0000-4000-8000-000000000129';
const REQUESTER = 'seed-requester';
// No administrator is listed, so a reported errand stays unreferred and keeps its version.
const noAdmins = new UserDirectoryClient(async () => Response.json({ items: [] }));

suite('a requester action racing auto-confirmation on real PostgreSQL (ORD-10)', () => {
  let database: EphemeralPostgres;
  let db: PgDb;
  let orders: OrdersRepository;

  beforeAll(async () => {
    database = await createEphemeralPostgres({
      adminUrl: TEST_POSTGRES_URL!,
      label: 'order_outcomes',
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    db = database.db;
    orders = new OrdersRepository(db);
  });
  afterAll(async () => database?.dispose());

  const deliveredOrder = async (autoConfirmInMs: number): Promise<string> => {
    const orderId = randomUUID();
    await db.query(
      `INSERT INTO orders (order_id, requester_id, courier_id, supplier_snapshot, items,
                           delivery_zone, delivery_instructions, reward, status, version,
                           accepted_at, picked_up_at, non_delivery_report_at, delivered_at,
                           auto_confirm_at)
       SELECT $1, requester_id, 'race-courier', supplier_snapshot, items, delivery_zone,
              delivery_instructions, reward, 'DELIVERED', 5, now(), now(), now(), now(),
              now() + ($3 || ' milliseconds')::interval
         FROM orders WHERE order_id = $2`,
      [orderId, SEEDED_ORDER, String(autoConfirmInMs)],
    );
    return orderId;
  };

  const sweeper = () =>
    new LifecycleScheduler(orders, noAdmins, {
      pickupTimeoutMs: 1_800_000,
      creditWaitTimeoutMs: 300_000,
      intervalMs: 10_000,
    });

  const requester = (orderId: string, action: 'CONFIRM_RECEIPT' | 'REPORT_NON_RECEIPT') =>
    orders.transition({
      orderId,
      action,
      actor: { kind: 'USER', id: REQUESTER, isAdmin: false },
      expectedVersion: 5,
      correlationId: 'corr',
    });

  const completionRequests = async (orderIds: string[]) =>
    db.query<{ aggregate_id: string }>(
      `SELECT aggregate_id FROM outbox_events WHERE event_type = $1 AND aggregate_id = ANY($2)`,
      [EVENTS.ORDER_COMPLETION_REQUESTED, orderIds],
    );

  it('gives one outcome when a report, a confirmation and the timer land together', async () => {
    const winners: Record<string, number> = {};
    for (let round = 0; round < 30; round++) {
      const orderId = await deliveredOrder(150);
      await new Promise((resolve) => setTimeout(resolve, 140 + (round % 5) * 5));
      // Holding the requester back a little in some rounds lets the timer win some of them too.
      const requesterLag = new Promise((resolve) => setTimeout(resolve, (round % 3) * 15));
      await Promise.all([
        requesterLag.then(() => requester(orderId, 'REPORT_NON_RECEIPT')),
        requesterLag.then(() => requester(orderId, 'CONFIRM_RECEIPT')),
        sweeper().sweep(),
        sweeper().sweep(),
        new Promise((resolve) => setTimeout(resolve, 20)).then(() => sweeper().sweep()),
      ]);
      await sweeper().sweep(); // whatever is still DELIVERED is now certainly due

      const order = await orders.findById(orderId);
      const history = await db.query<{ action: string }>(
        `SELECT action FROM order_status_history WHERE order_id = $1`,
        [orderId],
      );
      const completions = await completionRequests([orderId]);
      expect(order!.version).toBe(6);
      expect(history.rows).toHaveLength(1);
      if (history.rows[0]!.action === 'REPORT_NON_RECEIPT') {
        expect(order!.status).toBe('DISPUTED');
        expect(completions.rows).toHaveLength(0);
      } else {
        expect(order!.status).toBe('COMPLETION_PENDING_CREDIT');
        expect(completions.rows).toHaveLength(1);
      }
      winners[history.rows[0]!.action] = (winners[history.rows[0]!.action] ?? 0) + 1;
    }
    console.log('report-vs-confirm-vs-auto-confirm winners', winners);
    expect(Object.values(winners).reduce((sum, n) => sum + n, 0)).toBe(30);
  });

  it('confirms each overdue errand once across many concurrent scheduler instances', async () => {
    const ids = await Promise.all(Array.from({ length: 25 }, () => deliveredOrder(-1_000)));
    await Promise.all(Array.from({ length: 6 }, () => sweeper().sweep()));
    const completions = await completionRequests(ids);
    expect(completions.rows).toHaveLength(25);
    expect(new Set(completions.rows.map((row) => row.aggregate_id)).size).toBe(25);
  });
});
