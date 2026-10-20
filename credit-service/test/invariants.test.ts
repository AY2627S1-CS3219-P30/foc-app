import { afterEach, describe, expect, it } from 'vitest';
import { reservedBackingViolations } from '../src/credits/invariants.js';
import { createTestApp, issue, type TestApp } from './helpers/app.js';

async function reserve(testApp: TestApp, orderId: string, amount: number): Promise<void> {
  await testApp.db.transaction((tx) =>
    testApp.credits.reserve(tx, {
      orderId,
      requesterId: 'student-1',
      amount,
      correlationId: `corr-${orderId}`,
      causationId: `reserve-${orderId}`,
    }),
  );
}

/** The other closed-economy checks, as `system-tests/src/invariants.ts` states them. */
async function otherInvariantsHold(testApp: TestApp): Promise<boolean> {
  const result = await testApp.db.query<{ ok: boolean } & Record<string, unknown>>(
    `SELECT
       NOT EXISTS (SELECT 1 FROM wallets WHERE available < 0 OR reserved < 0)
       AND NOT EXISTS (
         SELECT 1 FROM ledger_entries GROUP BY transaction_id
         HAVING coalesce(sum(amount) FILTER (WHERE direction = 'DEBIT'), 0)
             <> coalesce(sum(amount) FILTER (WHERE direction = 'CREDIT'), 0))
       AND (SELECT coalesce(sum(available + reserved), 0) FROM wallets)
         = (SELECT coalesce(sum(amount), 0) FROM credit_transactions WHERE transaction_type = 'ISSUE')
       AND NOT EXISTS (
         SELECT 1 FROM credit_transactions WHERE order_id IS NOT NULL GROUP BY order_id
         HAVING count(*) FILTER (WHERE transaction_type = 'RESERVE') > 1
             OR count(*) FILTER (WHERE transaction_type IN ('TRANSFER', 'RELEASE')) > 1)
       AS ok`,
  );
  return result.rows[0]!.ok;
}

describe("a wallet's reserved credits are its open reservations (CRD-09, D3 Part 2.1)", () => {
  let testApp: TestApp | undefined;
  afterEach(async () => testApp?.close());

  it('holds through reservation, transfer, release and a rejected reservation', async () => {
    testApp = await createTestApp();
    await issue(testApp, 'student-1');
    await issue(testApp, 'courier-1');
    expect(await reservedBackingViolations(testApp.db)).toEqual([]);

    await reserve(testApp, 'order-paid', 3);
    await reserve(testApp, 'order-cancelled', 2);
    await reserve(testApp, 'order-open', 4);
    await reserve(testApp, 'order-too-big', 6); // refused: no transaction, nothing reserved
    expect(await reservedBackingViolations(testApp.db)).toEqual([]);

    await testApp.db.transaction((tx) =>
      testApp!.credits.transfer(tx, {
        orderId: 'order-paid',
        requesterId: 'student-1',
        courierId: 'courier-1',
        amount: 3,
        correlationId: 'corr-order-paid',
        causationId: 'complete-order-paid',
      }),
    );
    await testApp.db.transaction((tx) =>
      testApp!.credits.release(tx, {
        orderId: 'order-cancelled',
        requesterId: 'student-1',
        amount: 2,
        correlationId: 'corr-order-cancelled',
        causationId: 'release-order-cancelled',
      }),
    );

    const wallet = await testApp.db.query(
      `SELECT available, reserved FROM wallets WHERE user_id = 'student-1'`,
    );
    expect(wallet.rows).toEqual([{ available: 3, reserved: 4 }]);
    expect(await reservedBackingViolations(testApp.db)).toEqual([]);
    expect(await otherInvariantsHold(testApp)).toBe(true);
  });

  it('catches reserved credit that no reservation backs, which every other check misses', async () => {
    testApp = await createTestApp();
    await issue(testApp, 'student-1');
    await reserve(testApp, 'order-open', 3);

    // A credit moved to reserved outside any errand: nothing would ever release or pay it out.
    await testApp.db.query(
      `UPDATE wallets SET available = available - 1, reserved = reserved + 1
        WHERE user_id = 'student-1'`,
    );

    expect(await otherInvariantsHold(testApp)).toBe(true);
    expect(await reservedBackingViolations(testApp.db)).toEqual([
      'wallet student-1 holds 4 reserved but its open reservations total 3',
    ]);
  });

  it('catches a reservation whose credits left reserved without a transfer or release', async () => {
    testApp = await createTestApp();
    await issue(testApp, 'student-1');
    await reserve(testApp, 'order-open', 3);

    await testApp.db.query(
      `UPDATE wallets SET available = available + 3, reserved = 0 WHERE user_id = 'student-1'`,
    );

    expect(await otherInvariantsHold(testApp)).toBe(true);
    expect(await reservedBackingViolations(testApp.db)).toEqual([
      'wallet student-1 holds 0 reserved but its open reservations total 3',
    ]);
  });
});
