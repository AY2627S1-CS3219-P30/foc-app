import { afterEach, describe, expect, it } from 'vitest';
import { asService, createTestApp, http, issue, type TestApp } from './helpers/app.js';

const reserve = async (app: TestApp, orderId: string, amount = 3) => {
  await app.db.transaction((tx) =>
    app.credits.reserve(tx, {
      orderId,
      requesterId: 'student-1',
      amount,
      correlationId: `corr-${orderId}`,
      causationId: `cause-${orderId}`,
    }),
  );
};

const status = (app: TestApp, orderId: string) =>
  http(app)
    .get(`/internal/orders/${encodeURIComponent(orderId)}/credit-status`)
    .set('X-Service-Key', asService);

describe('authoritative order credit status (CRD-06)', () => {
  let app: TestApp | undefined;
  afterEach(async () => app?.close());

  it('returns NONE/UNKNOWN for an order Credit has never observed', async () => {
    app = await createTestApp();
    const response = await status(app, 'order-unknown').expect(200);
    expect(response.body).toEqual({
      orderId: 'order-unknown',
      status: 'NONE',
      detail: 'UNKNOWN',
      rejectionReason: null,
      recordedAt: null,
      reservation: null,
      terminal: null,
    });
  });

  it('maps a durable rejection to NONE with its stable decision detail', async () => {
    app = await createTestApp();
    await issue(app, 'student-1');
    await reserve(app, 'order-rejected', 11);
    const first = await status(app, 'order-rejected').expect(200);
    const second = await status(app, 'order-rejected').expect(200);
    expect(first.body).toEqual(second.body);
    expect(first.body).toMatchObject({
      status: 'NONE',
      detail: 'REJECTED',
      rejectionReason: 'AMOUNT_OUT_OF_RANGE',
      reservation: null,
      terminal: null,
    });
    expect(first.body.recordedAt).toMatch(/Z$/);
  });

  it('defines a visible PENDING operation as NONE/IN_FLIGHT without inventing a transaction', async () => {
    app = await createTestApp();
    await app.db.query(
      `INSERT INTO credit_operations
         (order_id, operation_type, requester_id, amount, outcome)
       VALUES ('order-in-flight', 'RESERVE', 'student-1', 3, 'PENDING')`,
    );
    const response = await status(app, 'order-in-flight').expect(200);
    expect(response.body).toMatchObject({
      status: 'NONE',
      detail: 'IN_FLIGHT',
      rejectionReason: null,
      reservation: null,
      terminal: null,
    });
    expect(response.body.recordedAt).toMatch(/Z$/);
  });

  it('returns RESERVED with an immutable reservation transaction reference', async () => {
    app = await createTestApp();
    await issue(app, 'student-1');
    await reserve(app, 'order-reserved');
    const response = await status(app, 'order-reserved').expect(200);
    expect(response.body).toMatchObject({
      status: 'RESERVED',
      detail: null,
      reservation: { type: 'RESERVE' },
      terminal: null,
    });
    expect(response.body.reservation.transactionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.body.recordedAt).toBe(response.body.reservation.occurredAt);
  });

  it.each(['RELEASED', 'TRANSFERRED'] as const)(
    'returns %s with reservation and terminal references without changing storage',
    async (expected) => {
      app = await createTestApp();
      await issue(app, 'student-1');
      await reserve(app, `order-${expected.toLowerCase()}`);
      if (expected === 'TRANSFERRED') {
        await issue(app, 'courier-1');
        await app.db.transaction((tx) =>
          app!.credits.transfer(tx, {
            orderId: 'order-transferred',
            requesterId: 'student-1',
            courierId: 'courier-1',
            amount: 3,
            correlationId: 'corr-transfer',
            causationId: 'cause-transfer',
          }),
        );
      } else {
        await app.db.transaction((tx) =>
          app!.credits.release(tx, {
            orderId: 'order-released',
            requesterId: 'student-1',
            amount: 3,
            correlationId: 'corr-release',
            causationId: 'cause-release',
          }),
        );
      }
      const orderId = `order-${expected.toLowerCase()}`;
      const before = await app.db.query(`SELECT * FROM credit_operations WHERE order_id = $1`, [
        orderId,
      ]);
      const first = await status(app, orderId).expect(200);
      const second = await status(app, orderId).expect(200);
      const after = await app.db.query(`SELECT * FROM credit_operations WHERE order_id = $1`, [
        orderId,
      ]);
      expect(first.body).toEqual(second.body);
      expect(first.body).toMatchObject({
        status: expected,
        detail: null,
        reservation: { type: 'RESERVE' },
        terminal: { type: expected === 'TRANSFERRED' ? 'TRANSFER' : 'RELEASE' },
      });
      expect(after.rows).toEqual(before.rows);
    },
  );

  it('requires the configured service key and does not accept a user bearer token', async () => {
    app = await createTestApp();
    for (const request of [
      http(app).get('/internal/orders/order-1/credit-status'),
      http(app).get('/internal/orders/order-1/credit-status').set('X-Service-Key', 'wrong-key'),
      http(app).get('/internal/orders/order-1/credit-status').set('Authorization', 'Bearer admin'),
    ]) {
      const response = await request.expect(401);
      expect(response.body.error.code).toBe('SERVICE_UNAUTHENTICATED');
    }
  });

  it('returns the shared 400 error contract for malformed order identifiers', async () => {
    app = await createTestApp();
    const response = await status(app, 'bad order id').expect(400);
    expect(response.body.error).toMatchObject({
      code: 'INVALID_ORDER_ID',
      message: 'The order identifier is invalid.',
    });
    expect(response.body.error.correlationId).toBeTypeOf('string');
  });

  it('returns the shared 500 contract without leaking database details', async () => {
    app = await createTestApp();
    await app.db.exec('DROP TABLE credit_operations CASCADE');
    const response = await status(app, 'order-1').expect(500);
    expect(response.body.error).toMatchObject({ code: 'INTERNAL' });
    expect(JSON.stringify(response.body)).not.toContain('credit_operations');
  });
});
