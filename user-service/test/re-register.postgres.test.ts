import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  createEphemeralPostgres,
  TEST_POSTGRES_URL,
  type EphemeralPostgres,
} from '@foc/test-harness';
import type { Database } from '../src/db/db.js';
import * as schema from '../src/db/schema.js';
import { MemoryMailbox } from '../src/mail/memory-mailbox.js';
import { usersRepository as repo } from '../src/users/users.repository.js';
import { UsersService } from '../src/users/users.service.js';

const suite = TEST_POSTGRES_URL ? it : it.skip;
const EMAIL = 'e0123456@u.nus.edu';

let database: EphemeralPostgres;
let db: Database;
beforeEach(async () => {
  database = await createEphemeralPostgres({
    adminUrl: TEST_POSTGRES_URL!,
    label: 'user_re_register',
    migrationsFolder: fileURLToPath(new URL('../drizzle', import.meta.url)),
  });
  db = drizzle(database.db.pool, { schema }) as unknown as Database;
});
afterEach(async () => {
  await database?.dispose();
});

/** Resolves once `count` other sessions are queued on a lock in this database. */
async function waitersOnALock(count = 1): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const { rows } = await database.db.pool.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`,
    );
    if ((rows[0] as { n: number }).n >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`fewer than ${count} sessions ever waited on a lock`);
}

/** Holds the account's row lock in a transaction of its own until `release` is called. */
async function holdAccount(id: string): Promise<{ release: () => Promise<void> }> {
  const client = await database.db.pool.connect();
  await client.query('BEGIN');
  await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [id]);
  return {
    release: async () => {
      await client.query('COMMIT');
      client.release();
    },
  };
}

const issue = (tx: Database, userId: string) =>
  repo.insertActivationToken(tx, {
    id: randomUUID(),
    userId,
    tokenHash: randomUUID(),
    ttlHours: 24,
  });

suite('lets only one of two concurrent re-registers revive an expired address', async () => {
  const id = randomUUID();
  await repo.insertUser(db, { id, email: EMAIL, passwordHash: 'original', displayName: 'First' });
  await database.db.pool.query(
    `INSERT INTO activation_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, 'lapsed', now() - interval '1 minute')`,
    [randomUUID(), id],
  );

  let holding!: () => void, release!: () => void;
  const aHolds = new Promise<void>((resolve) => (holding = resolve));
  const aMayCommit = new Promise<void>((resolve) => (release = resolve));
  const reRegister = (passwordHash: string, beforeCommit?: () => Promise<void>) =>
    db.transaction(async (tx) => {
      const revived = await repo.reviveExpiredRegistration(tx, {
        email: EMAIL,
        passwordHash,
        displayName: passwordHash,
      });
      if (revived) await issue(tx, revived);
      await beforeCommit?.();
      return revived;
    });

  // A revives and issues its link, then holds its transaction open until B is queued behind it.
  const a = reRegister('by-a', async () => {
    holding();
    await aMayCommit;
  });
  await aHolds;
  const b = reRegister('by-b');
  await waitersOnALock();
  release();

  expect(await a).toBe(id);
  expect(await b).toBeNull();
  const { rows } = await database.db.pool.query('SELECT password_hash FROM users WHERE id = $1', [
    id,
  ]);
  expect(rows[0]).toEqual({ password_hash: 'by-a' });
});

suite(
  'queues an activation behind a resend of the same account instead of deadlocking',
  async () => {
    const mailbox = new MemoryMailbox();
    const service = new UsersService(db, mailbox, {
      allowedEmailDomains: ['u.nus.edu'],
      activationTokenTtlHours: 24,
    });
    const { userId } = await service.register({
      email: EMAIL,
      password: 'a-long-enough-password',
      displayName: 'First',
    });
    const first = mailbox.latestFor(EMAIL)!.token;

    // Resend queues on the account first, then activation. Were activation to claim its link before
    // locking the account, it would hold the link while resend, holding the account, waits to delete it.
    const blocker = await holdAccount(userId);
    const resent = service.resendActivation(EMAIL);
    await waitersOnALock(1);
    const activated = service.activate(first, randomUUID()).then(
      () => 'activated',
      (err: { status?: number; code?: string }) => err.code ?? String(err),
    );
    await waitersOnALock(2);
    await blocker.release();

    await resent;
    // Resend went first and replaced the link, so the old one is refused, not deadlocked.
    expect(await activated).toBe('ACTIVATION_TOKEN_INVALID');
    expect(mailbox.latestFor(EMAIL)!.token).not.toBe(first);
  },
);
