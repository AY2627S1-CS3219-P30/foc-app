'use client';

import { useState } from 'react';
import { Button } from '@/components/Button';
import { FormAlert } from '@/components/FormField';
import { adminApi } from '@/lib/admin-api';
import { useAuth } from '@/lib/auth';
import { formatInstant } from '@/lib/admin-labels';
import { useAdminData } from '../_components/use-admin-data';
import { Loaded, Section, Tag } from '../_components/ui';

/** CRD-10: summaries only; detailed findings stay behind the operator runbook and audited reads. */
export function LedgerAudit() {
  const { authed } = useAuth();
  const latest = useAdminData('ledger-audit', (token) => adminApi.latestLedgerAudit(token));
  const [running, setRunning] = useState(false);
  const [problem, setProblem] = useState<string>();

  async function run() {
    setRunning(true);
    setProblem(undefined);
    try {
      await authed((token) => adminApi.runLedgerAudit(token));
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'The audit could not complete.');
    } finally {
      latest.reload();
      setRunning(false);
    }
  }

  return (
    <Section
      title="Daily credit ledger audit"
      description="Compares wallets with the ledger, checks conservation and balanced transactions. Runs daily in UTC and on demand; it never repairs balances."
      actions={
        <Button disabled={running || latest.loading} onClick={() => void run()}>
          {running ? 'Running audit…' : 'Run ledger audit'}
        </Button>
      }
    >
      <FormAlert>{problem}</FormAlert>
      <Loaded state={latest} label="the ledger audit">
        {({ run }) =>
          !run ? (
            <p>No audit has run yet.</p>
          ) : (
            <div aria-live="polite">
              <p>
                <Tag tone={run.status === 'PASS' ? 'info' : 'danger'}>{run.status}</Tag>{' '}
                {run.mismatchCount === null
                  ? 'Scan did not complete.'
                  : `${run.mismatchCount} mismatch(es).`}
              </p>
              <p>
                Completed {formatInstant(run.completedAt)} · {run.origin}
              </p>
              <p>
                Run ID: <code>{run.runId}</code>
              </p>
              {run.error && <FormAlert>{run.error}</FormAlert>}
              <ul>
                {run.checks.map((check) => (
                  <li key={check.name}>
                    {check.name}: {check.mismatchCount}
                  </li>
                ))}
              </ul>
              {run.status !== 'PASS' && (
                <p>
                  Investigate using the ledger-audit runbook and immutable run ID. No balance has
                  been changed by this audit.
                </p>
              )}
            </div>
          )
        }
      </Loaded>
    </Section>
  );
}
