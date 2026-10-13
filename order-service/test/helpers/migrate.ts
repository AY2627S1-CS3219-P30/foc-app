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
