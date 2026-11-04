import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { assertJournalOrdered } from '@foc/platform';
import * as schema from '../../src/db/schema.js';
import type { PgliteDb } from './pglite-db.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function applyMigrations(db: PgliteDb): Promise<void> {
  assertJournalOrdered(MIGRATIONS_DIR);
  await migrate(drizzle(db.client, { schema }), { migrationsFolder: MIGRATIONS_DIR });
}

/**
 * Applies the migrations that come before `tag`, so a test can write rows the way older code did
 * and then check what {@link applyMigrations} makes of them.
 */
export async function applyMigrationsBefore(db: PgliteDb, tag: string): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), 'order-migrations-'));
  try {
    cpSync(MIGRATIONS_DIR, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
    const index = journal.entries.findIndex((entry) => entry.tag === tag);
    if (index < 0) throw new Error(`No migration is tagged ${tag}.`);
    journal.entries = journal.entries.slice(0, index);
    writeFileSync(journalPath, JSON.stringify(journal));
    await migrate(drizzle(db.client, { schema }), { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
