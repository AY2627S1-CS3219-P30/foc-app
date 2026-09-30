import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import * as schema from '../../src/db/schema.js';
import type { PgliteDb } from './pglite-db.js';

/** The generated Drizzle migrations, resolved regardless of the test's cwd. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Applies the Drizzle migrations to a fresh PGlite, exactly as the service does at boot. */
export async function applyMigrations(db: PgliteDb): Promise<void> {
  await migrate(drizzle(db.client, { schema }), { migrationsFolder: MIGRATIONS_DIR });
}
