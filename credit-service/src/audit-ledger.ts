import { PgDb, errorMessage } from '@foc/platform';
import { LedgerAuditService } from './credits/ledger-audit.service.js';

/** Operator entry point; no credential is accepted on the command line. Never edits balances. */
async function main(): Promise<number> {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const db = new PgDb(process.env.DATABASE_URL);
  try {
    const run = await new LedgerAuditService(db).run('CLI');
    if (!run) {
      console.error('Another ledger audit is running. Retry shortly.');
      return 2;
    }
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    return run.status === 'PASS' ? 0 : 1;
  } finally {
    await db.close();
  }
}
main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(errorMessage(err));
    process.exitCode = 2;
  },
);
