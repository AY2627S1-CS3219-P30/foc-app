// AI Assistance Disclosure:
// Tool: Claude Code (Claude Opus 5.5), date: 2026-10-30
// Scope: Generated the initial implementation for "wire the fifth service into the stack" (NTH-11,
//   #345).
// Author review: Zhang Yuan validated the behaviour and the implementation, checked for fatal
//   errors, and confirmed it does not conflict with the architecture before committing.

import { fileURLToPath } from 'node:url';
import { errorMessage, runDrizzleMigrations } from '@foc/platform';

/**
 * Applies the Drizzle migrations under ./drizzle to `DATABASE_URL`, then exits.
 * This is the discrete migration step — run it before the service starts: a
 * one-shot container in compose (`node chat-service/dist/db/migrate.js`), the
 * `db:migrate` npm script on a host, or the deploy pipeline. The service itself
 * never migrates at boot. Success is a clean exit (0); a one-shot container's
 * consumers wait on `service_completed_successfully`.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  await runDrizzleMigrations(url, fileURLToPath(new URL('../../drizzle', import.meta.url)));
}

main().catch((err: unknown) => {
  console.error(errorMessage(err));
  process.exit(1);
});
