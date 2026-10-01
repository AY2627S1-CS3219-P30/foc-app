import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { asRequester, createTestApp, http, type TestApp } from './helpers/app.js';
import {
  SEEDED_ORDER,
  TRANSFER_RESULTS_QUEUE,
  advance,
  deliver,
  failAt,
  footprint,
  transferred,
} from './support/lifecycle.js';

const BOUNDARIES = [
  /UPDATE orders/,
  /INSERT INTO order_status_history/,
  /INSERT INTO outbox_events/,
];

describe('transition write boundaries are atomic', () => {
  let t: TestApp | undefined;
  afterEach(async () => t?.close());

  it.each(BOUNDARIES)(
    'a crash at %s leaves confirmation unapplied and retryable',
    async (boundary) => {
      t = await createTestApp();
      await advance(t, 'DELIVERED');
      const before = await footprint(t);
      const restore = failAt(t, boundary);
      const failed = await http(t)
        .post(`/orders/${SEEDED_ORDER}/confirm-receipt`)
        .set('Authorization', asRequester)
        .send({ expectedVersion: 5 });
      restore();
      expect(failed.status).toBe(500);
      expect(await footprint(t)).toEqual(before);

      await http(t)
        .post(`/orders/${SEEDED_ORDER}/confirm-receipt`)
        .set('Authorization', asRequester)
        .send({ expectedVersion: 5 })
        .expect(200);
    },
  );

  it.each([
    /processed_events/,
    /UPDATE orders/,
    /INSERT INTO order_status_history/,
    /INSERT INTO order_receipts/,
    /INSERT INTO outbox_events/,
  ])(
    'a crash at %s while applying a transfer leaves the order pending and the retry completes it',
    async (boundary) => {
      t = await createTestApp();
      await advance(t, 'COMPLETION_PENDING_CREDIT');
      const before = await footprint(t);
      const confirmation = transferred({ transactionId: randomUUID() });
      const restore = failAt(t, boundary);
      await expect(deliver(t, TRANSFER_RESULTS_QUEUE, confirmation)).rejects.toThrow(
        /injected fault/,
      );
      restore();
      expect(await footprint(t)).toEqual(before);
      expect(
        (await t.db.query(`SELECT * FROM order_receipts WHERE order_id = $1`, [SEEDED_ORDER])).rows,
      ).toHaveLength(0);

      // The broker redelivers the same message: the inbox did not record it, so it applies now.
      await deliver(t, TRANSFER_RESULTS_QUEUE, confirmation);
      expect(await t.orders.findById(SEEDED_ORDER)).toMatchObject({ status: 'COMPLETED' });
    },
  );
});
