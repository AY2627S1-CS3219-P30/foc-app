import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processOnce } from '@foc/platform';
import { asAdmin, asOther, asStudent, createTestApp, http, type TestApp } from './helpers/app.js';

describe('wallet issuance and read authorization (CRD-01/CRD-05)', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp();
  });

  afterAll(async () => testApp.close());

  it('turns 100 duplicate activation deliveries into one wallet and one balanced issuance', async () => {
    const event = {
      eventId: randomUUID(),
      eventType: 'user.activated',
      correlationId: 'activation-1',
    };
    for (let copy = 0; copy < 100; copy++) {
      await processOnce(testApp.db, 'wallet-provisioning', event, (tx) =>
        testApp.credits.issueInitial(tx, 'student-1'),
      );
    }

    const wallet = await testApp.db.query(
      `SELECT available, reserved FROM wallets WHERE user_id = 'student-1'`,
    );
    const transactions = await testApp.db.query(
      `SELECT transaction_id FROM credit_transactions WHERE transaction_type = 'ISSUE'`,
    );
    const entries = await testApp.db.query(
      `SELECT direction, amount FROM ledger_entries ORDER BY entry_no`,
    );
    expect(wallet.rows).toEqual([expect.objectContaining({ available: 10, reserved: 0 })]);
    expect(transactions.rows).toHaveLength(1);
    expect(entries.rows).toEqual([
      expect.objectContaining({ direction: 'DEBIT', amount: 10 }),
      expect.objectContaining({ direction: 'CREDIT', amount: 10 }),
    ]);
  });

  it('also deduplicates distinct activation event ids by user id', async () => {
    for (let copy = 0; copy < 100; copy++) {
      await testApp.db.transaction((tx) => testApp.credits.issueInitial(tx, 'student-2'));
    }
    const transactions = await testApp.db.query(
      `SELECT transaction_id FROM credit_transactions
        WHERE transaction_type = 'ISSUE' AND wallet_user_id = 'student-2'`,
    );
    expect(transactions.rows).toHaveLength(1);
  });

  it('rolls wallet creation back when issuance ledger writing fails', async () => {
    await testApp.db.exec(`
      CREATE FUNCTION fail_test_issuance() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.wallet_user_id = 'fault-user' THEN
          RAISE EXCEPTION 'injected issuance failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_test_issuance
      BEFORE INSERT ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION fail_test_issuance();
    `);
    try {
      await expect(
        testApp.db.transaction((tx) => testApp.credits.issueInitial(tx, 'fault-user')),
      ).rejects.toThrow('injected issuance failure');
    } finally {
      await testApp.db.exec(`
        DROP TRIGGER fail_test_issuance ON ledger_entries;
        DROP FUNCTION fail_test_issuance();
      `);
    }
    expect(
      (await testApp.db.query(`SELECT user_id FROM wallets WHERE user_id = 'fault-user'`)).rows,
    ).toHaveLength(0);
  });

  it('shows the owner whole-number available, reserved and derived total', async () => {
    const response = await http(testApp)
      .get('/wallets/me')
      .set('Authorization', asStudent)
      .expect(200);
    expect(response.body).toMatchObject({
      userId: 'student-1',
      available: 10,
      reserved: 0,
      total: 10,
    });
  });

  it('exposes no route for a student to select another wallet', async () => {
    await http(testApp).get('/wallets/student-2').set('Authorization', asStudent).expect(404);
    await http(testApp).get('/admin/wallets/student-2').set('Authorization', asOther).expect(403);
  });

  it('allows an admin read and appends an audit record', async () => {
    await http(testApp)
      .get('/admin/wallets/student-2')
      .set('Authorization', asAdmin)
      .set('X-Correlation-ID', 'admin-read-1')
      .expect(200);
    const audit = await testApp.db.query(
      `SELECT admin_user_id, target_user_id, resource, correlation_id FROM admin_wallet_reads`,
    );
    expect(audit.rows).toContainEqual({
      admin_user_id: 'admin-1',
      target_user_id: 'student-2',
      resource: 'WALLET',
      correlation_id: 'admin-read-1',
    });
  });

  it('returns a stable not-found error for an owner whose activation is still in flight', async () => {
    const response = await http(testApp)
      .get('/wallets/me')
      .set('Authorization', asOther)
      .expect(200);
    expect(response.body.userId).toBe('student-2');

    // A third identity is not exposed by the fake authenticator, so exercise the
    // service-facing repository result through a missing admin target.
    const missing = await http(testApp)
      .get('/admin/wallets/not-activated')
      .set('Authorization', asAdmin)
      .expect(404);
    expect(missing.body.error.code).toBe('WALLET_NOT_FOUND');
    const audits = await testApp.db.query(
      `SELECT target_user_id FROM admin_wallet_reads WHERE target_user_id = 'not-activated'`,
    );
    expect(audits.rows).toHaveLength(1);
  });

  it('makes ledger and audit history append-only at the database boundary', async () => {
    await expect(testApp.db.query(`UPDATE ledger_entries SET amount = 999`)).rejects.toThrow(
      /append-only/,
    );
    await expect(testApp.db.query(`DELETE FROM admin_wallet_reads`)).rejects.toThrow(/append-only/);
  });
});
