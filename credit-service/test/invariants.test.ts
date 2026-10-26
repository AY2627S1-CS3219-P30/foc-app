import { afterEach, describe, expect, it } from 'vitest';
import {
  CREDIT_INVARIANTS,
  creditEconomyViolations,
  reservedBackingViolations,
} from '../src/credits/invariants.js';
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

/** Every invariant except the one CRD-09 adds, run exactly as the services' suites run them. */
async function otherInvariantsHold(testApp: TestApp): Promise<boolean> {
  const others = Object.values(CREDIT_INVARIANTS).filter(
    (check) => check !== reservedBackingViolations,
  );
  expect(others).toHaveLength(Object.keys(CREDIT_INVARIANTS).length - 1);
  for (const check of others) if ((await check(testApp.db)).length > 0) return false;
  return true;
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

  it('is part of the full set the cross-service suite and the live check run', async () => {
    testApp = await createTestApp();
    await issue(testApp, 'student-1');
    await reserve(testApp, 'order-open', 3);
    expect(await creditEconomyViolations(testApp.db)).toEqual([]);

    await testApp.db.query(
      `UPDATE wallets SET available = available - 1, reserved = reserved + 1
        WHERE user_id = 'student-1'`,
    );
    expect(await creditEconomyViolations(testApp.db)).toEqual([
      'wallet student-1 holds 4 reserved but its open reservations total 3',
    ]);
  });
});
