import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { PgDb } from '@foc/platform';

const MIGRATION_LOCK = `SELECT pg_advisory_lock(hashtext('foc.drizzle_migrations'))`;
const MIGRATION_UNLOCK = `SELECT pg_advisory_unlock(hashtext('foc.drizzle_migrations'))`;

/**
 * Applies the Drizzle migrations under ./drizzle to `DATABASE_URL`, then exits.
 * This is the discrete migration step — run it before the service starts: a
 * one-shot container in compose (`node supplier-service/dist/db/migrate.js`),
 * the `db:migrate` npm script on a host, or the deploy pipeline. The service
 * itself never migrates at boot.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');

  const raw = new PgDb(url);
  const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));
  // One connection holds a session lock for the whole run, so concurrent runners
  // (a deploy step and `db:migrate`, say) apply the migrations one after another.
  const client = await raw.pool.connect();
  try {
    await client.query(MIGRATION_LOCK);
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.query(MIGRATION_UNLOCK);
    client.release();
    await raw.close();
  }
  // Success is signalled by a clean exit (0); a one-shot container's consumers
  // wait on `service_completed_successfully`. Failures surface via the catch.
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
