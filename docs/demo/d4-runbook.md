# D4 local demonstration — 30-minute rehearsal runbook (REL-01, #167)

Status: preparation, **not signed-off rehearsal evidence**. The complete browser release journeys
(#160) merged in #325: 42 cases at 360/768/1440 px passed twice from clean volumes, locally and in
CI run 40651088404. Two non-owners must actually execute this runbook and record their results
below before #167 closes. Chat is not implemented on the main snapshot used to prepare
this document; its owners must supply and rehearse that segment. Do not present planned work as live.
This runbook does not change the D3 runbook.

The permanent conservation evidence is `docs/reports/credit-conservation-2026-10-01.md`
(generated report and accompanying JSON); recovery evidence is
`docs/reports/2026-10-28-stack-recovery.md` after #284's merge. Open them from the repo's file
viewer or GitHub alongside the live browser tabs. The former reports 804 generated errands,
not 804 manually performed browser journeys.

## Start from zero

Prerequisites: Docker Desktop running; Git, Python 3 and npm installed; the current repository
checked out. All services run as **local Compose containers**, behind the edge (PLT-11 #286).
The dedicated project is `foc-d4-demo`; ports 14000–14009 leave the ordinary `foc` project alone.
`D4_PORT_BASE=15000` selects another contiguous ten ports if needed.

From the repository root:

```bash
./scripts-seed-demo.sh --fresh
./scripts-seed-demo.sh --check
python3 scripts-demo-tabs.py --print
python3 scripts-demo-tabs.py
```

`--fresh` explicitly deletes **only the named demo project's volumes**, starts a fresh full stack,
waits for readiness, creates the named data and checks the financial audit. It creates/completes
the ignored `.env` if needed. No production seed route, direct database balance edit or service
authentication bypass is added. All records go through the public APIs. `--up` starts/resumes and
seeds idempotently; it preserves existing story progress. Use `--fresh` before each clean rehearsal
because accepted/completed/expired errands cannot be rewound by rerunning a seed.

The tab helper opens five **separate Chrome profiles** on macOS; each has all its required tabs.
Sign each profile in with its corresponding private credential from
`.demo-state/foc-d4-demo/credentials.json`. That file is mode 600 and ignored; read it locally and
keep it off shared screens, commits and reports. The helper reads no passwords. On another OS,
`--print` lists every URL; open them in five distinct profiles/contexts, not five ordinary tabs
sharing one login. Tabs that opened before sign-in may redirect: after login, run the helper again
or reopen the printed URL in the same persona's profile.

| Profile | Fictional persona | Initial role and purpose |
| --- | --- | --- |
| Requester | Alyssa Tan, `d4.requester@<allowed-domain>` | student, REQUESTER preference |
| Courier | Ben Lim, `d4.courier@<allowed-domain>` | student, COURIER preference |
| Race courier | Chloe Ng, `d4.race.courier@<allowed-domain>` | independent second student/courier |
| Admin A | Dina Koh, `d4.admin.a@<allowed-domain>` | administrator; own replaced bootstrap password |
| Admin B | Evan Teo, `d4.admin.b@<allowed-domain>` | independent administrator for second approval |

The seed uses the first configured allowed email domain (normally `u.nus.edu`) and a local dev
mailbox. Each account has its own private generated password. The two admin accounts are created
by the existing bootstrap configuration and must replace that shared bootstrap password before
obtaining sessions. Their names are set through their own profile endpoint.

Pickup point: **Printer @ Com 2**, the course CSV's printing supplier next to LT19. The existing
Supplier Service seeds at least 30 suppliers; this command reads that catalogue instead of copying
or inventing suppliers. Attribution: `data/csv/supplier-seed-data.csv` is the CS3219
`CS3219-AY2627S1/FoC-Template` dataset; the team's additions are
`data/csv/supplier-seed-additions.csv` (see the Supplier README).

The private `.demo-state/foc-d4-demo/overview.json` lists all actual user/errand IDs and URLs.
Three OPEN errands start ready: SoC project prints → PGP (reward 2), cancellation example (reward 1),
and two-courier acceptance race (reward 1). They reserve four of Alyssa's issued credits. Let **A**
be the configured initial allocation, normally 10: Alyssa starts `A−4 available / 4 reserved`,
Ben and Chloe each `A / 0`. No allocation is hardcoded or topped up; even the supported minimum
allocation of 5 can fund this story plus one live 1-credit composer example.

## Operator tabs and commands

Before any operator command against this demo, select its context:

```bash
. ./.demo-state/foc-d4-demo/ports.sh
docker compose ps
open "http://localhost:${PROMETHEUS_PORT}/alerts"
open "http://localhost:${GRAFANA_PORT}"
open "http://localhost:${RABBITMQ_MANAGEMENT_PORT}"
```

Those three tabs are Prometheus alerts, Grafana and RabbitMQ management. Use the configured private
operator credentials from `.env` locally, never place them in a command argument or screenshot.
The exported ports also handle a non-default `D4_PORT_BASE`.
Use `docker compose start rabbitmq` to recover a deliberately stopped broker. Keep this terminal
in the repository root with the demo context selected.

## Timed script and expected observations

Presenter allocation follows the existing service/N2H ownership. Confirm the handoffs during the
two real rehearsals. Every segment below has a fallback; a fallback is disclosed evidence, not a
claim that a failed live action succeeded.

| Time | Presenter | Action and words to say | Evidence / fallback |
| --- | --- | --- | --- |
| 00:00–02:00 | Jonus | Show `docker compose ps`, `/edge/ready` and the architecture diagram. “The browser has one origin; User, Supplier, Order and Credit own separate databases. This demonstration is local containers.” | If not ready, show which dependency is named, recover it, rerun `--check`; do not start transactions on a failed preflight. |
| 02:00–05:00 | Anselm | Show Alyssa's profile, the dev activation flow and the private/role boundaries. “Activation creates the wallet through an event; the browser never sets a balance.” A new registration can use a clearly fictional extra address; the five core personas already exist. | If email is delayed, show the local mailbox and Credit's dead letters/audit evidence. Do not register repeatedly or display the passwords. |
| 05:00–08:00 | Patrick | Alyssa: Suppliers → search for Printer @ Com 2 → compose one additional request, reward **1**, delivery PGP House 7. Name it “D4 dispute example”. Review the available/reserved projection and submit. Keep its resulting detail tab open for the dispute segment. | If composer fails, preserve the refusal/trace and use the preseeded prints errand for the core flow. The composer is covered by the merged release suite (#160, `release-journeys.e2e.ts`); do not mark a live failure passed from a seed API call. |
| 08:00–13:00 | Zhang Yuan, Isaac | Ben and Chloe: open the preseeded **race** card in their separate feed tabs and both open Accept. Confirm Ben first, then Chloe's stale confirmation. Show one winner and the stale/refused loser. Ben withdraws before pickup; the same reward remains reserved while the errand returns OPEN. Separately, Ben accepts **prints**, records pickup, records delivery. Alyssa confirms receipt. Isaac shows both wallet ledgers. | If race timing is missed, use its recorded 409/domain-code response and the CI contention test. If a transition fails, refresh to get the current version; never force a backward status change. |
| 13:00–16:00 | Isaac, Zhang Yuan | Alyssa cancels the preseeded **cancel** errand before pickup; show release pending then CANCELLED and +1 available/−1 reserved. Cancel the reopened **race** errand too, releasing its 1. “Withdraw removed the courier; cancellation returned the reward. Credit applied each once.” | If asynchronous release is delayed, show the errand trace/outbox and wait for the actual reply. Restart only the named demo dependency; no SQL credit edits. |
| 16:00–20:00 | Jonus, Anselm, Zhang Yuan | Admin A opens Users, audit/activity and read-only Wallets. If demonstrating two-person role approval, Dina proposes ADMIN for **Chloe**, and Evan approves in his own session; neither approves a request about themselves. For the live dispute example from minute 5, Ben accepts/picks up/delivers; Alyssa reports non-receipt instead of confirming. Open Admin → Errands in both admin profiles, identify who it was actually referred to, and only that admin decides REQUESTER. Show the ordinary release completing. | If the extra composer errand is absent, disclose that the dispute segment is unavailable and use the linked real dispute test/recorded trace. Do not fake a referral, admin approval or second person's action. |
| 20:00–23:00 | Isaac, Jonus | On the disposable demo only, `docker compose stop rabbitmq`; show readiness/outbox evidence. Post another **1-credit** request if the wallet can cover it. It stays pending while its outbox cannot publish. `docker compose start rabbitmq`; wait for readiness and the same errand to open once. Show Order's reconciliation/trace and the wallet's single reservation. | If too slow, bring RabbitMQ back immediately and show the existing `scripts-demo-failures.sh` CI evidence for duplicate, crash and replay. Distinguish normal outbox retry from the pending-saga reconciler; do not claim every fast recovery was the scheduled job. |
| 23:00–25:00 | Isaac | Open the committed conservation report and current CI property/race test results. “N3.1 checks generated histories and real contention; N3.2 compares pending saga state with Credit's recorded operations and reissues the same idempotent command.” Run `npm run audit:credits` and show PASS/0 in Admin → Operations. | If the fresh audit fails, retain its run ID and investigate with the runbook. A failed audit is not zero mismatches; do not demonstrate corruption against this application DB. |
| 25:00–27:00 | Patrick, Zhang Yuan, Anselm | **GATED: N1.2 chat.** Once its owner PRs are merged, show the accepted errand's two-participant channel, live message/history, outsider refusal and terminal closure. Rehearse against the actual channel/API first. | As of this preparation snapshot there is no implemented chat service. Show its explicitly proposed design and mark the live segment blocked; this cannot count as a completed N2H demo or final #167 acceptance. |
| 27:00–29:00 | Jonus, Isaac | Show a green main CI run with all five images actually published. For recovery, show the genuine dated report/CI drill: four custom dumps, exact table fingerprints after fresh-volume restore, healthy prior-published-image rollback and measured RTO. | Do not destroy the live demo's volumes during this slot. Use `scripts-recovery-drill.sh` on its separate project in a prior rehearsal. If rollback is not proven, label that gap rather than showing a local retag as publication. |
| 29:00–30:00 | Jonus, Isaac | Return to readiness, wallets, errand history and Operations. Name any intentionally outstanding reservation from the broker segment. “No administrator edited a balance; all changes have a normal transaction and ledger history.” | Preserve any pending state/trace; give the instructor the actual remaining issue instead of claiming the books or workflow are clean. |

The completed prints payment changes Alyssa's total by −2 and Ben's by +2. Cancellation/release
does not change a wallet's total. All three students together retain `3 × A`; held/reserved credits
from any deliberately unfinished errand still count. The daily financial audit checks the complete
database, beyond these three displayed wallets. A live broker-outage example left OPEN legitimately
retains its reward in reserved; cancel it afterwards if a zero-reserved ending is desired.

## Reproduce the evidence and recover a failed rehearsal

```bash
# Keep the same demo instance / story progress:
./scripts-seed-demo.sh --up
./scripts-seed-demo.sh --check

# API/ledger proof against this selected demo context:
. ./.demo-state/foc-d4-demo/ports.sh
npm run audit:credits
docker compose logs --no-color --tail=80 order-service credit-service

# A genuinely clean rehearsal; this destroys only foc-d4-demo's data:
./scripts-seed-demo.sh --fresh

# Stop without deleting its data:
./scripts-seed-demo.sh --stop
```

`--check` proves named identities/roles, the printing pickup, the recorded errands and a clean
audit. It does not exercise every browser action. The full browser release suite (#160, merged in
#325) runs on its own disposable project, never this demo fixture:
`./scripts-e2e-release.sh --twice` from the repository root. It covers the composer, withdrawal and
cancellation, disputes, suspension/reassignment, controlled-clock expiry/auto-confirmation and the
admin console; see the [web README](../../web-app/README.md#full-release-suite-tst-02-160). CI
runs it once on each pull request, and twice from clean volumes on every push to `main`. Preserve traces/screenshots on failure and record run links.

For a 429 during repeated practice, respect Retry-After and stop creating extra accounts. For
401/403, use the correct persona's own profile and current session; do not copy a token between
actors. If a seed was interrupted during activation and the dev mailbox was lost on restart,
use `--fresh` on this disposable project. If a deadline expired while preparing, use `--fresh`;
the seed does not reset a persisted deadline or undo a terminal transition.

## Rehearsal acceptance — actual non-owners only

| Run | Non-owner | Commit / clean seed | Date / duration | Result and evidence |
| --- | --- | --- | --- | --- |
| RC1 | UNRESOLVED | UNRESOLVED | UNRESOLVED | Pending actual rehearsal |
| RC2 | UNRESOLVED | UNRESOLVED | UNRESOLVED | Pending actual rehearsal |

Record who actually performed the steps, the commit and clean-start command, which segments ran
live, the timed result, failures/fallbacks and evidence links. An agent run, CI personas or an
owner's solo rehearsal are not two non-owner rehearsals. #160 is closed (#325); #167 stays open until
the missing live feature segment (chat) and both real rehearsals are satisfied. #288 coordinates the release-candidate
schedule; do not replace its dates or invent sign-offs here.
