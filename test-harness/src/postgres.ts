import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { PgDb, runDrizzleMigrations } from '@foc/platform';

/**
 * The administrative connection the ephemeral-database fixture uses to create and drop
 * databases. It must be a role with CREATEDB (CI uses the `postgres` superuser). Unset means
 * the real-PostgreSQL suites skip themselves, so `npm test` passes on a clean clone.
 */
export const TEST_POSTGRES_URL = process.env.TEST_POSTGRES_URL;

export interface EphemeralPostgres {
  /** Connection string for the new database. */
  readonly url: string;
  readonly name: string;
  /** A pooled connection to the new database. */
  readonly db: PgDb;
  /** Closes the pool and drops the database. Safe to call twice. */
  dispose(): Promise<void>;
}

/** Postgres identifiers are limited to 63 bytes and must not need quoting. */
const databaseName = (label: string): string => {
  const safe = label
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .slice(0, 40);
  return `foc_test_${safe}_${randomBytes(4).toString('hex')}`;
};

const withDatabase = (url: string, name: string): string => {
  const next = new URL(url);
  next.pathname = `/${name}`;
  return next.toString();
};

async function admin<T>(adminUrl: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates a fresh, uniquely named database, applies the service's generated migrations to it and
 * returns a pool. No test shares a database with another run or with a developer's local data, so
 * suites can be rerun and run in parallel (PL-NFR4.1, #145).
 */
export async function createEphemeralPostgres(options: {
  adminUrl: string;
  label: string;
  migrationsFolder?: string;
}): Promise<EphemeralPostgres> {
  const name = databaseName(options.label);
  await admin(options.adminUrl, (client) => client.query(`CREATE DATABASE "${name}"`));
  const url = withDatabase(options.adminUrl, name);
  let db: PgDb | undefined;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await db?.close();
    await admin(options.adminUrl, (client) =>
      client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
    );
  };
  try {
    if (options.migrationsFolder) await runDrizzleMigrations(url, options.migrationsFolder);
    db = new PgDb(url);
    return { url, name, db, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
