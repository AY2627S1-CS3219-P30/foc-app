import { PgDb, errorMessage } from '@foc/platform';
import { CREDIT_INVARIANTS } from './credits/invariants.js';

/**
 * Checks the closed-economy invariants against the live Credit database and prints one line per
 * invariant. Exits 1 if any is violated. Read-only: it reports and changes nothing.
 *
 * Runs inside the container, so the stack scripts and an operator use the same checks as the
 * tests, with no copy of the SQL in shell:
 *
 *   docker compose exec -T credit-service node credit-service/dist/check-invariants.js
 */
const say = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set.');
  const db = new PgDb(url);
  try {
    let failed = 0;
    for (const [name, check] of Object.entries(CREDIT_INVARIANTS)) {
      const violations = await check(db);
      if (violations.length === 0) {
        say(`PASS  ${name}`);
      } else {
        failed++;
        say(`FAIL  ${name}`);
        for (const violation of violations.slice(0, 20)) say(`        ${violation}`);
        if (violations.length > 20) say(`        … and ${violations.length - 20} more`);
      }
    }
    return failed === 0 ? 0 : 1;
  } finally {
    await db.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(errorMessage(err));
    process.exit(2);
  },
);
