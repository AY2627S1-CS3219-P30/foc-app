import { afterEach, describe, expect, it } from 'vitest';
import { WalletNotReadyError } from '../src/credits/credit.repository.js';
import type { ReservationBoundary } from '../src/credits/types.js';
import { createTestApp, issue, type TestApp } from './helpers/app.js';

const input = (overrides: Partial<Parameters<TestApp['credits']['reserve']>[1]> = {}) => ({
  orderId: 'order-1',
  requesterId: 'student-1',
  amount: 3,
  correlationId: 'corr-1',
  causationId: 'event-1',
  ...overrides,
});

describe('asynchronous reservation (CRD-02)', () => {
  let testApp: TestApp | undefined;

  afterEach(async () => testApp?.close());

  it('applies 100 repeated business requests once and reproduces their success outcome', async () => {
    testApp = await createTestApp();
    await issue(testApp, 'student-1');
    const outcomes = [];
    for (let copy = 0; copy < 100; copy++) {
      outcomes.push(
        await testApp.db.transaction((tx) =>
          testApp!.credits.reserve(tx, input({ causationId: `event-${copy}` })),
        ),
      );
    }

    expect(new Set(outcomes.map((outcome) => JSON.stringify(outcome))).size).toBe(1);
    const wallet = await testApp.db.query(
      `SELECT available, reserved FROM wallets WHERE user_id = 'student-1'`,
    );
    const movements = await testApp.db.query(
      `SELECT transaction_id FROM credit_transactions WHERE transaction_type = 'RESERVE'`,
    );
    const replies = await testApp.db.query(
      `SELECT id FROM outbox_events WHERE event_type = 'credit.reserved'`,
    );
    expect(wallet.rows[0]).toMatchObject({ available: 7, reserved: 3 });
    expect(movements.rows).toHaveLength(1);
    expect(replies.rows).toHaveLength(100);
    const balance = await testApp.db.query<
      { transaction_id: string; debits: number; credits: number } & Record<string, unknown>
    >(
      `SELECT transaction_id,
              sum(amount) FILTER (WHERE direction = 'DEBIT')::integer AS debits,
              sum(amount) FILTER (WHERE direction = 'CREDIT')::integer AS credits
         FROM ledger_entries
        GROUP BY transaction_id`,
    );
    expect(balance.rows.every((row) => row.debits === row.credits)).toBe(true);
  });

  it('rejects insufficient credits with required and available amounts', async () => {
    testApp = await createTestApp();
    await issue(testApp, 'student-1');
    await testApp.db.query(`UPDATE wallets SET available = 2 WHERE user_id = 'student-1'`);
    const outcome = await testApp.db.transaction((tx) => testApp!.credits.reserve(tx, input()));
    expect(outcome).toEqual({
      status: 'REJECTED',
      reason: 'INSUFFICIENT_CREDITS',
      available: 2,
    });
    const reply = await testApp.db.query<
      { payload: Record<string, unknown> } & Record<string, unknown>
    >(`SELECT payload FROM outbox_events WHERE event_type = 'credit.reservation-rejected'`);
    expect(reply.rows[0]!.payload).toMatchObject({ amount: 3, available: 2 });
  });

  it('rejects an amount outside one to five without changing the wallet', async () => {
    testApp = await createTestApp();
    await issue(testApp, 'student-1');
    const outcome = await testApp.db.transaction((tx) =>
      testApp!.credits.reserve(tx, input({ amount: 6 })),
    );
    expect(outcome).toEqual({ status: 'REJECTED', reason: 'AMOUNT_OUT_OF_RANGE' });
    const wallet = await testApp.db.query(`SELECT available, reserved FROM wallets`);
    expect(wallet.rows[0]).toMatchObject({ available: 10, reserved: 0 });
  });

  it('retries a missing wallet rather than recording a terminal rejection', async () => {
    testApp = await createTestApp();
    await expect(
      testApp.db.transaction((tx) =>
        testApp!.credits.reserve(tx, input({ requesterId: 'not-activated' })),
      ),
    ).rejects.toBeInstanceOf(WalletNotReadyError);
    expect((await testApp.db.query(`SELECT * FROM credit_operations`)).rows).toHaveLength(0);
    expect((await testApp.db.query(`SELECT * FROM outbox_events`)).rows).toHaveLength(0);
  });

  it('refuses conflicting facts for one order id and raises an audit alert', async () => {
    testApp = await createTestApp();
    await issue(testApp, 'student-1');
    await testApp.db.transaction((tx) => testApp!.credits.reserve(tx, input()));
    const conflict = await testApp.db.transaction((tx) =>
      testApp!.credits.reserve(tx, input({ amount: 4, causationId: 'event-conflict' })),
    );
    expect(conflict).toEqual({ status: 'REJECTED', reason: 'CONFLICTING_REQUEST' });
    expect((await testApp.db.query(`SELECT * FROM credit_audit_alerts`)).rows).toHaveLength(1);
    const wallet = await testApp.db.query(`SELECT available, reserved FROM wallets`);
    expect(wallet.rows[0]).toMatchObject({ available: 7, reserved: 3 });
  });

  it('allows exactly one of two concurrent reservations that together exceed available', async () => {
    testApp = await createTestApp();
    await issue(testApp, 'student-1');
    await testApp.db.transaction((tx) =>
      testApp!.credits.reserve(tx, input({ orderId: 'prior', amount: 5 })),
    );
    const outcomes = await Promise.all([
      testApp.db.transaction((tx) =>
        testApp!.credits.reserve(tx, input({ orderId: 'race-a', amount: 4 })),
      ),
      testApp.db.transaction((tx) =>
        testApp!.credits.reserve(tx, input({ orderId: 'race-b', amount: 4 })),
      ),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'RESERVED')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'REJECTED')).toHaveLength(1);
    const wallet = await testApp.db.query(`SELECT available, reserved FROM wallets`);
    expect(wallet.rows[0]).toMatchObject({ available: 1, reserved: 9 });
  });

  it.each<ReservationBoundary>([
    'operation-claimed',
    'wallet-updated',
    'transaction-written',
    'ledger-written',
    'operation-finalized',
    'outbox-written',
  ])('rolls back the complete reservation when %s fails', async (failedBoundary) => {
    testApp = await createTestApp();
    await issue(testApp, 'student-1');
    await expect(
      testApp.db.transaction((tx) =>
        testApp!.credits.reserve(tx, input(), (boundary) => {
          if (boundary === failedBoundary) throw new Error(`fault at ${boundary}`);
        }),
      ),
    ).rejects.toThrow(`fault at ${failedBoundary}`);
    const wallet = await testApp.db.query(`SELECT available, reserved FROM wallets`);
    expect(wallet.rows[0]).toMatchObject({ available: 10, reserved: 0 });
    expect(
      (
        await testApp.db.query(
          `SELECT * FROM credit_transactions WHERE transaction_type = 'RESERVE'`,
        )
      ).rows,
    ).toHaveLength(0);
    expect((await testApp.db.query(`SELECT * FROM credit_operations`)).rows).toHaveLength(0);
    expect((await testApp.db.query(`SELECT * FROM outbox_events`)).rows).toHaveLength(0);
  });
});
