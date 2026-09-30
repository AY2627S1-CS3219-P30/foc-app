import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration for the Supplier Service. Drives `db:generate`
 * (diff the schema into SQL migrations under ./drizzle), `db:studio` and
 * `db:push`, all against `src/db/schema.ts`.
 *
 * The migrations in ./drizzle are the source of truth applied to the database.
 * They are applied by `npm run db:migrate` or the compose migrate container,
 * never at boot.
 */
const url = process.env.DATABASE_URL;

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  // Left out when unset so push/studio fail rather than hit another database; generate needs none.
  ...(url && { dbCredentials: { url } }),
});
