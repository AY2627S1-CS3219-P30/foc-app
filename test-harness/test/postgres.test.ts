import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import {
  createEphemeralPostgres,
  TEST_POSTGRES_URL,
  type EphemeralPostgres,
} from '../src/index.js';

const suite = TEST_POSTGRES_URL ? describe : describe.skip;
const ORDER_MIGRATIONS = fileURLToPath(new URL('../../order-service/drizzle', import.meta.url));

suite('ephemeral PostgreSQL fixture', () => {
  const opened: EphemeralPostgres[] = [];
  afterAll(async () => Promise.all(opened.map((database) => database.dispose())));

  it('gives each caller its own migrated database and drops it afterwards', async () => {
    const [first, second] = await Promise.all([
      createEphemeralPostgres({
        adminUrl: TEST_POSTGRES_URL!,
        label: 'harness',
        migrationsFolder: ORDER_MIGRATIONS,
      }),
      createEphemeralPostgres({
        adminUrl: TEST_POSTGRES_URL!,
        label: 'harness',
        migrationsFolder: ORDER_MIGRATIONS,
      }),
    ]);
    opened.push(first!, second!);
    expect(first!.name).not.toBe(second!.name);

    // Writes to one database are invisible to the other.
    await first!.db.query(`CREATE TABLE harness_marker (id int)`);
    const [a, b] = await Promise.all(
      [first!, second!].map((database) =>
        database.db.query<{ present: boolean }>(
          `SELECT to_regclass('harness_marker') IS NOT NULL AS present`,
        ),
      ),
    );
    expect(a!.rows[0]!.present).toBe(true);
    expect(b!.rows[0]!.present).toBe(false);
    // Both received the service's migrations.
    const seeded = await second!.db.query<{ n: string }>(`SELECT count(*) AS n FROM orders`);
    expect(Number(seeded.rows[0]!.n)).toBeGreaterThan(0);

    await first!.dispose();
    await first!.dispose(); // idempotent
    const admin = new pg.Client({ connectionString: TEST_POSTGRES_URL });
    await admin.connect();
    try {
      const remaining = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [
        first!.name,
      ]);
      expect(remaining.rowCount).toBe(0);
    } finally {
      await admin.end();
    }
  });
});
