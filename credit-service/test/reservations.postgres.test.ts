import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgDb, runDrizzleMigrations } from '@foc/platform';
import { CreditRepository } from '../src/credits/credit.repository.js';

const DATABASE = process.env.TEST_CREDIT_DATABASE_URL;
const suite = DATABASE ? describe : describe.skip;

suite('reservation concurrency on real PostgreSQL', () => {
  let db: PgDb;
  let credits: CreditRepository;

  beforeAll(async () => {
    db = new PgDb(DATABASE!);
    await runDrizzleMigrations(DATABASE!, fileURLToPath(new URL('../drizzle', import.meta.url)));
    // Nest normally supplies this token; this focused integration test drives
    // the same repository against a real pool with several connections.
    credits = new CreditRepository(db);
  });

  afterAll(async () => db?.close());

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
});
