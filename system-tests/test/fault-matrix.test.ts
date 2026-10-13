import { afterEach, describe, expect, it } from 'vitest';
import { TEST_POSTGRES_URL } from '@foc/test-harness';
import { failNextAt } from '../src/faults.js';
import { agreementViolations, economyViolations } from '../src/invariants.js';
import { accept, command, createOrder } from '../src/scenario.js';
import { Stack } from '../src/stack.js';

const suite = TEST_POSTGRES_URL ? describe : describe.skip;

/**
 * A crash at every write boundary of every transaction either service runs during a lifecycle —
 * command, consumer, relay — rolls that transaction back. The caller retries (the broker for a
 * consumer, the next poll for a relay, the client for a command), and the economy converges with
 * exactly one effect per operation.
 */
const BOUNDARIES = {
  credit: [
    /INSERT INTO processed_events/,
    /INSERT INTO credit_operations/,
    /UPDATE wallets/,
    /INSERT INTO credit_transactions/,
    /INSERT INTO ledger_entries/,
    /INSERT INTO outbox_events/,
    /UPDATE outbox_events/,
  ],
  order: [
    /INSERT INTO processed_events/,
    /UPDATE orders/,
    /INSERT INTO order_status_history/,
    /INSERT INTO order_receipts/,
    /INSERT INTO outbox_events/,
    /UPDATE outbox_events/,
  ],
} as const;

const CASES = (['credit', 'order'] as const).flatMap((service) =>
  BOUNDARIES[service].flatMap((boundary) =>
    (['complete', 'cancel'] as const)
      // A cancelled order never writes a receipt, so that boundary only exists on completion.
      .filter((path) => !(path === 'cancel' && String(boundary).includes('order_receipts')))
      .map((path) => [service, String(boundary), path, boundary] as const),
  ),
);

/** Runs a command, retrying once if an injected crash interrupted it, as a client would. */
async function retrying<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (!String(error).includes('injected crash')) throw error;
    return fn();
  }
}

suite('fault matrix at every write boundary', () => {
  let stack: Stack | undefined;
  afterEach(async () => stack?.stop());

  it.each(CASES)(
    '%s crash at %s while the order goes to %s',
    async (service, _label, path, boundary) => {
      const s = (stack = await Stack.start(TEST_POSTGRES_URL!, `fault_${service}`));
      await s.issueWallet('requester');
      await s.issueWallet('courier');
      const fault = failNextAt(service === 'credit' ? s.creditDb.db : s.orderDb.db, boundary);

      const orderId = await retrying(() => createOrder(s, 'requester', 3));
      await s.settle();
      if (path === 'complete') {
        await retrying(() => accept(s, orderId, 'courier'));
        await retrying(() => command(s, orderId, 'RECORD_PICKUP', 'courier'));
        await retrying(() => command(s, orderId, 'RECORD_DELIVERY', 'courier'));
        await retrying(() => command(s, orderId, 'CONFIRM_RECEIPT', 'requester'));
      } else {
        await retrying(() => command(s, orderId, 'CANCEL', 'requester'));
      }
      await s.settle();
      fault.restore();

      expect(fault.fired(), 'the boundary was reached and crashed').toBe(true);
      const order = await s.orders.findById(orderId);
      expect(order!.status).toBe(path === 'complete' ? 'COMPLETED' : 'CANCELLED');
      expect(await s.transactionsFor(orderId)).toEqual(
        path === 'complete' ? ['RESERVE', 'TRANSFER'] : ['RESERVE', 'RELEASE'],
      );
      expect(await s.wallet('requester')).toEqual({
        available: path === 'complete' ? 7 : 10,
        reserved: 0,
      });
      expect(await economyViolations(s)).toEqual([]);
      expect(await agreementViolations(s, true)).toEqual([]);
    },
  );
});
