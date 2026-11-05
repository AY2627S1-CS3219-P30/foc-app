import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PEOPLE,
  as,
  createTestApp,
  http,
  message,
  type Person,
  type TestApp,
} from './helpers/app.js';
import { ChatRepository } from '../src/chat/chat.repository.js';
import { RetentionCleanup } from '../src/chat/retention.js';
import { Upstreams } from '../src/chat/upstreams.js';

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
  it('refuses anyone but the participants and administrators: 403 to read, send and mark read', async () => {
    const orderId = t.upstreams.errand();
    await send(orderId, message('private')).expect(201);
    for (const res of [
      await channel(orderId, 'stranger'),
      await page(orderId, '', 'stranger'),
      await send(orderId, message('let me in'), 'stranger'),
      await read(orderId, 0, 'stranger'),
    ]) {
      expect([res.status, res.body.error.code]).toEqual([403, 'NOT_PARTICIPANT']);
      expect(JSON.stringify(res.body)).not.toContain('private');
    }
  });

  it('tells a stranger no more about an errand without a courier or channel than an unknown one', async () => {
    const pending = t.upstreams.errand({ status: 'CANCELLED', courierId: null });
    expect((await channel(pending, 'stranger').expect(404)).body.error.code).toBe('NOT_FOUND');
    await send(pending, message('anyone?'), 'stranger').expect(404);
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

  it('takes 280 characters counted as the browser counts them, not UTF-16 units', async () => {
    const orderId = t.upstreams.errand();
    await send(orderId, message('🙂'.repeat(280))).expect(201);
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
      message('x'.repeat(281)),
      message('🙂'.repeat(281)),
      message(' \n\t\u00a0'),
    ]) {
      expect((await send(orderId, body).expect(422)).body.error.code).toBe('VALIDATION_FAILED');
    }
    await http(t).get('/channels/not-a-uuid').set('Authorization', as('requester')).expect(400);
    expect(t.upstreams.calls.length).toBe(before);
  });
});

describe('a send that cannot go ahead (#373)', () => {
  it('does not take the locks again for a retry of a stored message', async () => {
    const orderId = t.upstreams.errand();
    const body = message('only once');
    await send(orderId, body).expect(201);
    const stored = vi.spyOn(t.app.get(ChatRepository), 'send');

    await send(orderId, body).expect(200);

    expect(stored).not.toHaveBeenCalled();
    stored.mockRestore();
  });

  it('finds no channel to send to if it was deleted during the send', async () => {
    const answer = await t.app
      .get(ChatRepository)
      .send(randomUUID(), PEOPLE.requester.userId, randomUUID(), 'too late');
    expect(answer).toEqual({ closed: true });
  });

  it('answers 409 when the channel has gone by the time the send has its locks', async () => {
    const orderId = t.upstreams.errand();
    const repository = vi
      .spyOn(t.app.get(ChatRepository), 'send')
      .mockResolvedValue({ closed: true });
    const res = await send(orderId, message('too late')).expect(409);
    expect(res.body.error.code).toBe('CHANNEL_CLOSED');
    repository.mockRestore();
  });

  it('answers 503 when the send waited too long for its turn', async () => {
    const orderId = t.upstreams.errand();
    const repository = vi
      .spyOn(t.app.get(ChatRepository), 'send')
      .mockResolvedValue({ busy: true });
    const res = await send(orderId, message('waits too long')).expect(503);
    expect(res.body.error.code).toBe('UNAVAILABLE');
    repository.mockRestore();
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
    for (const query of [
      '?after=1&before=3',
      '?limit=0',
      '?limit=101',
      '?after=-1',
      '?before=0',
      // Past PostgreSQL's integer, which would otherwise be a 500.
      '?after=2147483648',
      '?before=2147483648',
      '?before=99999999999',
    ]) {
      expect((await page(orderId, query).expect(422)).body.error.code).toBe('VALIDATION_FAILED');
    }
    await page(orderId, '?after=2147483647').expect(200);
    await page(orderId, '?before=2147483647').expect(200);
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

  it('fails closed with 503 when the Order Service answers an end time that is not a date-time', async () => {
    const orderId = t.upstreams.errand();
    await channel(orderId).expect(200);
    t.upstreams.update(orderId, { status: 'COMPLETED', endedAt: 'last Tuesday' });
    for (const res of [await channel(orderId), await page(orderId, '', 'admin')]) {
      expect([res.status, res.body.error.code]).toEqual([503, 'UNAVAILABLE']);
    }
    t.upstreams.update(orderId, { endedAt: '2026-11-01T09:30:00+08:00' });
    await channel(orderId).expect(200);
  });

  it('names a participant the User Service no longer has, rather than failing the channel', async () => {
    const orderId = t.upstreams.errand({ requesterId: 'user-ghost' });
    const res = await channel(orderId, 'courier').expect(200);
    expect(res.body.requester).toEqual({ userId: 'user-ghost', displayName: 'A former student' });
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

/** NTH-03 (#163, ADR 0012 §2, §5, §6): administrators read only, the limits, and retention. */
const DAY_MS = 24 * 60 * 60_000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString();
const adminReads = async () =>
  (
    await t.db.query<{ admin_user_id: string; order_id: string; resource: string }>(
      'SELECT admin_user_id, order_id, resource FROM admin_channel_reads ORDER BY read_at',
    )
  ).rows;
const channelRows = async (orderId: string) =>
  (await t.db.query('SELECT 1 FROM channels WHERE order_id = $1', [orderId])).rows.length;

describe('administrators read, and only read', () => {
  it('reads any channel and its messages, and every read is recorded', async () => {
    const orderId = t.upstreams.errand();
    await send(orderId, message('the agreed price')).expect(201);
    await read(orderId, 1).expect(200);

    const res = await channel(orderId, 'admin')
      .set('X-Correlation-Id', 'dispute-review-1')
      .expect(200);
    expect(res.body).toMatchObject({
      myRole: 'ADMIN',
      requester: PEOPLE.requester,
      courier: PEOPLE.courier,
      lastReadSeq: 0,
      latestSeq: 1,
    });
    const messages = await page(orderId, '', 'admin').expect(200);
    expect(messages.body.items).toMatchObject([{ seq: 1, body: 'the agreed price' }]);

    expect(await adminReads()).toEqual([
      { admin_user_id: PEOPLE.admin.userId, order_id: orderId, resource: 'CHANNEL' },
      { admin_user_id: PEOPLE.admin.userId, order_id: orderId, resource: 'MESSAGES' },
    ]);
    const { rows } = await t.db.query<{ correlation_id: string }>(
      `SELECT correlation_id FROM admin_channel_reads WHERE resource = 'CHANNEL'`,
    );
    expect(rows[0]!.correlation_id).toBe('dispute-review-1');
  });

  it('records one row per admin, errand, resource and hour, counting the reads in it', async () => {
    const orderId = t.upstreams.errand();
    await channel(orderId).expect(200);
    const records = async () =>
      (
        await t.db.query<{ resource: string; read_count: number; correlation_id: string }>(
          `SELECT resource, read_count, correlation_id FROM admin_channel_reads
            WHERE order_id = $1 ORDER BY resource, read_at`,
          [orderId],
        )
      ).rows;
    const poll = (correlationId: string) =>
      page(orderId, '', 'admin').set('X-Correlation-Id', correlationId).expect(200);

    await poll('poll-1');
    await poll('poll-2');
    await channel(orderId, 'admin').set('X-Correlation-Id', 'open-1').expect(200);
    expect(await records()).toEqual([
      { resource: 'CHANNEL', read_count: 1, correlation_id: 'open-1' },
      { resource: 'MESSAGES', read_count: 2, correlation_id: 'poll-1' },
    ]);

    // As if those reads were an hour ago: the next one starts a row of its own.
    await t.db.query(
      `UPDATE admin_channel_reads SET read_hour = read_hour - interval '1 hour',
              read_at = read_at - interval '1 hour' WHERE order_id = $1`,
      [orderId],
    );
    await poll('poll-3');
    expect(await records()).toEqual([
      { resource: 'CHANNEL', read_count: 1, correlation_id: 'open-1' },
      { resource: 'MESSAGES', read_count: 2, correlation_id: 'poll-1' },
      { resource: 'MESSAGES', read_count: 1, correlation_id: 'poll-3' },
    ]);
  });

  it('cannot send or mark read, and neither is recorded as a read', async () => {
    const orderId = t.upstreams.errand();
    await channel(orderId).expect(200);
    const sent = await send(orderId, message('as the admin'), 'admin').expect(403);
    expect(sent.body.error.code).toBe('NOT_PARTICIPANT');
    expect((await read(orderId, 0, 'admin').expect(403)).body.error.code).toBe('NOT_PARTICIPANT');
    expect((await page(orderId).expect(200)).body.items).toEqual([]);
    expect(await adminReads()).toEqual([]);
  });

  it('gets 404 for a channel never opened, and opens nothing', async () => {
    const orderId = t.upstreams.errand();
    expect((await channel(orderId, 'admin').expect(404)).body.error.code).toBe('NOT_FOUND');
    await page(orderId, '', 'admin').expect(404);
    expect(await channelRows(orderId)).toBe(0);
    expect(await adminReads()).toEqual([]);
  });

  it('is the participant on their own errand: sends, and their reads are not recorded', async () => {
    const orderId = t.upstreams.errand({ requesterId: PEOPLE.admin.userId });
    expect((await channel(orderId, 'admin').expect(200)).body.myRole).toBe('REQUESTER');
    await send(orderId, message('my own errand'), 'admin').expect(201);
    expect((await read(orderId, 1, 'admin').expect(200)).body).toEqual({ lastReadSeq: 1 });
    expect(await adminReads()).toEqual([]);
  });
});

describe('an errand that has ended', () => {
  it('rejects a new message with 409 server-side', async () => {
    const orderId = t.upstreams.errand();
    await channel(orderId).expect(200);
    t.upstreams.update(orderId, { status: 'CANCELLED', endedAt: new Date().toISOString() });
    expect((await send(orderId, message('late')).expect(409)).body.error.code).toBe(
      'CHANNEL_CLOSED',
    );
  });

  it('opens no new channel: 404 if it never had one', async () => {
    const orderId = t.upstreams.errand({ status: 'COMPLETED', endedAt: new Date().toISOString() });
    expect((await channel(orderId).expect(404)).body.error.code).toBe('NOT_FOUND');
    await page(orderId, '', 'courier').expect(404);
    await send(orderId, message('hello?')).expect(404);
    expect(await channelRows(orderId)).toBe(0);
  });
});

describe('message length', () => {
  it('counts code points: 280 emoji are accepted, 281 characters are not', async () => {
    const orderId = t.upstreams.errand();
    const emoji = '\u{1F600}'.repeat(280);
    expect(emoji.length).toBe(560);
    expect((await send(orderId, message(emoji)).expect(201)).body.body).toBe(emoji);

    const tooLong = await send(orderId, message('\u{1F600}'.repeat(281))).expect(422);
    expect(tooLong.body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'body', message: 'At most 280 characters.' }],
    });
  });

  it('refuses a body of only whitespace', async () => {
    const orderId = t.upstreams.errand();
    const res = await send(orderId, message('  \n\t ')).expect(422);
    expect(res.body.error).toMatchObject({
      code: 'VALIDATION_FAILED',
      details: [{ field: 'body', message: 'Must not be only whitespace.' }],
    });
    await send(orderId, message('  ok  ')).expect(201);
  });
});

describe('20 new messages a minute per sender', () => {
  const sendMany = async (orderId: string, count: number, who: Person = 'requester') => {
    for (let i = 0; i < count; i++) await send(orderId, message(`m${i}`), who).expect(201);
  };
  /** Moves the sender's oldest messages back in time, as if they were sent `seconds` ago. */
  const age = (count: number, seconds: number) =>
    t.db.query(
      `UPDATE messages SET sent_at = now() - make_interval(secs => $2)
        WHERE (order_id, seq) IN (SELECT order_id, seq FROM messages WHERE sender_id = $1
                                   ORDER BY sent_at, seq LIMIT $3)`,
      [PEOPLE.requester.userId, seconds, count],
    );

  it('refuses the 21st with 429 and the seconds until the oldest leaves the window', async () => {
    const orderId = t.upstreams.errand();
    await sendMany(orderId, 20);
    await age(1, 50);
    const limited = await send(orderId, message('one too many')).expect(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    // 10 seconds less however long the runner took since `age`.
    const retryAfter = Number(limited.headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(8);
    expect(retryAfter).toBeLessThanOrEqual(10);
    expect((await channel(orderId).expect(200)).body.latestSeq).toBe(20);
    // Another sender has their own allowance.
    await send(orderId, message('still here'), 'courier').expect(201);
  });

  it('answers a retry of a stored message at the limit, without counting it', async () => {
    const orderId = t.upstreams.errand();
    const first = message('first');
    const stored = await send(orderId, first).expect(201);
    await sendMany(orderId, 19);
    expect((await send(orderId, first).expect(200)).body).toEqual(stored.body);
    await send(orderId, message('new')).expect(429);
  });

  it('counts across all of the sender’s channels', async () => {
    const [a, b, c] = [t.upstreams.errand(), t.upstreams.errand(), t.upstreams.errand()];
    await sendMany(a, 10);
    await sendMany(b, 10);
    expect((await send(c, message('third errand')).expect(429)).body.error.code).toBe(
      'RATE_LIMITED',
    );
  });

  it('slides: a message older than 60 seconds no longer counts', async () => {
    const orderId = t.upstreams.errand();
    await sendMany(orderId, 20);
    await age(5, 61);
    await sendMany(orderId, 5);
    await send(orderId, message('sixth')).expect(429);
  });
});

describe('kept 90 days after the errand ends', () => {
  const cleanup = () =>
    new RetentionCleanup(t.app.get(ChatRepository), t.app.get(Upstreams), {
      retentionDays: 90,
      intervalMs: DAY_MS,
      retryMs: 5 * 60_000,
    });
  /** A channel with one message, opened `daysOld` days ago. */
  const openedChannel = async (daysOld = 100) => {
    const orderId = t.upstreams.errand();
    await send(orderId, message('evidence')).expect(201);
    await t.db.query(
      `UPDATE channels SET created_at = now() - make_interval(days => $2) WHERE order_id = $1`,
      [orderId, daysOld],
    );
    return orderId;
  };
  const end = (orderId: string, days: number) =>
    t.upstreams.update(orderId, { status: 'COMPLETED', endedAt: daysAgo(days) });

  it('answers 404 on every route, to everyone, once 90 days have passed', async () => {
    const orderId = await openedChannel();
    end(orderId, 89);
    await page(orderId, '', 'admin').expect(200);
    end(orderId, 91);
    for (const who of ['requester', 'courier', 'admin', 'stranger'] as const) {
      for (const res of [
        await channel(orderId, who),
        await page(orderId, '', who),
        await send(orderId, message('anyone?'), who),
        await read(orderId, 0, who),
      ]) {
        expect([res.status, res.body.error.code]).toEqual([404, 'NOT_FOUND']);
      }
    }
  });

  it('deletes only channels past retention, and keeps the admin read records', async () => {
    const expired = await openedChannel();
    const recent = await openedChannel();
    const running = await openedChannel();
    const unknown = await openedChannel();
    const youngChannel = await openedChannel(1);
    await page(expired, '', 'admin').expect(200);
    end(expired, 91);
    end(recent, 10);
    end(youngChannel, 91);
    t.upstreams.errands.delete(unknown);

    expect(await cleanup().sweep()).toEqual({ deleted: 1, kept: 2, skipped: 0, unknown: 1 });
    expect(await channelRows(expired)).toBe(0);
    const left = await t.db.query('SELECT 1 FROM messages WHERE order_id = $1', [expired]);
    expect(left.rows).toEqual([]);
    for (const kept of [recent, running, unknown, youngChannel]) {
      expect(await channelRows(kept)).toBe(1);
    }
    expect(await adminReads()).toEqual([
      { admin_user_id: PEOPLE.admin.userId, order_id: expired, resource: 'MESSAGES' },
    ]);
  });

  it('pages past the channels it has just deleted, and leaves the young ones', async () => {
    const expired = [];
    for (let i = 0; i < 5; i += 1) {
      const orderId = await openedChannel();
      end(orderId, 91);
      expired.push(orderId);
    }
    const young = await openedChannel(1);
    end(young, 91);
    const small = new RetentionCleanup(t.app.get(ChatRepository), t.app.get(Upstreams), {
      retentionDays: 90,
      intervalMs: DAY_MS,
      retryMs: 5 * 60_000,
      batchSize: 2,
      concurrency: 2,
    });

    expect(await small.sweep()).toEqual({ deleted: 5, kept: 0, skipped: 0, unknown: 0 });
    for (const orderId of expired) expect(await channelRows(orderId)).toBe(0);
    expect(await channelRows(young)).toBe(1);
  });

  it('deletes nothing while the Order Service does not answer', async () => {
    const orderId = await openedChannel();
    end(orderId, 91);
    t.upstreams.down = true;
    expect(await cleanup().sweep()).toEqual({ deleted: 0, kept: 0, skipped: 1, unknown: 0 });
    expect(await channelRows(orderId)).toBe(1);
    t.upstreams.down = false;
    expect((await cleanup().sweep()).deleted).toBe(1);
  });
});
