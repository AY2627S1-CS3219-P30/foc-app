import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createEphemeralPostgres,
  TEST_POSTGRES_URL,
  type EphemeralPostgres,
} from '@foc/test-harness';
import { ChatRepository } from '../src/chat/chat.repository.js';

const suite = TEST_POSTGRES_URL ? describe : describe.skip;

/**
 * Sends racing on real PostgreSQL, which PGlite cannot show: it has one connection. The channel's
 * row lock must give every message its own `seq` and store a retried send once (#162).
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
        chat.send(orderId, i % 2 ? 'courier' : 'requester', randomUUID(), `m${i}`),
      ),
    );
    expect(sent.map((s) => s.message.seq).sort((a, b) => a - b)).toEqual(
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
    expect(sent.filter((s) => s.created)).toHaveLength(1);
    expect(new Set(sent.map((s) => s.message.seq))).toEqual(new Set([1]));
    const { rows } = await database.db.query(
      'SELECT count(*)::int AS n FROM messages WHERE order_id = $1',
      [orderId],
    );
    expect(rows[0]).toEqual({ n: 1 });
  });
});
