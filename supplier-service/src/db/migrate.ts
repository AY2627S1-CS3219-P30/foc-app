import type { Db } from './db.js';
import { migrations, type Migration } from './migrations.js';

/**
 * Applies every migration not yet recorded, in order, each in its own
 * transaction. Returns the ids applied. Forward-only: there is no down step.
 */
export async function runMigrations(db: Db, list: Migration[] = migrations): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id         text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const { rows } = await db.query<{ id: string }>('SELECT id FROM schema_migrations');
  const done = new Set(rows.map((r) => r.id));
  const applied: string[] = [];

  for (const migration of list) {
    if (done.has(migration.id)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(migration.sql);
      await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
    });
    applied.push(migration.id);
  }
  return applied;
}
