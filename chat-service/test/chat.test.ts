import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PEOPLE,
  as,
  createTestApp,
  http,
  message,
  type Person,
  type TestApp,
} from './helpers/app.js';

/**
 * NTH-02 (#162, ADR 0012): one channel per errand, open from acceptance to a final status, read
 * and written only by its requester and current courier, and never able to change the errand.
 */
let t: TestApp;
beforeEach(async () => {
  t = await createTestApp();
});
afterEach(async () => t.close());

const channel = (orderId: string, who: Person = 'requester') =>
  http(t).get(`/channels/${orderId}`).set('Authorization', as(who));
const page = (orderId: string, query = '', who: Person = 'requester') =>
  http(t).get(`/channels/${orderId}/messages${query}`).set('Authorization', as(who));
const send = (orderId: string, body: object, who: Person = 'requester') =>
  http(t).post(`/channels/${orderId}/messages`).set('Authorization', as(who)).send(body);
const read = (orderId: string, seq: unknown, who: Person = 'requester') =>
  http(t).put(`/channels/${orderId}/read`).set('Authorization', as(who)).send({ seq });

describe('a channel opens with a courier and is bound to one errand', () => {
  it('opens on the first request once a courier has accepted, naming both participants', async () => {
    const orderId = t.upstreams.errand();
    const res = await channel(orderId).expect(200);
    expect(res.body).toEqual({
      orderId,
      open: true,
      myRole: 'REQUESTER',
      requester: PEOPLE.requester,
      courier: PEOPLE.courier,
      lastReadSeq: 0,
      latestSeq: 0,
    });
    expect((await channel(orderId, 'courier').expect(200)).body.myRole).toBe('COURIER');
  });

  it('is 404 for an unknown errand, and for one that has never had a courier', async () => {
    await channel(randomUUID()).expect(404);
    const open = t.upstreams.errand({ status: 'OPEN', version: 2, courierId: null });
    expect((await channel(open).expect(404)).body.error.code).toBe('NOT_FOUND');
    expect((await send(open, message('hello?')).expect(404)).body.error.code).toBe('NOT_FOUND');
  });

  it('keeps each errand’s messages apart', async () => {
    const first = t.upstreams.errand();
    const second = t.upstreams.errand();
    await send(first, message('for the first')).expect(201);
    expect((await page(second).expect(200)).body).toEqual({ items: [], hasMore: false });
    expect((await channel(second).expect(200)).body.latestSeq).toBe(0);
  });
});

describe('who may read and send', () => {
  it('refuses anyone but the requester and the current courier', async () => {
    const orderId = t.upstreams.errand();
    for (const who of ['stranger', 'admin'] as const) {
      expect((await channel(orderId, who).expect(403)).body.error.code).toBe('NOT_PARTICIPANT');
      await page(orderId, '', who).expect(403);
      await send(orderId, message('let me in'), who).expect(403);
      await read(orderId, 0, who).expect(403);
    }
  });

  it('moves with a new courier: the old one loses access, the new one sees everything', async () => {
    const orderId = t.upstreams.errand();
    await send(orderId, message('from the first courier'), 'courier').expect(201);
    t.upstreams.update(orderId, { courierId: PEOPLE.replacement.userId, version: 6 });

    await channel(orderId, 'courier').expect(403);
    const res = await page(orderId, '', 'replacement').expect(200);
    expect(res.body.items).toMatchObject([
      { seq: 1, senderId: PEOPLE.courier.userId, body: 'from the first courier' },
    ]);
  });

  it('needs a signed-in caller', async () => {
    await http(t).get(`/channels/${t.upstreams.errand()}`).expect(401);
  });
});

describe('sending', () => {
  it('numbers messages 1, 2, 3 in the channel, from either participant', async () => {
    const orderId = t.upstreams.errand();
    const first = await send(orderId, message('on my way'), 'courier').expect(201);
    expect(first.body).toMatchObject({
      seq: 1,
      senderId: PEOPLE.courier.userId,
      body: 'on my way',
    });
    expect(new Date(first.body.sentAt).toISOString()).toBe(first.body.sentAt);
    await send(orderId, message('thanks')).expect(201);
    await send(orderId, message('at the lobby'), 'courier').expect(201);
    const res = await page(orderId).expect(200);
    expect(res.body.items.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3]);
    expect((await channel(orderId).expect(200)).body.latestSeq).toBe(3);
  });

  it('stores a retried send once, and refuses its clientId for a different message', async () => {
    const orderId = t.upstreams.errand();
    const retry = message('only once');
    const stored = await send(orderId, retry).expect(201);
    const again = await send(orderId, retry).expect(200);
    expect(again.body).toEqual(stored.body);
    const reused = await send(orderId, { ...retry, body: 'something else' }).expect(422);
    expect(reused.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    // Another sender's same clientId is their own message.
    await send(orderId, retry, 'courier').expect(201);
    expect((await page(orderId).expect(200)).body.items).toHaveLength(2);
  });

  it('refuses a malformed message before asking the Order Service', async () => {
    const orderId = t.upstreams.errand();
    const before = t.upstreams.calls.length;
    for (const body of [
      {},
      message(''),
      { clientId: 'not-a-uuid', body: 'hi' },
      { ...message('hi'), extra: true },
      message('nul \0 inside'),
    ]) {
      expect((await send(orderId, body).expect(422)).body.error.code).toBe('VALIDATION_FAILED');
    }
    await http(t).get('/channels/not-a-uuid').set('Authorization', as('requester')).expect(400);
    expect(t.upstreams.calls.length).toBe(before);
  });
});

describe('a channel closes at a final status, or without a courier', () => {
  it('stops sends at a final status and keeps the conversation readable', async () => {
    const orderId = t.upstreams.errand();
    const earlier = message('see you');
    await send(orderId, earlier).expect(201);
    t.upstreams.update(orderId, { status: 'COMPLETED', endedAt: new Date().toISOString() });

    expect((await channel(orderId).expect(200)).body.open).toBe(false);
    const closed = await send(orderId, message('one more thing')).expect(409);
    expect(closed.body.error.code).toBe('CHANNEL_CLOSED');
    // A retry of a send that was stored before the close still answers with it.
    await send(orderId, earlier).expect(200);
    expect((await page(orderId, '', 'courier').expect(200)).body.items).toHaveLength(1);
    expect((await read(orderId, 1).expect(200)).body).toEqual({ lastReadSeq: 1 });
  });

  it('stays open while Credit settles, which is not a final status', async () => {
    const orderId = t.upstreams.errand({ status: 'COMPLETION_PENDING_CREDIT' });
    expect((await channel(orderId).expect(200)).body.open).toBe(true);
    await send(orderId, message('paid?')).expect(201);
  });

  it('closes when the courier withdraws, and the requester can still read it', async () => {
    const orderId = t.upstreams.errand();
    await send(orderId, message('picking up soon'), 'courier').expect(201);
    t.upstreams.update(orderId, { status: 'OPEN', courierId: null, version: 4 });

    const res = await channel(orderId).expect(200);
    expect(res.body).toMatchObject({ open: false, courier: null, latestSeq: 1 });
    await send(orderId, message('hello?')).expect(409);
    await channel(orderId, 'courier').expect(403);
  });
});

describe('paging', () => {
  const sendMany = async (orderId: string, count: number) => {
    for (let i = 1; i <= count; i++) await send(orderId, message(`m${i}`)).expect(201);
  };
  const seqs = (body: { items: { seq: number }[] }) => body.items.map((m) => m.seq);

  it('reads the latest, then newer after a seq, then older before one', async () => {
    const orderId = t.upstreams.errand();
    await sendMany(orderId, 5);
    const latest = (await page(orderId, '?limit=2').expect(200)).body;
    expect([seqs(latest), latest.hasMore]).toEqual([[4, 5], true]);
    const newer = (await page(orderId, '?after=1&limit=2').expect(200)).body;
    expect([seqs(newer), newer.hasMore]).toEqual([[2, 3], true]);
    const caughtUp = (await page(orderId, '?after=3&limit=2').expect(200)).body;
    expect([seqs(caughtUp), caughtUp.hasMore]).toEqual([[4, 5], false]);
    const older = (await page(orderId, '?before=3&limit=5').expect(200)).body;
    expect([seqs(older), older.hasMore]).toEqual([[1, 2], false]);
  });

  it('refuses after and before together, and a limit out of range', async () => {
    const orderId = t.upstreams.errand();
    for (const query of ['?after=1&before=3', '?limit=0', '?limit=101', '?after=-1', '?before=0']) {
      expect((await page(orderId, query).expect(422)).body.error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('read positions', () => {
  it('moves only forward, per participant, and not past the latest message', async () => {
    const orderId = t.upstreams.errand();
    await send(orderId, message('one')).expect(201);
    await send(orderId, message('two'), 'courier').expect(201);
    expect((await read(orderId, 2, 'courier').expect(200)).body).toEqual({ lastReadSeq: 2 });
    expect((await read(orderId, 1, 'courier').expect(200)).body).toEqual({ lastReadSeq: 2 });
    expect((await channel(orderId, 'courier').expect(200)).body.lastReadSeq).toBe(2);
    expect((await channel(orderId).expect(200)).body.lastReadSeq).toBe(0);
    await read(orderId, 3).expect(422);
    await read(orderId, '1').expect(422);
  });
});

describe('the Order and User Services', () => {
  it('fails closed with 503 when either does not answer, storing nothing', async () => {
    const orderId = t.upstreams.errand();
    t.upstreams.down = true;
    for (const res of [
      await channel(orderId),
      await page(orderId),
      await send(orderId, message('lost?')),
      await read(orderId, 0),
    ]) {
      expect([res.status, res.body.error.code]).toEqual([503, 'UNAVAILABLE']);
    }
    t.upstreams.down = false;
    expect((await page(orderId).expect(200)).body.items).toEqual([]);
  });

  it('only ever reads the errand: chat sends nothing that could change it', async () => {
    const orderId = t.upstreams.errand();
    await channel(orderId).expect(200);
    await send(orderId, message('hi')).expect(201);
    await read(orderId, 1).expect(200);
    t.upstreams.update(orderId, { status: 'COMPLETED', endedAt: new Date().toISOString() });
    await send(orderId, message('late')).expect(409);
    expect(t.upstreams.calls.length).toBeGreaterThan(0);
    expect(new Set(t.upstreams.calls.map((call) => call.method))).toEqual(new Set(['GET']));
    expect(t.upstreams.errands.get(orderId)).toMatchObject({ status: 'COMPLETED' });
  });
});
