# Credit wallet-versus-ledger audit (CRD-10, #283)

This is Credit's financial check for CS-NFR4.1.1 and the reconciliation runbook contribution to
REL-02 (#168). It compares every wallet's available/reserved balance with its signed ledger entries,
checks total held against total issued, checks balanced transactions, non-negative whole balances,
reservation backing and one reservation/terminal outcome per errand. It reports; it never repairs.

Order's existing `credit-reconciler.ts` (#152) has a different job: retry pending saga commands using
Credit's recorded operation status. Do not use a clean saga run as evidence of clean financial books.

## Schedule and persistence

Credit starts a scan at boot if today's UTC scheduled run is missing, then checks eligibility every
60 seconds. PostgreSQL's date and advisory transaction lock coordinate replicas; the unique
`scheduled_day` allows one completed scheduled scan per UTC day. Normal credit transactions continue
while all six checks see one `REPEATABLE READ` snapshot. A manual/CLI scan may run again on the same
day. A busy audit is skipped by the scheduler and retried at the next poll.

Each completed scan appends its findings to `ledger_audit_runs` (migration `0008`). `PASS` means zero
findings; `MISMATCH` means one or more findings. Counts represent findings across checks, so the same
fault can appear more than once. An execution failure appends `ERROR` with a null mismatch count
when storage is reachable; it does not consume today's scheduled slot. The scheduler retries on
the next poll. If storage itself is unavailable, logs and the stale-scan alert are the evidence;
there cannot be a durable run record until storage works again.

UPDATE, DELETE and TRUNCATE of run history are refused by database triggers. The API exposes check
names/counts and run metadata only; detailed findings include wallet identifiers and balances and
remain in the restricted Credit database. General logs contain the run ID and counts, not findings.

## Run on demand

From the repository root, with the usual local stack running:

```bash
npm run audit:credits
```

This executes `node credit-service/dist/audit-ledger.js` inside Credit, using its existing
`DATABASE_URL`; no credential is passed on the command line. Exit 0 means PASS, 1 means MISMATCH,
2 means busy or an execution failure. It creates a `CLI` run. Migrations must have run first.

Alternatively, sign in as an administrator at <http://localhost:3000>, open **Admin → Operations**
(`/admin/operations`), and select **Run ledger audit**. Refresh to see another replica's scheduled
run. The panel shows the latest run's status, UTC-converted completion time, origin, run ID and each
check's count. An execution failure is explicitly ERROR, never a clean zero.

The guarded Credit API is `GET /admin/ledger-audits/latest` and `POST /admin/ledger-audits/run`
(through the edge: `/api/credit/admin/ledger-audits/...`). Both require the administrator's bearer
token, checked by Credit against live identity. GET returns `{ "run": null }` before the first
run. POST returns 200 for a completed PASS or MISMATCH, 409 `LEDGER_AUDIT_BUSY` when another scan
holds the lock, or 503 `LEDGER_AUDIT_FAILED` on execution failure. Neither endpoint changes money.

## Respond to an alert

Prometheus evaluates `observability/alerts.yml` every 15 seconds. In the local stack, alerts appear
on <http://localhost:9090/alerts> and Grafana's Firing alerts panel; there is no Alertmanager or
external notification delivery.

| Alert                      | Meaning                                             | First action                                                     |
| -------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| `CreditLedgerMismatch`     | Last completed financial scan had findings          | Save the run ID; inspect findings below                          |
| `CreditLedgerAuditFailed`  | Latest attempt failed to complete                   | Read Credit logs for its run ID; check DB/migrations, then retry |
| `CreditLedgerAuditOverdue` | No completed scan in 25 hours, sustained 10 minutes | Check Credit/scheduler/DB and run on demand                      |

The persistence-backed gauges are `foc_credit_ledger_audit_mismatches`,
`foc_credit_ledger_audit_failed`, and `foc_credit_ledger_audit_last_completed_timestamp_seconds`.
They survive service restarts. A failed attempt preserves the last completed scan's mismatch count;
it cannot clear a known mismatch. Database collection failures produce NaN, not a fabricated zero.

1. Record the run ID and time from Operations; preserve the backup and relevant service logs.
2. An authorized database operator can inspect immutable findings without changing any data:

   ```bash
   docker compose exec -T postgres psql -U postgres -d foc_credit
   ```

   In `psql`, use the UUID shown in Operations:

   ```sql
   \prompt 'Audit run UUID: ' audit_run_id
   SELECT run_id, origin, status, mismatch_count, started_at, completed_at, results, error
     FROM ledger_audit_runs WHERE run_id = :'audit_run_id'::uuid;
   \q
   ```

   Replace `postgres` with the configured `POSTGRES_USER` if it differs. These findings contain
   account data: keep them with authorized operators, not in public issue comments or screenshots.

3. Investigate the affected transaction and event history through existing audited wallet reads,
   errand trace, inbox/outbox and backups. A mismatch is not permission to edit balances, delete
   ledger history or disable its triggers. Determine an approved recovery/restore path first.
4. After the cause is corrected through that path, run the audit again. A complete clean scan
   clears the mismatch gauge; ERROR does not. Keep the earlier run and incident evidence.

## Reproduce the corruption check safely

The committed test `credit-service/test/ledger-audit.test.ts` creates a disposable PGlite database,
temporarily disables its ledger immutability trigger, changes one ledger amount, re-enables the
trigger, and proves the audit records a mismatch without repairing it. It also tests balanced
cross-wallet drift, lifecycle movements, restart metrics, authorization and immutable run history.
Real-PostgreSQL tests prove advisory locking, one daily scan across replicas and snapshot isolation.
Never run the corruption SQL against the application/demo databases.

```bash
npm test -w @foc/credit-service -- ledger-audit
docker run --rm -v "$PWD/observability:/rules:ro" --entrypoint promtool \
  prom/prometheus:v3.13.4@sha256:87861b8cf91579109319ebc300f3f1060e6da9c05d6ae8ad15a20c879e84e32e \
  test rules /rules/alerts.test.yml
```

Set `TEST_POSTGRES_URL` for the real-PostgreSQL cases; without it those cases explicitly skip.
CI supplies PostgreSQL and runs the service tests and the promtool firing/recovery tests.
