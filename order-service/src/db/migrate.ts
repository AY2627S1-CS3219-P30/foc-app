import { fileURLToPath } from 'node:url';
import { errorMessage, runDrizzleMigrations } from '@foc/platform';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  await runDrizzleMigrations(url, fileURLToPath(new URL('../../drizzle', import.meta.url)));
}

main().catch((err: unknown) => {
  console.error(errorMessage(err));
  process.exit(1);
});
