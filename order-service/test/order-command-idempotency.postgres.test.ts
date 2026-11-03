import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDb } from '@foc/platform';
import type { AuthContext } from '@foc/auth-client';
import {
  createEphemeralPostgres,
  TEST_POSTGRES_URL,
  type EphemeralPostgres,
} from '@foc/test-harness';
import { OrdersRepository } from '../src/orders/orders.repository.js';
import { OrdersService } from '../src/orders/orders.service.js';
import { SupplierClient } from '../src/orders/supplier.client.js';

const suite = TEST_POSTGRES_URL ? describe : describe.skip;
const SEEDED_ORDER = '00000000-0000-4000-8000-000000000129';

const courier: AuthContext = {
  userId: 'courier-1',
  sessionId: 'courier-session',
  displayName: 'Courier',
  roles: ['STUDENT'],
  status: 'ACTIVE',
  isAdmin: false,
};

/** One Order Service instance's command handling, over its own pool. */
const instanceOver = (db: PgDb) =>
  new OrdersService(
    new OrdersRepository(db),
    new SupplierClient(async () => {
      throw new Error('Commands never ask the Supplier Service.');
    }),
  );

/** What a caller sees, without the server's clock reading, which a replay refreshes. */
const answer = (outcome: PromiseSettledResult<{ serverTime: string }>) => {
  if (outcome.status === 'rejected') {
    const error = outcome.reason as { status?: number; code?: string };
    return { status: error.status, code: error.code };
  }
  const { serverTime: _serverTime, ...view } = outcome.value;
  return view;
};

suite('Order command idempotency on real PostgreSQL (OS-FR7.1.1)', () => {
  let database: EphemeralPostgres;
  let service: OrdersService;

  beforeAll(async () => {
    database = await createEphemeralPostgres({
      adminUrl: TEST_POSTGRES_URL!,
      label: 'order_command_idempotency',
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    service = instanceOver(database.db);
  });

  afterAll(async () => database?.dispose());

  /** A fresh OPEN order cloned from the seed, so the suite reruns against a reused database. */
  const openOrder = async () => {
    const orderId = randomUUID();
    await database.db.query(
      `INSERT INTO orders (order_id, requester_id, supplier_snapshot, items, delivery_zone,
                           delivery_instructions, reward, status, version, acceptance_deadline_at)
       SELECT $1, requester_id, supplier_snapshot, items, delivery_zone, delivery_instructions,
              reward, 'OPEN', 2, now() + interval '60 minutes'
         FROM orders WHERE order_id = $2`,
      [orderId, SEEDED_ORDER],
    );
    return orderId;
  };

  const historyOf = async (orderId: string) =>
    (
      await database.db.query(`SELECT new_status FROM order_status_history WHERE order_id = $1`, [
        orderId,
      ])
    ).rows;

  it.each([
    [
      'accept',
      async (orderId: string, key: string) =>
        service.accept(orderId, 2, courier, randomUUID(), key),
    ],
    [
      'pickup',
      async (orderId: string, key: string) =>
        service.command(orderId, 'RECORD_PICKUP', 3, courier, randomUUID(), {
          idempotencyKey: key,
        }),
    ],
  ])(
    '20 concurrent sends of one %s with one key apply it once and all get the same answer',
    async (name, send) => {
      const orderId = await openOrder();
      if (name === 'pickup') await service.accept(orderId, 2, courier, randomUUID());
      const before = (await historyOf(orderId)).length;

      const key = randomUUID();
      const outcomes = await Promise.allSettled(
        Array.from({ length: 20 }, () => send(orderId, key)),
      );

      const answers = outcomes.map(answer);
      expect(answers[0]).toMatchObject({ orderId, courierId: courier.userId });
      expect(answers).toEqual(Array(20).fill(answers[0]));
      expect(await historyOf(orderId)).toHaveLength(before + 1);
    },
  );

  it('concurrent sends of one key with different requests apply one and refuse the rest', async () => {
    const orderIds = await Promise.all(Array.from({ length: 20 }, openOrder));
    const key = randomUUID();

    const outcomes = await Promise.allSettled(
      orderIds.map((orderId) => service.accept(orderId, 2, courier, randomUUID(), key)),
    );

    const applied = outcomes.flatMap((o) => (o.status === 'fulfilled' ? [o.value.orderId] : []));
    expect(applied).toHaveLength(1);
    expect(outcomes.map(answer).filter((a) => 'code' in a)).toEqual(
      Array(19).fill({ status: 422, code: 'IDEMPOTENCY_KEY_REUSED' }),
    );
    const histories = await Promise.all(orderIds.map(historyOf));
    expect(histories.map((rows) => rows.length)).toEqual(
      orderIds.map((orderId) => (orderId === applied[0] ? 1 : 0)),
    );
  });

  it('an instance started after another stopped replays what the first recorded', async () => {
    const orderId = await openOrder();
    const key = randomUUID();
    const firstPool = new PgDb(database.url);
    const first = await instanceOver(firstPool).accept(orderId, 2, courier, randomUUID(), key);
    await firstPool.close();

    const secondPool = new PgDb(database.url);
    try {
      const replay = await instanceOver(secondPool).accept(orderId, 2, courier, randomUUID(), key);
      expect(answer({ status: 'fulfilled', value: replay })).toEqual(
        answer({ status: 'fulfilled', value: first }),
      );
      expect(await historyOf(orderId)).toHaveLength(1);
    } finally {
      await secondPool.close();
    }
  });
});
