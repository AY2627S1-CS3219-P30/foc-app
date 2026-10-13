import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgDb } from '@foc/platform';
import {
  createEphemeralPostgres,
  TEST_POSTGRES_URL,
  type EphemeralPostgres,
} from '@foc/test-harness';
import { CreditRepository } from '../src/credits/credit.repository.js';

const suite = TEST_POSTGRES_URL ? describe : describe.skip;

suite('reservation concurrency on real PostgreSQL', () => {
  let database: EphemeralPostgres;
  let db: PgDb;
  let credits: CreditRepository;

  beforeAll(async () => {
    // A fresh migrated database per run: no shared developer data, safe to rerun (#145).
    database = await createEphemeralPostgres({
      adminUrl: TEST_POSTGRES_URL!,
      label: 'credit',
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    db = database.db;
    // Nest normally supplies this token; this focused integration test drives
    // the same repository against a real pool with several connections.
    credits = new CreditRepository(db);
  });

  afterAll(async () => database?.dispose());

  it('serializes conditional debits so only one overspending request succeeds', async () => {
    const userId = randomUUID();
    await db.transaction((tx) => credits.issueInitial(tx, userId));
    await db.transaction((tx) =>
      credits.reserve(tx, {
        orderId: randomUUID(),
        requesterId: userId,
        amount: 5,
        correlationId: randomUUID(),
        causationId: randomUUID(),
      }),
    );

    const reserve = (orderId: string) =>
      db.transaction((tx) =>
        credits.reserve(tx, {
          orderId,
          requesterId: userId,
          amount: 4,
          correlationId: randomUUID(),
          causationId: randomUUID(),
        }),
      );
    const outcomes = await Promise.all([reserve(randomUUID()), reserve(randomUUID())]);

    expect(outcomes.filter((outcome) => outcome.status === 'RESERVED')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'REJECTED')).toHaveLength(1);
    const wallet = await db.query<
      { available: number; reserved: number } & Record<string, unknown>
    >(`SELECT available, reserved FROM wallets WHERE user_id = $1`, [userId]);
    expect(wallet.rows[0]).toMatchObject({ available: 1, reserved: 9 });
  });

  it('serializes transfer against release so exactly one terminal movement wins', async () => {
    const requesterId = randomUUID();
    const courierId = randomUUID();
    const orderId = randomUUID();
    await db.transaction((tx) => credits.issueInitial(tx, requesterId));
    await db.transaction((tx) => credits.issueInitial(tx, courierId));
    await db.transaction((tx) =>
      credits.reserve(tx, {
        orderId,
        requesterId,
        amount: 4,
        correlationId: randomUUID(),
        causationId: randomUUID(),
      }),
    );

    const [transfer, release] = await Promise.all([
      db.transaction((tx) =>
        credits.transfer(tx, {
          orderId,
          requesterId,
          courierId,
          amount: 4,
          correlationId: randomUUID(),
          causationId: randomUUID(),
        }),
      ),
      db.transaction((tx) =>
        credits.release(tx, {
          orderId,
          requesterId,
          amount: 4,
          correlationId: randomUUID(),
          causationId: randomUUID(),
        }),
      ),
    ]);

    expect(
      [transfer.status, release.status].filter((status) => status !== 'REJECTED'),
    ).toHaveLength(1);
    const terminals = await db.query<{ transaction_type: string } & Record<string, unknown>>(
      `SELECT transaction_type
         FROM credit_transactions
        WHERE order_id = $1 AND transaction_type IN ('TRANSFER', 'RELEASE')`,
      [orderId],
    );
    expect(terminals.rows).toHaveLength(1);

    const wallets = await db.query<
      { user_id: string; available: number; reserved: number } & Record<string, unknown>
    >(
      `SELECT user_id, available, reserved
         FROM wallets
        WHERE user_id IN ($1, $2)
        ORDER BY user_id`,
      [requesterId, courierId],
    );
    const total = wallets.rows.reduce(
      (sum, row) => sum + Number(row.available) + Number(row.reserved),
      0,
    );
    expect(total).toBe(20);
    expect(wallets.rows.every((row) => row.available >= 0 && row.reserved >= 0)).toBe(true);
  });
});
