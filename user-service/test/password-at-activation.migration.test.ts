import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as schema from '../src/db/schema.js';
import { MIGRATIONS_DIR } from './helpers/migrate.js';
import { PgliteDb } from './helpers/pglite-db.js';

/**
 * Migration 0007 (#309) on a database that already holds accounts. It must stay rollback-safe
 * (docs/runbooks/backup-restore-rollback.md): it rewrites no account and adds no constraint an image
 * from before #309 could trip, and only shortens activation links still waiting to be used.
 */
let db: PgliteDb;
let before: string;

beforeAll(async () => {
  db = await PgliteDb.create();
  // The migrations as they were before 0007: the same folder with the journal cut short.
  before = mkdtempSync(join(tmpdir(), 'user-migrations-'));
  cpSync(MIGRATIONS_DIR, before, { recursive: true });
  const journalPath = join(before, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ tag: string }>;
  };
  journal.entries = journal.entries.filter((e) => e.tag < '0007');
  writeFileSync(journalPath, JSON.stringify(journal));
});
afterAll(async () => {
  await db.close();
  rmSync(before, { recursive: true, force: true });
});

const accounts = () =>
  db.query<{ email: string; status: string; password_hash: string | null }>(
    'SELECT email, status, password_hash FROM users ORDER BY email',
  );

it('keeps every account as it was, and cuts live activation links to 30 minutes', async () => {
  const orm = drizzle(db.client, { schema });
  await migrate(orm, { migrationsFolder: before });
  await db.exec(`
    INSERT INTO users (id, email, password_hash, status) VALUES
      ('00000000-0000-4000-8000-000000000001', 'a-pending@u.nus.edu', 'planted-hash', 'PENDING_ACTIVATION'),
      ('00000000-0000-4000-8000-000000000002', 'b-active@u.nus.edu', 'active-hash', 'ACTIVE'),
      ('00000000-0000-4000-8000-000000000003', 'c-suspended@u.nus.edu', 'suspended-hash', 'SUSPENDED');
    -- Issued under the old 24-hour lifetime: one unused, one used (its expiry is history).
    INSERT INTO activation_tokens (id, user_id, token_hash, expires_at, consumed_at) VALUES
      ('00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-000000000001',
       'unused', now() + interval '24 hours', NULL),
      ('00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-000000000002',
       'used', '2030-01-01T00:00:00Z', now());
  `);

  await migrate(orm, { migrationsFolder: MIGRATIONS_DIR });

  expect((await accounts()).rows).toEqual([
    // Activation now always replaces it, and a pending account cannot sign in.
    { email: 'a-pending@u.nus.edu', status: 'PENDING_ACTIVATION', password_hash: 'planted-hash' },
    { email: 'b-active@u.nus.edu', status: 'ACTIVE', password_hash: 'active-hash' },
    { email: 'c-suspended@u.nus.edu', status: 'SUSPENDED', password_hash: 'suspended-hash' },
  ]);

  const tokens = await db.query<{ token_hash: string; ttl: number; expires_at: Date }>(
    `SELECT token_hash, extract(epoch FROM expires_at - now())::int AS ttl, expires_at
       FROM activation_tokens ORDER BY token_hash`,
  );
  const unused = tokens.rows.find((t) => t.token_hash === 'unused');
  const used = tokens.rows.find((t) => t.token_hash === 'used');
  // A live link now lasts at most the new 30 minutes.
  expect(Number(unused!.ttl)).toBeGreaterThan(29 * 60);
  expect(Number(unused!.ttl)).toBeLessThanOrEqual(30 * 60);
  expect(new Date(used!.expires_at).toISOString()).toBe('2030-01-01T00:00:00.000Z');
});

it('lets an image from before #309 activate a pending account that has no password', async () => {
  // Registered after #309, so no password yet; an older image activates without setting one. The
  // account then cannot sign in (a NULL hash never matches) until its owner resets the password.
  await db.exec(`
    INSERT INTO users (id, email, password_hash, status) VALUES
      ('00000000-0000-4000-8000-000000000004', 'd-new@u.nus.edu', NULL, 'PENDING_ACTIVATION');
    UPDATE users SET status = 'ACTIVE', activated_at = now() WHERE email = 'd-new@u.nus.edu';
  `);
  const rows = await db.query<{ status: string; password_hash: string | null }>(
    `SELECT status, password_hash FROM users WHERE email = 'd-new@u.nus.edu'`,
  );
  expect(rows.rows).toEqual([{ status: 'ACTIVE', password_hash: null }]);
});
