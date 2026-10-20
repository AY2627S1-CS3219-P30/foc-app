import type { Queryable, Row } from '@foc/platform';

type ReservedRow = Row & { user_id: string; reserved: number; open_reservations: string };

/**
 * Each wallet's `reserved` balance equals the sum of its open reservations: the RESERVE
 * transactions for orders with no TRANSFER or RELEASE yet (CRD-09, D3 Part 2.1).
 *
 * The other invariants do not imply this one. Moving a credit from `available` to `reserved` with
 * no reservation keeps every wallet non-negative, every transaction balanced, the economy's total
 * equal to what was issued, and each order reserved once and settled once, yet it leaves a credit
 * that no errand can ever release or pay out. The cross-service suite checks it after every
 * sequence (`system-tests/src/invariants.ts`); `test/invariants.test.ts` shows it catching that
 * case. Read-only: it reports a mismatch and changes nothing.
 */
export async function reservedBackingViolations(queryable: Queryable): Promise<string[]> {
  const result = await queryable.query<ReservedRow>(
    `SELECT w.user_id, w.reserved, coalesce(r.amount, 0) AS open_reservations
       FROM wallets w
       LEFT JOIN (
         SELECT t.wallet_user_id, sum(t.amount) AS amount
           FROM credit_transactions t
          WHERE t.transaction_type = 'RESERVE'
            AND NOT EXISTS (
                  SELECT 1 FROM credit_transactions settled
                   WHERE settled.order_id = t.order_id
                     AND settled.transaction_type IN ('TRANSFER', 'RELEASE'))
          GROUP BY t.wallet_user_id
       ) r ON r.wallet_user_id = w.user_id
      WHERE w.reserved <> coalesce(r.amount, 0)
      ORDER BY w.user_id`,
  );
  return result.rows.map(
    (row) =>
      `wallet ${row.user_id} holds ${Number(row.reserved)} reserved but its open reservations ` +
      `total ${Number(row.open_reservations)}`,
  );
}
