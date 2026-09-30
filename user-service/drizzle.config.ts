import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration for the User Service. Drives `db:generate` (diff the
 * schema into SQL migrations under ./drizzle), `db:migrate` (apply them),
 * `db:studio` and `db:push`, all against `src/db/schema.ts`.
 *
 * The migrations in ./drizzle are the source of truth applied to the database:
 * a generated structural baseline plus a hand-written custom migration for the
 * `audit_records` append-only trigger, its plpgsql function and the `REVOKE`,
 * which the Drizzle schema DSL cannot express. The service applies them at boot
 * (main.ts) and they can also be applied out-of-band with `npm run db:migrate`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/postgres' },
});
