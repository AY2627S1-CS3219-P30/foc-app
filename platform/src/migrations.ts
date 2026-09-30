import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const MIGRATION_LOCK = `SELECT pg_advisory_lock(hashtext('foc.drizzle_migrations'))`;

/**
 * Applies the Drizzle migrations in `migrationsFolder` to `url`. One connection holds a session
 * lock for the whole run, so concurrent runners apply the migrations one after another.
 */
export async function runDrizzleMigrations(url: string, migrationsFolder: string): Promise<void> {
  assertJournalOrdered(migrationsFolder);
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(MIGRATION_LOCK);
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    client.release(true); // closing the session drops the advisory lock
    await pool.end();
  }
}

/**
 * Drizzle skips any migration older than the last one applied, so a journal merged out of order
 * must fail loudly rather than silently leave a migration unapplied.
 */
export function assertJournalOrdered(migrationsFolder: string): void {
  const { entries } = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as { entries: { tag: string; when: number }[] };
  let previous: (typeof entries)[number] | undefined;
  for (const entry of entries) {
    if (previous && entry.when <= previous.when) {
      throw new Error(`Migration ${entry.tag} is older than ${previous.tag}; regenerate it.`);
    }
    previous = entry;
  }
}
