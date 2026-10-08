import { readFileSync } from 'node:fs';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEAD_LETTERS,
  DEAD_LETTERS_TABLE_SQL,
  createEnvelope,
  type DeadLetters,
} from '@foc/platform';
import type { CreateOrderInput } from '../src/orders/validation.js';
import { asRequester, createTestApp, http, type TestApp } from './helpers/app.js';

const order: CreateOrderInput = {
  supplierId: '00000000-0000-4000-8000-000000000125',
  items: [{ name: 'Chicken rice', quantity: 1 }],
  deliveryZone: 'COM2 Lobby',
  deliveryInstructions: 'Meet beside the security desk',
  reward: 3,
};
const asAdmin = 'Bearer admin';

/** A dead-lettered Credit reply about `orderId`, parked as the consumer of its queue would. */
async function parkReply(t: TestApp, orderId: string) {
  const reply = createEnvelope({
    eventType: 'credit.reserved',
    schemaVersion: 1,
    aggregateId: orderId,
    producer: 'credit-service',
    correlationId: 'trace-from-browser',
    payload: { orderId },
  });
  const message = {
    content: Buffer.from(JSON.stringify(reply)),
    fields: { routingKey: 'foc.order.reservation-results' },
    properties: {
      messageId: reply.eventId,
      headers: { 'x-foc-attempt': 5, 'x-foc-failure-reason': 'order version moved on' },
    },
  } as unknown as ConsumeMessage;
  const channel = { ack: () => undefined, nack: () => undefined } as unknown as ConfirmChannel;
  await t.app
    .get<DeadLetters>(DEAD_LETTERS)
    .park(channel, 'foc.order.reservation-results', message);
  return reply;
}

describe('operations (PLT-05)', () => {
  let t: TestApp;
  let orderId: string;
  beforeEach(async () => {
    t = await createTestApp();
    const created = await http(t)
      .post('/orders')
      .set('Authorization', asRequester)
      .set('Idempotency-Key', 'ops-1')
      .set('X-Correlation-Id', 'trace-from-browser')
      .send(order)
      .expect(201);
    orderId = created.body.orderId;
  });
  afterEach(async () => t.close());

  it('reconstructs one errand from its id: state changes, events, alerts and dead letters', async () => {
    await parkReply(t, orderId);
    const res = await http(t)
      .get(`/admin/orders/${orderId}/timeline`)
      .set('Authorization', asAdmin);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      orderId,
      status: 'PENDING_CREDIT',
      requesterId: 'seed-requester',
    });
    expect(res.body.history).toEqual([
      expect.objectContaining({
        previousStatus: null,
        newStatus: 'PENDING_CREDIT',
        action: 'CREATE',
      }),
    ]);
    // The reservation request it caused, not yet sent (no broker here), under the browser's ID.
    expect(res.body.events).toContainEqual(
      expect.objectContaining({
        eventType: 'order.reservation-requested',
        correlationId: 'trace-from-browser',
        publishedAt: null,
        attempts: 0,
      }),
    );
    expect(res.body.deadLetters).toEqual([
      expect.objectContaining({
        queue: 'foc.order.reservation-results',
        eventType: 'credit.reserved',
        failureReason: 'order version moved on',
        status: 'WAITING',
      }),
    ]);
    expect(res.body.reconciliation).toEqual([]);
    expect(res.body.alerts).toEqual([]);
  });

  it('refuses a student, an unknown errand and a malformed id', async () => {
    await http(t)
      .get(`/admin/orders/${orderId}/timeline`)
      .set('Authorization', asRequester)
      .expect(403);
    await http(t)
      .get('/admin/orders/00000000-0000-4000-8000-000000000000/timeline')
      .set('Authorization', asAdmin)
      .expect(404);
    await http(t).get('/admin/orders/not-an-id/timeline').set('Authorization', asAdmin).expect(400);
  });

  it('lists operator alerts across errands, newest first', async () => {
    await t.db.query(
      `INSERT INTO order_operator_alerts (order_id, kind, raised_at, detail)
       VALUES ($1, 'CREDIT_WAIT_EXCEEDED', now(), '{"requesterId":"seed-requester"}')`,
      [orderId],
    );
    const res = await http(t).get('/admin/orders/alerts').set('Authorization', asAdmin).expect(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({ orderId, kind: 'CREDIT_WAIT_EXCEEDED' }),
    ]);
    await http(t).get('/admin/orders/alerts').set('Authorization', asRequester).expect(403);
  });

  it('finds, reads and refuses to redrive a dead letter while no broker is connected', async () => {
    const reply = await parkReply(t, orderId);
    const found = await http(t)
      .get('/admin/dead-letters?q=trace-from-browser')
      .set('Authorization', asAdmin)
      .expect(200);
    expect(found.body).toMatchObject({ page: 1, total: 1 });
    const id = found.body.items[0].id as string;

    const detail = await http(t)
      .get(`/admin/dead-letters/${id}`)
      .set('Authorization', asAdmin)
      .expect(200);
    expect(detail.body.body).toEqual(JSON.parse(JSON.stringify(reply)));

    const refused = await http(t)
      .post(`/admin/dead-letters/${id}/redrive`)
      .set('Authorization', asAdmin)
      .send({ reason: 'version conflict resolved' })
      .expect(503);
    expect(refused.body.error.code).toBe('BROKER_UNAVAILABLE');
    await http(t)
      .post(`/admin/dead-letters/${id}/redrive`)
      .set('Authorization', asAdmin)
      .send({})
      .expect(422);
    await http(t).get('/admin/dead-letters').set('Authorization', asRequester).expect(403);
    await http(t).get('/admin/dead-letters').expect(401);
  });

  it('reports how long the oldest errand has waited for Credit', async () => {
    const metrics = await http(t).get('/metrics').expect(200);
    const age = /foc_orders_pending_credit_oldest_age_seconds\{[^}]*\} ([\d.e+-]+)/.exec(
      metrics.text,
    );
    expect(age).not.toBeNull();
    expect(Number(age![1])).toBeGreaterThanOrEqual(0);
  });

  it("migrates the platform's dead-letter table exactly", () => {
    const migration = readFileSync(
      new URL('../drizzle/0010_dead_letters.sql', import.meta.url),
      'utf8',
    );
    const normalise = (sql: string) =>
      sql
        .replace(/--> statement-breakpoint/g, '')
        .replace(/^--.*$/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
    expect(normalise(migration)).toBe(normalise(DEAD_LETTERS_TABLE_SQL));
  });
});
