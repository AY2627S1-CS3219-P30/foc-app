# Project and PR context for Isaac

Living context for `isaacchua0309` in `AY2627S1-CS3219-P30/foc-app`.
Refreshed 2026-10-27 against `origin/main` `c5d5c0c` and live GitHub. Recheck GitHub before starting
another issue. This replaces the obsolete October 20 inventory; historical open/blocked claims
from that inventory must not be used as current state.

## 1. Project overview

FoC is a closed credit economy for campus errands. Node/TypeScript ESM services use NestJS and
`@foc/platform`; the Next.js web app sits behind the nginx edge. Local deployment is Compose.
User, Supplier, Order and Credit each own a separate PostgreSQL database/role. Services communicate
through contracted HTTP and RabbitMQ, never cross-service SQL. Public edge routes are
`/api/user`, `/api/supplier`, `/api/order`, `/api/credit`; `/internal` routes stay private.

Credit owns wallets, operations, transactions and immutable double-entry ledger entries.
`user.activated` issues a wallet once. Order saves `PENDING_CREDIT` and an outbox request together;
Credit reserves asynchronously. Completion transfers reserved credits to the courier; cancellation
and other eligible terminal paths release them. Inbox/outbox and operation keys make duplicates
safe. Order's `order-service/src/orders/credit-reconciler.ts` retries stalled saga commands (#152).
It is distinct from the daily financial wallet-versus-ledger audit (#283).

## 2. Assigned work

All four issues below are open. No open PR is authored by or assigned to Isaac at this snapshot;
the #283 branch is being prepared for its PR.

| Issue                                                             | Feature / classification                                        | Status                                                            | Dependencies                                                                                                | Blockers                                                                                      | Relevant code                                                                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#283](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/283) | CRD-10 financial audit; foundation                              | Implemented locally on `feat/283-wallet-ledger-audit`, not merged | #166 related, not a prerequisite; contributes a runbook to #168                                             | Non-author review and CI/merge still required                                                 | `credit-service/src/credits/ledger-audit.*`, `invariants.ts`, `web-app/src/app/(app)/admin/operations/LedgerAudit.tsx`, `observability/alerts.yml` |
| [#284](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/284) | PLT-09 stack backup/restore/rollback; integration               | Not started                                                       | Explicit #164 image publishing (closed); technical dependency on #283 for post-restore financial validation | Actual usable prior image set and timed disposable drill not yet verified                     | `compose.yaml`, `compose.images.yaml`, `scripts-smoke.sh`, `postgres-init.sh`, `.github/workflows/ci.yml`                                          |
| [#167](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/167) | REL-01 deterministic seed, smoke and D4 narrative; finalization | Not started; reassigned to Isaac in issue's D4 amendment          | Explicit TST-02 #160 (open, Patrick)                                                                        | Two successful non-owner rehearsals required; cannot fabricate them                           | `scripts-lib.sh`, `scripts-smoke.sh`, `scripts-demo-*.sh`, future `docs/demo/d4-runbook.md`                                                        |
| [#238](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/238) | DOC-04 ADR acceptance; team gate                                | Isaac's own approval merged in #300; shared completion pending    | Related #183/#226 satisfied; amendments in #250 (merged), #254 (open)                                       | Patrick pending; Jonus approval/amendments pending merge in #254; all five approvals required | `docs/adr/README.md`, ADRs 0002–0009                                                                                                               |

#167's original owner line still says Patrick; its D4 amendment and GitHub assignment supersede
that line. #284's body still says no published images exist; #164 is now closed, so verify actual
registry artifacts rather than repeating that historical claim. #283's issue describes financial
checks as test-only; this branch implements the runtime check but main does not yet include it.

## 3. Dependency graph

```text
#164 image publishing [closed; verify usable artifacts]
  └── #284 backup / restore / previous-image rollback
        ├── #168 restore runbook [Jonus]
        └── #169 rollback rehearsal [team]

#283 daily wallet-versus-ledger audit
  ├── #284 restore validates this audit after restoring all four databases
  └── #168 financial reconciliation runbook contribution

#160 browser journeys [open, Patrick]
  └── #167 final acceptance + two non-owner rehearsals
       (seed and narrative can be drafted before that gate clears)

#238 shared ADR acceptance
  ├── Isaac approval [merged #300]
  ├── Zhang Yuan / Anselm approvals [recorded on main]
  ├── Jonus amendment/approval [open #254]
  └── Patrick approval [pending]
```

Why these edges exist: #284 explicitly requires #164's published tags to start previous images;
it also explicitly calls the CRD-10 reconciliation after restore, which only #283 provides.
#168/#169 consume the resulting operator procedures/evidence. #167 explicitly names TST-02 as
its gate and requires other people to execute its rehearsal. #238 acceptance needs each named
person's recorded decision. No edge is inferred merely because work touches the same files.

## 4. Issue-by-issue technical context

### #283 — daily wallet-versus-ledger audit

Goal/acceptance: daily and on-demand Credit audit; reconstruct every wallet's available/reserved
from ledger movements; check total held equals issued and every transaction balances; immutable
findings, no repairs; metrics plus tested alert; latest result visible to admins; clean stack zero;
test-only ledger corruption detected; operator runbook contributed to #168.

Implementation on this branch:

- `walletLedgerViolations()` reconstructs signed CREDIT/DEBIT movements per wallet/account.
  `LedgerAuditService.run()` executes it plus the five existing `CREDIT_INVARIANTS` in one
  `REPEATABLE READ` transaction. Normal economic writes continue in their own transactions.
- PostgreSQL advisory transaction lock `283010` serializes audits, and unique UTC `scheduled_day`
  prevents duplicate scheduled runs across replicas/restarts. Scheduler polls every 60s and at
  bootstrap. Failed attempts do not consume the daily slot; manual/CLI scans may repeat.
- Additive migration `0008_ledger_audit_runs.sql` records PASS/MISMATCH/ERROR, counts, check findings,
  origin/requester and timestamps. Triggers refuse UPDATE, DELETE and TRUNCATE. ERROR count is
  null, not zero. Storage loss may prevent recording an attempt; logs/staleness remain evidence.
- Guarded GET `/admin/ledger-audits/latest` and POST `/admin/ledger-audits/run` expose summary
  metadata/counts only; detailed wallet findings remain in restricted storage. No new balance
  write route is added. The explicit closed-economy HTTP manifest/tests include both endpoints.
- `LedgerAudit` in Admin → Operations reads/runs the check. `npm run audit:credits` invokes
  `credit-service/dist/audit-ledger.js` inside the service; exit 0 PASS, 1 MISMATCH, 2 busy/error.
- Persistence-backed mismatch/failure/last-completed gauges feed mismatch, failed and overdue
  alerts. Failed scans retain the last completed scan's mismatch count. Local Prometheus/Grafana
  show alerts; there is no Alertmanager notification delivery.
- Runbook: `docs/runbooks/credit-ledger-audit.md`.

Testing: PGlite tests cover clean/lifecycle scans, conserved cross-wallet drift, deliberately
corrupted ledger in a disposable fixture, immutable findings, auth, contracts, restart metrics,
daily eligibility and failure retry. Real PostgreSQL tests cover advisory locks, four concurrent
replicas and snapshot consistency while an economic transaction commits. Promtool tests cover
mismatch/failure firing+recovery and the overdue grace period. Browser component tests cover empty,
MISMATCH and ERROR states. Final full Credit suite passed 128 tests and browser unit suite 367;
the follow-up audit suite passed 17 tests (including the three real-PostgreSQL tests). The full
cross-service suite passed 44 tests with real PostgreSQL/RabbitMQ. Root lint/format/typecheck,
contract compatibility and the production web build passed. On an isolated Compose stack, the
boot scan and CLI scan both recorded PASS/0, the complete smoke and credit lifecycle scripts
passed, and the real Operations browser journey passed at 360/768/1440px. The E2E test follows
the required seeded-admin password replacement on disposable stacks. A missing `read_only`
property in the existing Compose test interface was fixed to unblock whole-repository typecheck.

Remaining: PR, passing head CI,
actual non-author review, merge. User merge authorization is not a fabricated human review.

### #284 — backup, restore and rollback

Goal/acceptance: custom-format `pg_dump` for each of the four DBs, outside Docker volumes and with
no credentials in arguments/names; restore into fresh stack; all user/errand/wallet/ledger rows
restored, smoke + #283 pass; record timed destructive disposable drill against RTO 60 minutes;
start previous tagged published images healthy and smoke them; CI exercises backup/restore.

Expected implementation: `scripts-backup.sh`, `scripts-restore.sh`, operator instructions and a
dated report under `docs/reports/`, CI coverage. Use Compose env and role/database mapping from
`postgres-init.sh`; fresh isolated project/volumes for every destructive test. Never run the drill
against the existing developer/demo volumes. Do not put DB secrets in filenames or process argv.

RabbitMQ queues/messages are not included in PostgreSQL dumps. Document the exact outbox replay
boundary: a published row may already be acknowledged by the broker while consumer effects are
missing from a separately timed backup. Do not claim outbox alone guarantees recovery of every
published message across an arbitrary multi-DB restore. Coordinate a quiesced backup/restore or
provide explicit recovery evidence for the chosen boundary.

Rollback uses the previous release's published tag in `compose.images.yaml`. Verify registry
availability and migration compatibility. Additive migrations allow older binaries to use the
newer schema; do not silently downgrade schema/history. #283 is required by the restore command.
The issue names #164 as blocked-by, but #164 is now closed; artifact verification is still needed.

### #167 — seed, smoke and demo narrative

Goal/acceptance: one command creates meaningful deterministic requester, courier, second courier
and two admins plus suppliers/errands; health wait + loud smoke failure; repeatable clean-start
story; `docs/demo/d4-runbook.md` covers the full 30-minute demo, core and all selected nice-to-haves,
presenter/fallback for each and local-container deployment (#286); two non-owners finish rehearsals.

Reuse existing public API scripts and auth/bootstrap conventions. Keep D3 runbook unchanged. Use
stable fixture identifiers, safe rerun semantics and explicit isolated-demo assumptions. Read live
service contracts before designing seed calls. Do not embed tokens/passwords in tracked data.

Explicit gate #160 remains open; draft/seed work can proceed, but final acceptance needs its real
journeys and two recorded non-owner rehearsal results (#288 tracks dates). UNRESOLVED: who will
perform those rehearsals and on which release candidates. Do not mark rehearsals complete based
on an agent execution or invented approval.

### #238 — shared ADR acceptance

Goal/acceptance: required ADRs no longer Proposed and all five members recorded. Isaac's approval
already exists in `docs/adr/README.md` via merged #300. Zhang Yuan and Anselm are recorded. Main
still lists Jonus and Patrick Pending; Jonus's changes are in open #254. ADRs 0002–0009 remain
`Proposed; implementation basis`; 0010 is a newer proposed edge ADR.

Read #254's exact changes/reviews before any merge; never record another person's approval on
their behalf. After real approvals exist, update status/register consistently in a reviewed PR.
The obsolete #234 gate is satisfied: #234 closed, its PR #250 merged. No code tests are needed
solely for prose, but required repository checks/review still apply.

## 5. Recommended implementation order

1. Finish #283 validation and PR. It has no missing technical prerequisite and supplies #284's
   required financial restore check. Preserve actual review/CI gates.
2. Build #284 backup/restore scripts using the audit contract, then verify published rollback
   artifacts, run an isolated timed drill and add CI/runbooks/report. Base on merged #283 when
   possible; a dependent branch may be prepared while review runs, with its dependency explicit.
3. Prepare #167 seed and D4 narrative while #160/rehearsal coordination progresses. Complete only
   after the explicit gates are evidenced.
4. Finish shared #238 when teammate approvals/amendments are truly recorded; Isaac's part is done.

## 6. Shared technical decisions and constraints

- Closed economy: only issuance and approved Order events change balances. No admin balance edits,
  gifts, top-ups, cash-out or cross-service SQL. Manual audit is an operational write only.
- Exactly one local economic effect uses transactional inbox/outbox, conditional SQL and unique
  operation keys; transport remains at least once. Transfer/release are mutually exclusive.
- Each balance mutation commits its immutable transaction/ledger and reply outbox atomically.
- Live User identity/role is authoritative; browser role/IDs are not trusted. Audit summaries must
  not bypass the existing audited admin wallet-read path.
- Use shared platform `Db`, errors, auth, logging, metrics and migration conventions. Real
  PostgreSQL proves locks/snapshots; PGlite alone does not. Broker failure tests use real RabbitMQ.
- All timestamps/UTC scheduling use server/database time. Finding counts can count one fault in
  several checks; ERROR never means clean zero. No automatic financial repair.
- Read applicable AGENTS.md (web requires installed Next guides) before edits. Keep generated API
  types aligned with OpenAPI. Keep credentials in ignored, private env files and out of logs/PRs.
- Implementation is in an isolated worktree; primary `/Users/isaac/Developer/foc-app` stays on main.
  Disposable test volumes/ports must never be confused with the developer's demo stack.
- Do not fabricate human reviews, teammate ADR approvals or non-owner rehearsals. Definitions of
  Done require non-author review in addition to CI, docs and merge.

## 7. Progress tracker

```ini
[x] #234 — Credit D3 evidence — PR #250 merged; issue closed
[x] #238 personal part — Isaac approval recorded in merged PR #300
[ ] #238 team completion — Patrick pending; Jonus amendment/approval in open #254
[ ] #283 — Daily financial audit — local implementation and initial suites pass; final verification/PR/review/merge remain
[ ] #284 — Backup, restore and rollback — not started; #164 closed; #283 supplies validation
[ ] #167 — Seed and D4 demo — not started; #160 and two non-owner rehearsals remain gates
```

Before starting another issue, pull main, reread live issues/comments/linked PRs and update this
document. On merge, record PR/commit/check evidence, update the tracker and reassess dependencies.
Mark missing information UNRESOLVED. This Codex-assisted context summarizes repository evidence;
the team must validate it and disclose AI use according to course policy before assessed use.
