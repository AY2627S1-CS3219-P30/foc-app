# Project and PR context for Isaac

Living context for `isaacchua0309` in `AY2627S1-CS3219-P30/foc-app`.
Refreshed 2026-10-29 against `origin/main` `ff65acc` and live GitHub. Recheck GitHub before starting
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

Two assigned issues remain open: #167 and #238. #283 and #284 are merged and closed.
PR #313 merged the financial audit at `0f938fa`; PR #314 merged recovery at
`e5da74ae4fac5e9cf17483d3e7f687ac1fdc1a84`. Required CI passed on each feature head. Recovery CI
run `40631924720` proves the full restore and actual published-image rollback (105 seconds).
The owner explicitly authorized internal review/merge; no teammate approval is claimed.
#167 preparation merged in PR #322 at `462257fdd043f1fa3fda36a180789d170215242b`: an isolated named-persona seed,
private credentials, all browser-profile tabs and a 30-minute runbook. Local seed/check/rerun,
credential/target guards and 34 page visits in five authenticated browser contexts passed; the
required Compose CI job passed the named seed/check/rerun in run `40637011479` on feature head
`5d2d545f1a8c77ad89162526fe27e5ae19fefba1`. #160 is now closed via #325. Remaining gates are
missing live chat implementation and two actual non-owner rehearsals. #238: Patrick's approval is recorded in #337.

| Issue                                                             | Feature / classification                                        | Status                                                               | Dependencies                                                            | Blockers                                                                                     | Relevant code                                                                                                                                      |
| ----------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#283](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/283) | CRD-10 financial audit; foundation                              | CLOSED; PR #313 merged, exact-head CI green                          | #166 related, not a prerequisite; contributes a runbook to #168         | Merged under owner-authorized internal review                                                | `credit-service/src/credits/ledger-audit.*`, `invariants.ts`, `web-app/src/app/(app)/admin/operations/LedgerAudit.tsx`, `observability/alerts.yml` |
| [#284](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/284) | PLT-09 stack backup/restore/rollback; integration               | CLOSED; PR #314 merged; full recovery/rollback CI PASS               | #164 publisher resolved by #315; #283 merged                            | None for implementation; daily/off-host backup operation remains a deployment responsibility | `scripts-{backup,restore,rollback,recovery-drill}.sh`, `scripts-recovery.py`, recovery runbook/report, CI                                          |
| [#167](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/167) | REL-01 deterministic seed, smoke and D4 narrative; finalization | Preparation merged in #322; required CI green; acceptance pending    | TST-02 #160 satisfied (closed via #325)                                 | Live chat segment and two successful non-owner rehearsals remain                             | `scripts-seed-demo.{sh,py}`, `scripts-demo-tabs.py`, `docs/demo/d4-runbook.md`, `test-harness/test/demo-seed.test.ts`                              |
| [#238](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/238) | DOC-04 ADR acceptance; team gate                                | Patrick/Jonus confirmations recorded in #337; partial ADR acceptance | Related #183/#226 satisfied; amendments in #250 (merged), #254 (merged) | Zhang Yuan confirmation of 0009 and #250's 0007 amendment remains missing                    | `docs/adr/README.md`, ADRs 0002–0009                                                                                                               |

#167's original owner line still says Patrick; its D4 amendment and GitHub assignment supersede
that line. #284's body still says no published images exist; #164 is now closed, so verify actual
registry artifacts rather than repeating that historical claim. #283's issue describes financial
checks as test-only; main now includes the runtime audit through merged #313.

## 3. Dependency graph

```text
#164 image publishing [closed; published images verified in recovery CI]
  └── #284 backup / restore / previous-image rollback [closed; #314]
        ├── #168 restore runbook [Jonus]
        └── #169 rollback rehearsal [team]

#283 daily wallet-versus-ledger audit [closed; #313]
  ├── #284 restore validates this audit after restoring all four databases
  └── #168 financial reconciliation runbook contribution

#160 browser journeys [closed; merged PR #325]
  └── #167 final acceptance + two non-owner rehearsals
       (seed, tabs and narrative merged in #322; live chat also remains gated)

#281 participant dispute outcome/reason [closed; merged PR #324]
  └── #160 complete dispute journey (its D4 audit explicitly requires WEB-06)

#145 / #157 / #158 [closed]
  └── #160 listed prerequisites and core release journeys are complete

#238 shared ADR acceptance
  ├── Isaac approval [merged #300]
  ├── Anselm approval [recorded on main]
  ├── Zhang Yuan: 0002–0008 recorded; 0009 and #250 amendment confirmation pending
  ├── Jonus amendment/approval [merged #254]
  └── Patrick approval [recorded in #337]
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

Implementation merged on main:

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

Completed: PR #313 merged after exact-head green CI and internal review under the owner's explicit
merge authorization. No teammate approval was fabricated. Merge commit is `0f938fa`; issue #283 is closed.

### #284 — backup, restore and rollback

Goal/acceptance: custom-format `pg_dump` for each of the four DBs, outside Docker volumes and with
no credentials in arguments/names; restore into fresh stack; all user/errand/wallet/ledger rows
restored, smoke + #283 pass; record timed destructive disposable drill against RTO 60 minutes;
start previous tagged published images healthy and smoke them; CI exercises backup/restore.

Merged implementation: `scripts-backup.sh`, `scripts-restore.sh`, operator instructions and a
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
The issue names #164 as blocked-by; #164 is closed and #284's CI verified actual published artifacts.

Merged implementation: backup stops ingress, drains broker queues and the three existing
outboxes (Supplier has none), stops writers and rechecks before four custom-format dumps. Private
manifests include checksums and every table's row/content SHA-256. Restore refuses running apps,
non-empty DBs or pending target broker messages; imports as each owning role; compares exact data
before startup; then smokes and invokes #283. It never overwrites a non-empty database. The drill
creates a unique disposable project before any `down -v`. CI runs backup/restore and uploads only
its summary. Rollback requires immutable published tags and an explicit compatibility review,
retains volumes and smokes the old images. See `docs/runbooks/backup-restore-rollback.md` and
`docs/reports/2026-10-27-stack-recovery.md`.

Historical local evidence: 36 tables / 321 rows restored with matching canonical-row fingerprints,
health + complete smoke + PASS/0 financial audit, measured 71 seconds against 3600-second RTO.
A normal backup also resumes previously running apps. Bundle tests reject corruption, missing
databases, wrong format and symlinked dumps. The repeatable isolated drill also passed (55 seconds), as did the non-empty-target refusal.
Completed on 28 October in merged PR #314. Exact feature-head CI run `40631924720` passed;
its integration merge ref `ef640a9` produced the inspected recovery artifact: exact fingerprints,
smoke and financial audit PASS; **105-second restore**; actual registry rollback PASS to
`sha-3560f4d7da1e647617d9b3d3d6113122e7e9c7ee`. See
`docs/reports/2026-10-28-stack-recovery.md` for the permanent evidence and limits.

Release blocker resolved on 28 October: Jonus's merged #315 (`f2d3d41`) fixes skipped publishing
and removes comments from Bake's literal `set` arguments. Main run `40493541331`, commit
`3560f4d7da1e647617d9b3d3d6113122e7e9c7ee`, completed Publish images successfully: all five images
were built, scanned and pushed. The earlier #314 CI failed solely because no published release
existed at that time. The merged recovery CI subsequently proved the real rollback to that release.
The workstation token still lacks `read:packages`; CI's scoped package-read token supplies access.
The redundant, uncommitted `work/publisher-fix` experiment is superseded by #315; do not publish it.

### #167 — seed, smoke and demo narrative

Goal/acceptance: one command creates meaningful deterministic requester, courier, second courier
and two admins plus suppliers/errands; health wait + loud smoke failure; repeatable clean-start
story; `docs/demo/d4-runbook.md` covers the full 30-minute demo, core and all selected nice-to-haves,
presenter/fallback for each and local-container deployment (#286); two non-owners finish rehearsals.

`scripts-seed-demo.sh --fresh` creates only the dedicated `foc-d4-demo` project on ports
14000–14009, using a development mailbox and public User/Supplier/Order/Credit APIs. It creates
Alyssa/Ben/Chloe as requester/two couriers and Dina/Evan as independently credentialed admins;
bootstrap passwords must be replaced through the normal endpoint. It references the actual
Printer @ Com 2 course CSV supplier and three stable idempotency keys. Total initial reservations
are 4 credits, within the minimum allocation of 5. `--check` verifies the named state and audit;
`--up` preserves identities/errands on rerun. Private credentials are atomically written mode 600.
`scripts-demo-tabs.py` opens five isolated Chrome profiles with all route tabs on macOS, or prints
the complete list cross-platform. `docs/demo/d4-runbook.md` has the 30-minute service/N2H handoffs,
commands, expected credit movements, fallback per segment and two explicitly pending human rows.
Five guard tests and actual local seeded-stack checks passed; 34 authenticated page visits passed.
PR #322 merged at `462257fdd043f1fa3fda36a180789d170215242b` on 28 October. Required
[CI run 40637011479](https://github.com/AY2627S1-CS3219-P30/foc-app/actions/runs/40637011479)
passed on final feature head `5d2d545f1a8c77ad89162526fe27e5ae19fefba1`. Its Compose job
`122646527466` passed **Seed and smoke the named D4 demo twice**: fresh seed, check, rerun,
stable five persona/three OPEN errand IDs and mode-600 credentials. Tests also cover a valid
zero-credit existing wallet, domain normalization, private state excluded from image contexts,
target guards and invalid arguments. The existing browser job passed; it is not evidence that
all journeys requested by #160 exist. No non-author human review is claimed for #322.
These checks do not prove #160 or count as two non-owner rehearsals.

Reuse existing public API scripts and auth/bootstrap conventions. Keep D3 runbook unchanged. Use
stable fixture identifiers, safe rerun semantics and explicit isolated-demo assumptions. Read live
service contracts before designing seed calls. Do not embed tokens/passwords in tracked data.

Explicit gate #160 is satisfied by merged #325. Final #167 acceptance still needs the live chat
segment and two recorded non-owner rehearsal results (#288 tracks dates). UNRESOLVED: who will
perform those rehearsals and on which release candidates. Do not mark rehearsals complete based
on an agent execution or invented approval.

### #238 — shared ADR acceptance

Goal/acceptance: required ADRs no longer Proposed and all five members' approval scope recorded.
Isaac and Anselm explicitly cover 0002–0009 and the #254/#250 amendments. Patrick supplied his
own confirmation in #337. Jonus explicitly expanded his approval in his #337 review and requested
a register date of 2026-10-29. Zhang Yuan's older #246 confirmation covers 0002–0008; his confirmation
of 0009 and the later #250 amendment to 0007 is still missing, as Jonus and Anselm both noted.

#337 records the actual confirmations and accepts 0002–0006/0008. It leaves 0007/0009 Proposed and
keeps #238 open. ADRs 0010/0011 remain Proposed under their separate review. Do not equate five
nonempty register rows with five approvals of every later amendment.
Read #254's exact changes/reviews before any merge; never record another person's approval on
their behalf. After real approvals exist, update status/register consistently in a reviewed PR.
The obsolete #234 gate is satisfied: #234 closed, its PR #250 merged. No code tests are needed
solely for prose, but required repository checks/review still apply.

## 5. Recommended implementation order

1. #283 is complete via merged #313. Its financial audit supplies #284's restore check.
2. #284 is complete via merged #314: backup/restore/rollback, CI and runbooks/report are proven.
3. #167 preparation is merged via #322. Complete the remaining release acceptance only after
   live feature segments and both actual non-owner rehearsals are evidenced; #160 is satisfied.
4. Merge the supported approval records in #337, then finish shared #238 only after Zhang Yuan
   confirms ADR 0009 and the #250 amendment to 0007 and their status lines are updated.

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
- Do not fabricate human reviews, teammate ADR approvals or non-owner rehearsals. Issue Definitions of Done request non-author review; the owner explicitly authorized internal
  review/merge for this goal. Record that exception honestly; it is not a teammate approval.

## 7. Progress tracker

```ini
[x] #234 — Credit D3 evidence — PR #250 merged; issue closed
[x] #238 personal part — Isaac approval recorded in merged PR #300
[ ] #238 team completion — Patrick/Jonus confirmations in #337; Zhang Yuan 0009/#250 confirmation pending
[x] #283 — Daily financial audit — PR #313 merged at 0f938fa; issue closed; exact-head CI green
[x] #284 — PR #314 merged at e5da74a; issue closed; exact-head CI proves 105-second restore and published-image rollback
[x] #167 preparation — Seed/tabs/runbook merged in #322 at 462257f; exact-head CI 40637011479 passed
[x] #281 blocker — PR #324 merged; issue closed; required and main CI passed
[x] #160 blocker — PR #325 merged at 2f00a92; 42 cases × 2 clean runs passed locally and in CI run 40651088404; issue closed
[ ] #167 acceptance — live chat (#161–#163) and two actual non-owner rehearsals remain gates
```

Before starting another issue, pull main, reread live issues/comments/linked PRs and update this
document. On merge, record PR/commit/check evidence, update the tracker and reassess dependencies.
Mark missing information UNRESOLVED. This Codex-assisted context summarizes repository evidence;
the team must validate it and disclose AI use according to course policy before assessed use.

## Goal blockers and handoff

- #283 and #284 are merged/closed with passing required CI and real runtime evidence. The release
  publisher blocker was resolved by Jonus's #315; #284 pulled actual published images in CI.
- #167 preparation is merged in #322 with passing CI. `scripts-seed-demo.sh --fresh` starts its own
  `foc-d4-demo` on ports 14000–14009, creates five named personas/three errands through public APIs,
  and checks the audit. Initial seed, check and idempotent rerun passed locally; credentials are
  mode 600. Its tab helper opens five isolated browser profiles. These are agent checks, not human
  rehearsals. Do not count them as either non-owner rehearsal.
- #160 is closed via #325: the full core release suite passed twice locally and in CI. #167's live
  chat segment still needs implementation. Two real non-owner rehearsals remain unrecorded.
  A follow-up fixes the offline test's ambiguous retry selector found on the merged-main run;
  details and evidence are recorded below.
- #238: Patrick's approval is recorded in #337. #254 merged with Anselm's recorded review and
  code-checked amendments; no teammate approval was invented.

### Technical blocker work — 28 October

The earlier conclusion that no independent technical action remained was too broad. The user
authorized resolving blockers as well as assigned work. #160 is assigned to Patrick, but all
three of its listed prerequisites (#145 TST-01, #157 WEB-02, #158 WEB-03) are CLOSED. Its D4 audit
explicitly requires #281's student dispute outcome, now merged in PR #324. These are
blocker tickets, not additional issues assigned to Isaac.

- #281 is CLOSED; PR #324 merged at `10d9511fe7ac98d14873d22d378e01260cae8b91`.
  Feature-head CI `40644294001` and merged-main pipeline `40646974317` both passed, including
  publishing all five images. Participant outcome/reason, private history, late-response protection,
  both decisions and outsider denial are verified by unit tests and 18 real browser cases.
- `test/160-release-journeys` merged in #325 at `2f00a92`; #160 is CLOSED. Both local and CI
  `40651088404` runs passed all 42 cases twice at 360/768/1440 px, without retries/skips/errors.
  The required smoke/release matrix and retained artifacts are on main.
  `scripts-e2e-release.sh`, `compose.e2e.yaml`,
  `test-harness/e2e-clock.mjs`, `web-app/e2e/release-journeys.e2e.ts` and
  `web-app/e2e/zz-release-clock.e2e.ts` provide the runner and coverage.
- The clock fixture is mounted only in the explicit disposable release configuration; it advances
  the four backends' implicit Node clock and explicit PostgreSQL clock reads. It never edits an
  errand, wallet, ledger or history row. Tests reauthenticate normally after jumps, then observe
  actual lifecycle workers and asynchronous credit settlement. Ordinary smoke retains auth limits.
- #160's explicit implemented-path acceptance does not require a nonexistent chat implementation.
  #161 assigns its future chat browser journey to the TST-02 suite; that is an integration follow-up,
  not an inferred prerequisite for the current core journeys. #167's live chat demo remains gated
  independently. Withdrawal retains reserved credits for reassignment; cancellation releases them,
  clarifying the audit checklist rather than changing production semantics.
- The two real non-owner rehearsals and Zhang Yuan’s outstanding ADR confirmation remain external gates. An agent
  may complete technical blocker code but cannot supply those people's participation or decisions.

### Completion audit — 28 October, after #325 and #326

| Requirement                                                                                                     | Authoritative evidence                                                                                       | Result / next action                                                |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| #283 runtime financial audit, tests, operator instructions and merge/closure                                    | Merged #313, closed #283, required CI and runtime evidence above                                             | Complete                                                            |
| #284 four-database restore, exact data, audit, timed RTO and real published-image rollback                      | Merged #314, closed #284, CI `40631924720`, `docs/reports/2026-10-28-stack-recovery.md`                      | Complete                                                            |
| #167 deterministic named personas, suppliers/errands, preflight, runbook, browser tabs and preparation pipeline | Merged #322; CI `40637011479`, Compose job `122646527466`; source paths above                                | Preparation complete; issue remains open                            |
| #167 explicit TST-02 dependency                                                                                 | Closed #160, merged #325; downloaded CI `40651088404` artifacts: 42 passed twice, zero failures/flakes/skips | Complete; maintain the release suite and investigate later failures |
| #167 all live feature segments and two non-owner rehearsals                                                     | `docs/demo/d4-runbook.md` marks chat gated and both rehearsal rows Pending; #161 remains OPEN                | Incomplete; real owner implementation and rehearsal evidence needed |
| #238 all five approvals and Accepted ADRs                                                                       | `docs/adr/README.md` in #337: actual scopes recorded; 0007/0009 remain Proposed                              | Incomplete until Zhang Yuan confirms 0009 and the #250 amendment    |

Live GitHub shows two assigned open issues (#167, #238), no assigned open PRs; Isaac-authored #328 remains an open handoff/context PR. Completed implementation has been merged and its completed issues closed.
The full goal remains incomplete because the two assigned issues still have the specific external
acceptance gates above. Do not close them or treat agent/CI execution as a teammate decision.

## Status 2026-10-28 (after #325)

- #160 is CLOSED: PR #325 merged at `2f00a92`. Both the local and CI (`40651088404`) release reports
  show 42/42 passed twice from clean volumes with zero failures, flakes, skips or runner errors.
- #167's own scope is merged (seed, smoke, runbook, deployment mode). Remaining gates: the live chat
  segment, which needs #161–#163, and two real non-owner rehearsals.
- Chat (#161 Patrick, #162 Zhang Yuan, #163 Anselm) is each owner's graded nice-to-have; the design
  points in `docs/nice-to-haves.md` (separate service or Order module, transport, retention, rate
  limit) are theirs to settle according to merged #326. In this Codex thread Isaac explicitly
  chose **90 days after the errand ends**; this records his direction, not the other owners' approval.
  #326 says not to implement their slices under Isaac's name without owners' agreement. An
  asynchronous scope question asks Isaac to resolve that new note against his earlier instruction
  to complete all technical blockers. No chat implementation or teammate agreement is claimed.
- #238: Patrick's approval is recorded in #337.

### Release CI follow-up — ambiguous offline retry selector

Main run `40655470485` (merge `2f00a92`) failed the tablet reconnect journey: a failed wallet read
and failed request post both legitimately displayed “Try again”, so the unscoped Playwright locator
matched two buttons. The following main run `40655751822` (`6ef37ca`) passed the full release suite
and published all five images, but a later pass does not repair the ambiguous selector.

`fix/160-offline-retry-locator` scopes retry to the posting actions beside “Edit details” and
deliberately fails the browser wallet read in the offline step so both controls are always present.
It preserves the assertions that reconnect creates exactly one errand and reserves its reward once.
PR #327 merged at `22d7eba2045e572a1a177dc04816c959461a3121`. Local runs and required CI
`40689622039` each passed 42 cases twice with zero failures/flakes/skips/runner errors. This is
historical evidence for that commit; newer main adds live-update journeys. Latest checked main
`ff65acc` passed pipeline `40819818381`, including Publish images.

### Chat owner work — 29 October

The owners now track design/contract #344 in Patrick's open PR #347. It selects a fifth service,
live Order lookup on every request, polling first, 90-day retention, 20 messages/minute, 280 Unicode
code points, current-participant access with full history for a replacement courier, and read-only
admin access. #345 adds fifth-service deployment/recovery wiring; #161/#162/#163 build their slices;
#346 is a later notify-only WebSocket enhancement. Do not merge the obsolete WebSocket-first/event-
projection handoff as if it were the owners' agreed design. #347 still has review points and is not
an implemented chat service. #167 remains gated on the actual live chat feature and two rehearsals.
