import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EVENTS,
  createEnvelope,
  withInbox,
  type CreditsTransferredPayload,
  type EventConsumer,
} from '@foc/platform';
import type { PgDb } from '@foc/platform';
import {
  createEphemeralPostgres,
  TEST_POSTGRES_URL,
  type EphemeralPostgres,
} from '@foc/test-harness';
import {
  CreditTerminalResultsConsumer,
  TRANSFER_RESULTS_QUEUE,
} from '../src/credit-terminal-results.consumer.js';
import { OrdersRepository } from '../src/orders/orders.repository.js';

const suite = TEST_POSTGRES_URL ? describe : describe.skip;
const SEEDED_ORDER = '00000000-0000-4000-8000-000000000129';

suite('completion saga under concurrent delivery on real PostgreSQL', () => {
  let database: EphemeralPostgres;
  let db: PgDb;
  let orders: OrdersRepository;
  let consumer: CreditTerminalResultsConsumer;

  beforeAll(async () => {
    database = await createEphemeralPostgres({
      adminUrl: TEST_POSTGRES_URL!,
      label: 'order_completion',
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    db = database.db;
    orders = new OrdersRepository(db);
    consumer = new CreditTerminalResultsConsumer({} as EventConsumer, db, orders);
  });
  afterAll(async () => database?.dispose());

  async function deliveredOrder(): Promise<string> {
    const orderId = randomUUID();
    await db.query(
      `INSERT INTO orders (order_id, requester_id, supplier_snapshot, items, delivery_zone,
                           delivery_instructions, reward, status, version, acceptance_deadline_at)
       SELECT $1, requester_id, supplier_snapshot, items, delivery_zone, delivery_instructions,
              reward, 'OPEN', 2, now() + interval '60 minutes'
         FROM orders WHERE order_id = $2`,
      [orderId, SEEDED_ORDER],
    );
    expect((await orders.accept(orderId, 'courier-pg', 2, 'corr')).accepted).toBe(true);
    for (const action of ['RECORD_PICKUP', 'RECORD_DELIVERY'] as const) {
      const step = await orders.transition({
        orderId,
        action,
        actor: { kind: 'USER', id: 'courier-pg', isAdmin: false },
        correlationId: 'corr',
      });
      expect(step.kind).toBe('applied');
    }
    return orderId;
  }

  it('lets one of many simultaneous confirmations through', async () => {
    const orderId = await deliveredOrder();
    const attempts = await Promise.all(
      Array.from({ length: 30 }, () =>
        orders.transition({
          orderId,
          action: 'CONFIRM_RECEIPT',
          expectedVersion: 5,
          actor: { kind: 'USER', id: 'seed-requester', isAdmin: false },
          correlationId: 'corr',
        }),
      ),
    );
    expect(attempts.filter((attempt) => attempt.kind === 'applied')).toHaveLength(1);
    const requests = await db.query(
      `SELECT * FROM outbox_events WHERE aggregate_id = $1 AND event_type = $2`,
      [orderId, EVENTS.ORDER_COMPLETION_REQUESTED],
    );
    expect(requests.rows).toHaveLength(1);
  });

  it('completes once when many transfer confirmations arrive at the same time', async () => {
    const orderId = await deliveredOrder();
    await orders.transition({
      orderId,
      action: 'CONFIRM_RECEIPT',
      actor: { kind: 'USER', id: 'seed-requester', isAdmin: false },
      correlationId: 'corr',
    });
    const transactionId = randomUUID();
    const handle = withInbox<CreditsTransferredPayload>(
      db,
      TRANSFER_RESULTS_QUEUE,
      async (envelope, tx) => {
        await consumer.handleTransfer(envelope, tx);
      },
    );
    const envelope = (eventId: string) =>
      createEnvelope<CreditsTransferredPayload>({
        eventId,
        eventType: EVENTS.CREDITS_TRANSFERRED,
        schemaVersion: 1,
        aggregateId: orderId,
        producer: 'credit-service',
        correlationId: 'corr',
        payload: {
          orderId,
          requesterId: 'seed-requester',
          courierId: 'courier-pg',
          amount: 2,
          transactionId,
          requesterBalance: { available: 8, reserved: 0, total: 8 },
          courierBalance: { available: 12, reserved: 0, total: 12 },
        },
      });
    // Redeliveries of one message and Credit re-emissions under new IDs, all at once.
    const shared = randomUUID();
    const outcomes = await Promise.allSettled([
      ...Array.from({ length: 15 }, () =>
        handle(envelope(shared), { attempt: 1, queue: TRANSFER_RESULTS_QUEUE }),
      ),
      ...Array.from({ length: 15 }, () =>
        handle(envelope(randomUUID()), { attempt: 1, queue: TRANSFER_RESULTS_QUEUE }),
      ),
    ]);
    // Concurrent duplicates of one event ID may lose the inbox insert race; the broker retries them.
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected')
        expect(String(outcome.reason)).toMatch(/duplicate key|processed_events/);
    }

    expect(await orders.findById(orderId)).toMatchObject({
      status: 'COMPLETED',
      creditTransactionId: transactionId,
      version: 7,
    });
    const receipts = await db.query(`SELECT * FROM order_receipts WHERE order_id = $1`, [orderId]);
    expect(receipts.rows).toHaveLength(1);
    const completions = await db.query(
      `SELECT * FROM order_status_history WHERE order_id = $1 AND new_status = 'COMPLETED'`,
      [orderId],
    );
    expect(completions.rows).toHaveLength(1);
  });
});
