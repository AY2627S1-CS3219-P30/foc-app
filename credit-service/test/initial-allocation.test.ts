import { afterEach, describe, expect, it } from 'vitest';
import { initialAllocationSchema } from '../src/config.js';
import { CreditRepository } from '../src/credits/credit.repository.js';
import {
  INITIAL_ALLOCATION_BOUNDS,
  INITIAL_CREDIT_ALLOCATION,
  MAX_RESERVATION_AMOUNT,
} from '../src/credits/types.js';
import { asStudent, createTestApp, http, issue, type TestApp } from './helpers/app.js';

const parse = (value: string | undefined) => initialAllocationSchema.safeParse(value);

describe('the initial allocation is configuration (CRD-09, CS-FR1.1.1)', () => {
  let testApp: TestApp | undefined;
  afterEach(async () => testApp?.close());

  it('defaults to 10 when INITIAL_CREDIT_ALLOCATION is unset or empty', () => {
    expect(INITIAL_CREDIT_ALLOCATION).toBe(10);
    expect(parse(undefined)).toMatchObject({ success: true, data: 10 });
    // Compose passes the variable through empty when .env does not set it.
    expect(parse('')).toMatchObject({ success: true, data: 10 });
    expect(parse('  ')).toMatchObject({ success: true, data: 10 });
  });

  it('accepts any whole number from the largest reward to 50', () => {
    expect(INITIAL_ALLOCATION_BOUNDS.min).toBe(MAX_RESERVATION_AMOUNT);
    expect(parse('5')).toMatchObject({ success: true, data: 5 });
    expect(parse('12')).toMatchObject({ success: true, data: 12 });
    expect(parse('50')).toMatchObject({ success: true, data: 50 });
  });

  it.each([
    ['4', 'at least 5'],
    ['0', 'at least 5'],
    ['-10', 'at least 5'],
    ['51', 'at most 50'],
    ['10.5', 'whole number'],
    ['ten', ''],
  ])('refuses %s, so the service stops at boot rather than mint the wrong amount', (value, why) => {
    const result = parse(value);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain(why);
  });

  it('issues the configured amount, and records it on the ledger', async () => {
    testApp = await createTestApp({ initialAllocation: 12 });
    await issue(testApp, 'student-1');

    const response = await http(testApp).get('/wallets/me').set('Authorization', asStudent);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ available: 12, reserved: 0, total: 12 });
    const issued = await testApp.db.query<{ amount: number } & Record<string, unknown>>(
      `SELECT amount FROM credit_transactions WHERE transaction_type = 'ISSUE'`,
    );
    expect(issued.rows).toEqual([{ amount: 12 }]);
    const entries = await testApp.db.query(
      `SELECT account, direction, amount FROM ledger_entries ORDER BY entry_no`,
    );
    expect(entries.rows).toEqual([
      { account: 'PLATFORM_ISSUANCE', direction: 'DEBIT', amount: 12 },
      { account: 'AVAILABLE', direction: 'CREDIT', amount: 12 },
    ]);
  });

  it('keeps the economy balanced when the allocation changes between wallets', async () => {
    // A wallet issued under the old setting keeps what it was given; conservation is checked
    // against the amounts each ISSUE recorded, not against today's setting.
    testApp = await createTestApp();
    await issue(testApp, 'student-1');
    const reconfigured = new CreditRepository(testApp.db, 7);
    await testApp.db.transaction((tx) => reconfigured.issueInitial(tx, 'student-2'));

    const totals = await testApp.db.query<
      { held: string; issued: string } & Record<string, unknown>
    >(
      `SELECT (SELECT sum(available + reserved) FROM wallets) AS held,
              (SELECT sum(amount) FROM credit_transactions WHERE transaction_type = 'ISSUE') AS issued`,
    );
    const { held, issued } = totals.rows[0]!;
    expect([Number(held), Number(issued)]).toEqual([17, 17]);
  });
});
