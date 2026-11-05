import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEphemeralPostgres,
  TEST_POSTGRES_URL,
  type EphemeralPostgres,
} from '@foc/test-harness';
import { ChatRepository, lockSender } from '../src/chat/chat.repository.js';

const suite = TEST_POSTGRES_URL ? describe : describe.skip;

/**
 * Sends racing on real PostgreSQL, which PGlite cannot show: it has one connection. The channel's
 * row lock must give every message its own `seq` and store a retried send once (#162), the
 * sender's lock must hold a burst to the rate limit (#163), a sender waiting on their own lock must
 * hold up no one else, and no wait may last long enough to tie up the connection pool (#373).
 */
suite('Chat sends on real PostgreSQL', () => {
  let database: EphemeralPostgres;
  let chat: ChatRepository;

  beforeAll(async () => {
    database = await createEphemeralPostgres({
      adminUrl: TEST_POSTGRES_URL!,
      label: 'chat_sends',
      migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
    });
    chat = new ChatRepository(database.db);
  });
  afterAll(async () => database?.dispose());

  it('numbers 50 concurrent sends 1 to 50, with no gap or repeat', async () => {
    const orderId = randomUUID();
    await chat.open(orderId);
    const sent = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        // Five senders, ten each, all under the rate limit.
        chat.send(orderId, `sender-${i % 5}`, randomUUID(), `m${i}`),
      ),
    );
    expect(sent.map((s) => ('message' in s ? s.message.seq : 0)).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    expect(await chat.latestSeq(orderId)).toBe(50);
  });

  it('stores a send retried 20 times at once exactly once', async () => {
    const orderId = randomUUID();
    await chat.open(orderId);
    const clientId = randomUUID();
    const sent = await Promise.all(
      Array.from({ length: 20 }, () => chat.send(orderId, 'requester', clientId, 'only once')),
    );
    expect(sent.filter((s) => 'created' in s && s.created)).toHaveLength(1);
    expect(new Set(sent.map((s) => ('message' in s ? s.message.seq : 0)))).toEqual(new Set([1]));
    const { rows } = await database.db.query(
      'SELECT count(*)::int AS n FROM messages WHERE order_id = $1',
      [orderId],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  /** Takes `sender`'s lock in a transaction of its own, until the returned function is called. */
  async function holdSenderLock(sender: string) {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const underWay = database.db.transaction(async (tx) => {
      await lockSender(tx, sender);
      held();
      await released;
    });
    await holding;
    return async () => {
      release();
      await underWay;
    };
  }

  it('holds up no one else on a channel while a sender waits for their own lock', async () => {
    const orderId = randomUUID();
    await chat.open(orderId);
    const sender = `busy-${randomUUID()}`;
    // The sender's send on another channel, under way: it holds their lock.
    const finish = await holdSenderLock(sender);
    let queued: Promise<unknown> | undefined;
    let outcome: unknown;
    let other: unknown;
    let waited: unknown;
    try {
      queued = chat.send(orderId, sender, randomUUID(), 'queued behind their other send');
      await expect
        .poll(async () => {
          const { rows } = await database.db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE wait_event = 'advisory' AND query LIKE '%pg_advisory_xact_lock%'
                AND datname = current_database()`,
          );
          return rows[0]!.n;
        })
        .toBe(1);

      const someoneElse = chat.send(orderId, 'someone-else', randomUUID(), 'not held up');
      let timer: NodeJS.Timeout | undefined;
      outcome = await Promise.race([
        someoneElse,
        new Promise<'held up'>((resolve) => {
          timer = setTimeout(() => resolve('held up'), 1_000);
        }),
      ]);
      clearTimeout(timer);
      other = await someoneElse;
    } finally {
      await finish();
      waited = await queued;
    }

    expect(outcome).not.toBe('held up');
    expect(other).toMatchObject({ message: { seq: 1 }, created: true });
    expect(waited).toMatchObject({ message: { seq: 2 }, created: true });
  });

  it('answers busy after waiting 2 s for the sender, stores nothing, and a retry then goes through', async () => {
    const orderId = randomUUID();
    await chat.open(orderId);
    const sender = `stuck-${randomUUID()}`;
    const clientId = randomUUID();
    const finish = await holdSenderLock(sender);
    let answer: unknown;
    let took = 0;
    try {
      const started = Date.now();
      answer = await chat.send(orderId, sender, clientId, 'waits too long');
      took = Date.now() - started;
    } finally {
      await finish();
    }

    expect(answer).toEqual({ busy: true });
    expect(took).toBeGreaterThanOrEqual(1_900);
    expect(took).toBeLessThan(4_000);
    expect(await chat.latestSeq(orderId)).toBe(0);
    expect(await chat.send(orderId, sender, clientId, 'waits too long')).toMatchObject({
      message: { seq: 1 },
      created: true,
    });
  });

  it('answers busy after waiting 2 s for a channel someone else holds', async () => {
    const orderId = randomUUID();
    await chat.open(orderId);
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const holder = database.db.transaction(async (tx) => {
      await tx.query('SELECT 1 FROM channels WHERE order_id = $1 FOR UPDATE', [orderId]);
      held();
      await released;
    });
    await holding;
    let answer: unknown;
    try {
      answer = await chat.send(orderId, `s-${randomUUID()}`, randomUUID(), 'waits too long');
    } finally {
      release();
      await holder;
    }
    expect(answer).toEqual({ busy: true });
  });

  it('stores exactly 20 of a burst of 30 from one sender across three channels', async () => {
    // Over three channels, so the channel row lock alone cannot serialize them.
    const orderIds = [randomUUID(), randomUUID(), randomUUID()];
    for (const orderId of orderIds) await chat.open(orderId);
    const sender = `burst-${randomUUID()}`;
    const sent = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        chat.send(orderIds[i % 3]!, sender, randomUUID(), `m${i}`),
      ),
    );
    expect(sent.filter((s) => 'message' in s)).toHaveLength(20);
    const limited = sent.filter((s) => 'retryAfter' in s);
    expect(limited).toHaveLength(10);
    for (const s of limited) expect(s.retryAfter).toBeGreaterThan(50);
    for (const s of limited) expect(s.retryAfter).toBeLessThanOrEqual(60);
    const { rows } = await database.db.query(
      'SELECT count(*)::int AS n FROM messages WHERE sender_id = $1',
      [sender],
    );
    expect(rows[0]).toEqual({ n: 20 });
  });
});
