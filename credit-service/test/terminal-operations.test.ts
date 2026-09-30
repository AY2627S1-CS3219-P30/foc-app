import { afterEach, describe, expect, it } from 'vitest';
import { ReservationNotReadyError, WalletNotReadyError } from '../src/credits/credit.repository.js';
import type { ReleaseInput, TerminalBoundary, TransferInput } from '../src/credits/types.js';
import { createTestApp, issue, type TestApp } from './helpers/app.js';

const transferInput = (overrides: Partial<TransferInput> = {}): TransferInput => ({
  orderId: 'order-1',
  requesterId: 'student-1',
  courierId: 'courier-1',
  amount: 3,
  correlationId: 'corr-1',
  causationId: 'completion-1',
  ...overrides,
});

const releaseInput = (overrides: Partial<ReleaseInput> = {}): ReleaseInput => ({
  orderId: 'order-1',
  requesterId: 'student-1',
  amount: 3,
  correlationId: 'corr-1',
  causationId: 'release-1',
  ...overrides,
});

async function arrangeReservation(testApp: TestApp): Promise<void> {
  await issue(testApp, 'student-1');
  await testApp.db.transaction((tx) =>
    testApp.credits.reserve(tx, {
      orderId: 'order-1',
      requesterId: 'student-1',
      amount: 3,
      correlationId: 'corr-1',
      causationId: 'reservation-1',
    }),
  );
}

async function wallet(testApp: TestApp, userId: string) {
  const result = await testApp.db.query<
    { available: number; reserved: number } & Record<string, unknown>
  >(`SELECT available, reserved FROM wallets WHERE user_id = $1`, [userId]);
  return result.rows[0];
}

describe('atomic completion transfer (CRD-03)', () => {
  let testApp: TestApp | undefined;
  afterEach(async () => testApp?.close());

  it('applies 100 repeated requests once and republishes one identical recorded result', async () => {
    testApp = await createTestApp();
    await arrangeReservation(testApp);
    await issue(testApp, 'courier-1');

    const outcomes = [];
    for (let copy = 0; copy < 100; copy++) {
      outcomes.push(
        await testApp.db.transaction((tx) =>
          testApp!.credits.transfer(tx, transferInput({ causationId: `completion-${copy}` })),
        ),
      );
    }

    expect(outcomes).toEqual(Array.from({ length: 100 }, () => outcomes[0]));
    expect(await wallet(testApp, 'student-1')).toMatchObject({ available: 7, reserved: 0 });
    expect(await wallet(testApp, 'courier-1')).toMatchObject({ available: 13, reserved: 0 });
    expect(
      (
        await testApp.db.query(
          `SELECT transaction_id FROM credit_transactions WHERE transaction_type = 'TRANSFER'`,
        )
      ).rows,
    ).toHaveLength(1);
    const replies = await testApp.db.query<{ payload: unknown } & Record<string, unknown>>(
      `SELECT payload FROM outbox_events WHERE event_type = 'credit.transferred' ORDER BY seq`,
    );
    expect(replies.rows).toHaveLength(100);
    expect(replies.rows.map((row) => row.payload)).toEqual(
      Array.from({ length: 100 }, () => replies.rows[0]!.payload),
    );

    const ledger = await testApp.db.query<
      { direction: string; account: string; wallet_user_id: string } & Record<string, unknown>
    >(
      `SELECT e.direction, e.account, e.wallet_user_id
         FROM ledger_entries e
         JOIN credit_transactions t USING (transaction_id)
        WHERE t.transaction_type = 'TRANSFER'
        ORDER BY entry_no`,
    );
    expect(ledger.rows).toEqual([
      { direction: 'DEBIT', account: 'RESERVED', wallet_user_id: 'student-1' },
      { direction: 'CREDIT', account: 'AVAILABLE', wallet_user_id: 'courier-1' },
    ]);
  });

  it('replays the recorded confirmation after the first confirmation is lost', async () => {
    testApp = await createTestApp();
    await arrangeReservation(testApp);
    await issue(testApp, 'courier-1');
    const first = await testApp.db.transaction((tx) =>
      testApp!.credits.transfer(tx, transferInput()),
    );
    await testApp.db.query(
      `UPDATE outbox_events SET published_at = now()
        WHERE event_type = 'credit.transferred'`,
    );
    const replay = await testApp.db.transaction((tx) =>
      testApp!.credits.transfer(tx, transferInput({ causationId: 'completion-redelivery' })),
    );
    expect(replay).toEqual(first);
    expect(await wallet(testApp, 'student-1')).toMatchObject({ available: 7, reserved: 0 });
    expect(await wallet(testApp, 'courier-1')).toMatchObject({ available: 13, reserved: 0 });
    expect(
      (
        await testApp.db.query(
          `SELECT transaction_id FROM credit_transactions WHERE transaction_type = 'TRANSFER'`,
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await testApp.db.query(
          `SELECT payload FROM outbox_events WHERE event_type = 'credit.transferred'`,
        )
      ).rows,
    ).toHaveLength(2);
  });

  it('makes the finalized recorded result immutable', async () => {
    testApp = await createTestApp();
    await arrangeReservation(testApp);
    await issue(testApp, 'courier-1');
    await testApp.db.transaction((tx) => testApp!.credits.transfer(tx, transferInput()));

    await expect(
      testApp.db.query(
        `UPDATE credit_operations SET result_payload = '{}'::jsonb
          WHERE order_id = 'order-1' AND operation_type = 'TRANSFER'`,
      ),
    ).rejects.toThrow(/finalized credit operation is immutable/);
    await expect(
      testApp.db.query(
        `DELETE FROM credit_operations
          WHERE order_id = 'order-1' AND operation_type = 'TRANSFER'`,
      ),
    ).rejects.toThrow(/finalized credit operation is immutable/);
  });

  it('audits a requester or amount mismatch without changing either wallet', async () => {
    testApp = await createTestApp();
    await arrangeReservation(testApp);
    await issue(testApp, 'student-2');
    await issue(testApp, 'courier-1');
    const outcome = await testApp.db.transaction((tx) =>
      testApp!.credits.transfer(
        tx,
        transferInput({ requesterId: 'student-2', amount: 2, causationId: 'bad-completion' }),
      ),
    );
    expect(outcome).toEqual({ status: 'REJECTED', reason: 'CONFLICTING_REQUEST' });
    expect(await wallet(testApp, 'student-1')).toMatchObject({ available: 7, reserved: 3 });
    expect(await wallet(testApp, 'courier-1')).toMatchObject({ available: 10, reserved: 0 });
    expect((await testApp.db.query(`SELECT * FROM credit_audit_alerts`)).rows).toHaveLength(1);
    expect(
      (
        await testApp.db.query(
          `SELECT * FROM credit_transactions WHERE transaction_type = 'TRANSFER'`,
        )
      ).rows,
    ).toHaveLength(0);
  });

  it('rejects a self-transfer and records an audit alert', async () => {
    testApp = await createTestApp();
    await arrangeReservation(testApp);
    const outcome = await testApp.db.transaction((tx) =>
      testApp!.credits.transfer(tx, transferInput({ courierId: 'student-1' })),
    );
    expect(outcome).toEqual({ status: 'REJECTED', reason: 'INVALID_PARTICIPANTS' });
    expect(await wallet(testApp, 'student-1')).toMatchObject({ available: 7, reserved: 3 });
    expect((await testApp.db.query(`SELECT * FROM credit_audit_alerts`)).rows).toHaveLength(1);
  });

  it('retries a missing courier wallet and rolls back the requester debit', async () => {
    testApp = await createTestApp();
    await arrangeReservation(testApp);
    await expect(
      testApp.db.transaction((tx) => testApp!.credits.transfer(tx, transferInput())),
    ).rejects.toBeInstanceOf(WalletNotReadyError);
    expect(await wallet(testApp, 'student-1')).toMatchObject({ available: 7, reserved: 3 });
    expect(
      (await testApp.db.query(`SELECT * FROM credit_operations WHERE operation_type = 'TRANSFER'`))
        .rows,
    ).toHaveLength(0);
  });

  it('retries when the matching reservation has not arrived', async () => {
    testApp = await createTestApp();
    await issue(testApp, 'student-1');
    await issue(testApp, 'courier-1');
    await expect(
      testApp.db.transaction((tx) => testApp!.credits.transfer(tx, transferInput())),
    ).rejects.toBeInstanceOf(ReservationNotReadyError);
    expect((await testApp.db.query(`SELECT * FROM credit_audit_alerts`)).rows).toHaveLength(0);
  });

  it.each<TerminalBoundary>([
    'reservation-locked',
    'operation-claimed',
    'requester-wallet-updated',
    'courier-wallet-updated',
    'transaction-written',
    'ledger-written',
    'operation-finalized',
    'outbox-written',
  ])('rolls back the whole transfer when %s fails', async (failedBoundary) => {
    testApp = await createTestApp();
    await arrangeReservation(testApp);
    await issue(testApp, 'courier-1');
    await expect(
      testApp.db.transaction((tx) =>
        testApp!.credits.transfer(tx, transferInput(), (boundary) => {
          if (boundary === failedBoundary) throw new Error(`fault at ${boundary}`);
        }),
      ),
    ).rejects.toThrow(`fault at ${failedBoundary}`);
    expect(await wallet(testApp, 'student-1')).toMatchObject({ available: 7, reserved: 3 });
    expect(await wallet(testApp, 'courier-1')).toMatchObject({ available: 10, reserved: 0 });
    expect(
      (
        await testApp.db.query(
          `SELECT * FROM credit_transactions WHERE transaction_type = 'TRANSFER'`,
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (await testApp.db.query(`SELECT * FROM credit_operations WHERE operation_type = 'TRANSFER'`))
        .rows,
    ).toHaveLength(0);
    expect(
      (
        await testApp.db.query(
          `SELECT * FROM outbox_events WHERE event_type = 'credit.transferred'`,
        )
      ).rows,
    ).toHaveLength(0);
  });
});

describe('reservation release (CRD-04)', () => {
  let testApp: TestApp | undefined;
  afterEach(async () => testApp?.close());

  it('applies 100 repeated requests once and republishes the recorded release', async () => {
    testApp = await createTestApp();
    await arrangeReservation(testApp);
    const outcomes = [];
    for (let copy = 0; copy < 100; copy++) {
      outcomes.push(
        await testApp.db.transaction((tx) =>
          testApp!.credits.release(tx, releaseInput({ causationId: `release-${copy}` })),
        ),
      );
    }
    expect(outcomes).toEqual(Array.from({ length: 100 }, () => outcomes[0]));
    expect(await wallet(testApp, 'student-1')).toMatchObject({ available: 10, reserved: 0 });
    expect(
      (
        await testApp.db.query(
          `SELECT * FROM credit_transactions WHERE transaction_type = 'RELEASE'`,
        )
      ).rows,
    ).toHaveLength(1);
    const replies = await testApp.db.query<{ payload: unknown } & Record<string, unknown>>(
      `SELECT payload FROM outbox_events WHERE event_type = 'credit.released'`,
    );
    expect(replies.rows).toHaveLength(100);
    expect(replies.rows.map((row) => row.payload)).toEqual(
      Array.from({ length: 100 }, () => replies.rows[0]!.payload),
    );
  });

  it('audits conflicting facts without releasing the reservation', async () => {
    testApp = await createTestApp();
    await arrangeReservation(testApp);
    const outcome = await testApp.db.transaction((tx) =>
      testApp!.credits.release(tx, releaseInput({ amount: 2 })),
    );
    expect(outcome).toEqual({ status: 'REJECTED', reason: 'CONFLICTING_REQUEST' });
    expect(await wallet(testApp, 'student-1')).toMatchObject({ available: 7, reserved: 3 });
    expect((await testApp.db.query(`SELECT * FROM credit_audit_alerts`)).rows).toHaveLength(1);
  });

  it('rejects release after transfer and transfer after release without a second effect', async () => {
    testApp = await createTestApp();
    await arrangeReservation(testApp);
    await issue(testApp, 'courier-1');
    await testApp.db.transaction((tx) => testApp!.credits.transfer(tx, transferInput()));
    const releaseAfterTransfer = await testApp.db.transaction((tx) =>
      testApp!.credits.release(tx, releaseInput()),
    );
    expect(releaseAfterTransfer).toEqual({
      status: 'REJECTED',
      reason: 'TERMINAL_OPERATION_CONFLICT',
    });
    expect(await wallet(testApp, 'student-1')).toMatchObject({ available: 7, reserved: 0 });
    expect(await wallet(testApp, 'courier-1')).toMatchObject({ available: 13, reserved: 0 });

    const second = await createTestApp();
    try {
      await arrangeReservation(second);
      await issue(second, 'courier-1');
      await second.db.transaction((tx) => second.credits.release(tx, releaseInput()));
      const transferAfterRelease = await second.db.transaction((tx) =>
        second.credits.transfer(tx, transferInput()),
      );
      expect(transferAfterRelease).toEqual({
        status: 'REJECTED',
        reason: 'TERMINAL_OPERATION_CONFLICT',
      });
      expect(await wallet(second, 'student-1')).toMatchObject({ available: 10, reserved: 0 });
      expect(await wallet(second, 'courier-1')).toMatchObject({ available: 10, reserved: 0 });
    } finally {
      await second.close();
    }
  });

  it.each<TerminalBoundary>([
    'reservation-locked',
    'operation-claimed',
    'requester-wallet-updated',
    'transaction-written',
    'ledger-written',
    'operation-finalized',
    'outbox-written',
  ])('rolls back the whole release when %s fails', async (failedBoundary) => {
    testApp = await createTestApp();
    await arrangeReservation(testApp);
    await expect(
      testApp.db.transaction((tx) =>
        testApp!.credits.release(tx, releaseInput(), (boundary) => {
          if (boundary === failedBoundary) throw new Error(`fault at ${boundary}`);
        }),
      ),
    ).rejects.toThrow(`fault at ${failedBoundary}`);
    expect(await wallet(testApp, 'student-1')).toMatchObject({ available: 7, reserved: 3 });
    expect(
      (
        await testApp.db.query(
          `SELECT * FROM credit_transactions WHERE transaction_type = 'RELEASE'`,
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (await testApp.db.query(`SELECT * FROM credit_operations WHERE operation_type = 'RELEASE'`))
        .rows,
    ).toHaveLength(0);
    expect(
      (await testApp.db.query(`SELECT * FROM outbox_events WHERE event_type = 'credit.released'`))
        .rows,
    ).toHaveLength(0);
  });
});
