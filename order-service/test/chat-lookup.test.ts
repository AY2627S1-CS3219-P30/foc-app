import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, http, type TestApp } from './helpers/app.js';
import {
  COURIER,
  REQUESTER,
  SEEDED_ORDER,
  TRANSFER_RESULTS_QUEUE,
  advance,
  deliver,
  footprint,
  transferred,
} from './support/lifecycle.js';

const CHAT_KEY = 'test-chat-key-0123456789';

/**
 * NTH-02 (#162, ADR 0012): what the Chat Service decides access from on every request. A channel
 * is open while the errand has a courier and no final status, so the lookup must name the current
 * courier and when the errand ended, and nothing about it may change the errand.
 */
describe('GET /internal/orders/{orderId}/chat', () => {
  let t: TestApp;
  afterEach(async () => t?.close());

  const lookup = (key = CHAT_KEY) =>
    http(t).get(`/internal/orders/${SEEDED_ORDER}/chat`).set('X-Service-Key', key);

  it('names no courier and no end while the errand is open', async () => {
    t = await createTestApp();
    const res = await lookup().expect(200);
    expect(res.body).toEqual({
      status: 'OPEN',
      version: 2,
      requesterId: REQUESTER,
      courierId: null,
      endedAt: null,
    });
  });

  it('names the courier once one accepts', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');
    const res = await lookup().expect(200);
    expect(res.body).toMatchObject({ status: 'ACCEPTED', courierId: COURIER, endedAt: null });
  });

  it('ends when the errand reaches a final status, at the time its history records', async () => {
    t = await createTestApp();
    await advance(t, 'COMPLETION_PENDING_CREDIT');
    // Still open while Credit settles: COMPLETION_PENDING_CREDIT is not final.
    expect((await lookup().expect(200)).body.endedAt).toBeNull();
    await deliver(t, TRANSFER_RESULTS_QUEUE, transferred());
    const completed = (await t.orders.findHistory(SEEDED_ORDER)).find(
      (entry) => entry.newStatus === 'COMPLETED',
    )!;
    const res = await lookup().expect(200);
    expect(res.body).toMatchObject({
      status: 'COMPLETED',
      courierId: COURIER,
      endedAt: completed.occurredAt,
    });
  });

  it('answers only the keys it accepts, and changes nothing about the errand', async () => {
    t = await createTestApp();
    await advance(t, 'ACCEPTED');
    const before = await footprint(t);
    // Order's own outbound key is not one it accepts.
    for (const key of ['test-internal-key-0123456789', '']) {
      const res = await lookup(key).expect(401);
      expect(res.body.error.code).toBe('SERVICE_UNAUTHENTICATED');
    }
    await lookup().expect(200);
    expect(await footprint(t)).toEqual(before);
  });
});
