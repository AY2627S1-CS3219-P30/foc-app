# D4 demonstration: 17-minute rehearsal runbook (REL-01, #167)

Status: preparation, **not signed-off rehearsal evidence**. The 30-minute slot is about 12 minutes
of slides, 17 of this demo and 1 spare, followed by 10 minutes of questions. The deck hands over to
this demo after its Deployment slide and comes back for the decisions. The complete browser release
journeys (#160) merged in #325: 42 cases at 360/768/1440 px passed twice from clean volumes, locally
and in CI run 40651088404. Two non-owners must actually execute this runbook and record their
results below before #167 closes.

A script walked the story below once in a browser, on a fresh local seed of commit `fa392df`
(5 Nov), to check its errands, chat, dispute, role approval, broker stop and audit. It runs far
faster than a person, so it says nothing about timing, and it is not a rehearsal. Do not present
planned work as live. The demo runs on the AWS deployment (next section); the local stack is the
fallback. Chat's notify-only WebSocket is live: the panel holds it from #399 on, so `rc3-d4` and
`v1.0-d4` have it and `rc2-d4` does not. This runbook does not change the D3 runbook.

The permanent conservation evidence is `docs/reports/credit-conservation-2026-10-01.md`
(generated report and accompanying JSON); recovery evidence is
`docs/reports/2026-10-28-stack-recovery.md` after #284's merge. Open them from the repo's file
viewer or GitHub alongside the live browser tabs. The former reports 804 generated errands,
not 804 manually performed browser journeys. N1.4 live updates merged on 29 October; their
measured evidence is `docs/reports/load-2026-10-29.md`. Its 492 ms p95 measures accept response
to the requester stream's nudge under 200 open streams, not end-to-end browser rendering, which
isn't measured. Page-load and input figures are in
`docs/reports/accessibility-and-web-vitals-2026-11-03.md`.

## The demo runs on AWS

The demo uses the deployment at https://foc.anselmlong.com (PLT-14, #357), running `v1.0-d4`.
Open with “This is the deployed system at foc.anselmlong.com, running release v1.0-d4”: the D4
brief asks the team to declare which mode it demonstrates. Every browser, on any computer, uses that
one address. If the site fails on the day, switch to the local fallback below and say so.

### Freeze the site on `v1.0-d4`

Auto-deploy is on (`AWS_AUTO_DEPLOY`), so every merge to `main` redeploys the site. As soon as
`v1.0-d4` is tagged, turn it off and deploy the tag by hand:

```bash
gh variable set AWS_AUTO_DEPLOY --body false --repo AY2627S1-CS3219-P30/foc-app
gh workflow run deploy.yml -f tag=v1.0-d4 --repo AY2627S1-CS3219-P30/foc-app
```

If the site already runs the tag's commit, the deploy reports that it already includes it and
changes nothing. That is still the release: a release retags the same images. On the host, the
last line of `~/foc-app/.deploy-history` names the commit that is running.
[Deploying to AWS](../runbooks/aws-deploy.md) covers deploys and rollback.

### Accounts: real people, not the seed

`scripts-seed-demo.sh` refuses any address but a local one and reads activation links from the
local Mailpit, so nothing is seeded on AWS. As locally, every record goes through the site: Patrick
posts the three ready errands from Patrick's own account (“Before the timer”). We use our own NUS
emails: three of us play the students under our own names, Isaac does the live sign-up, and the two
admins need no inbox. The script below names people this way; locally, the seed's fictional
personas stand in for them.

| Role | Account | How it is made |
| --- | --- | --- |
| Requester | Patrick's own NUS email | registers at `/register` and activates from the email, before the demo |
| Courier | Zhang Yuan's own NUS email | the same |
| Race courier | Jonus's own NUS email | the same |
| Admin A, “Dina Koh” | `foc.demo.dina@u.nus.edu`, made up | Anselm, on the server (below) |
| Admin B, “Evan Teo” | `foc.demo.evan@u.nus.edu`, made up | Anselm, on the server |
| The 00:00 sign-up | Isaac's own NUS email | nothing: Isaac doesn't sign up before the demo |

**Students need real inboxes.** A student's password is set only through the emailed activation
link (#309), and the database keeps no copy of the link. Don't work around that on the live server,
for example by pointing its mail at Mailpit: anyone else signing up meanwhile would get no email.

**Admins need no inbox.** When the User Service starts, it creates the administrators listed in
`ADMIN_SEED_EMAILS`, in the host's `.env`. They are active at once, with the bootstrap password
(`ADMIN_SEED_PASSWORD`, in the same file), and no email is sent. The site only ever emails
activation and password-reset links, so made-up addresses are safe as long as nobody presses
**Forgot password** on them. The seed skips an address that already has an account and never
promotes it. Once, before the rehearsal, Anselm:

1. Adds both addresses to `ADMIN_SEED_EMAILS` (comma-separated, after any already there) and
   recreates the User Service on the host (“Operator access on AWS” below):

   ```bash
   docker compose up -d --no-build user-service
   ```

2. Signs in to each at `/login` with the bootstrap password, sets a new password when the site asks,
   and sets the display name in **Profile**.
3. Gives each new password privately to whoever plays that admin.

**The 00:00 sign-up** uses Isaac's own NUS email. Never type a made-up address there: that email
really goes out, and bounces count against the site's mail sender. An address registers only once,
so Isaac's stays unused until the demo. Rehearse that step with a plus address on another inbox, such as
`e0123456+rehearse1@u.nus.edu`, if NUS delivers it to `e0123456`'s inbox; otherwise rehearse it on
the local stack. In the first rehearsal, check that the email's link opens
`https://foc.anselmlong.com/activate`. If it opens `localhost`, the host's Compose override doesn't
set the User Service's `ACTIVATION_URL`. `compose.yaml` points it at `localhost`, and `.env`
can't change that.

**Credits.** A new student starts with the host's initial allocation, 10 by default, and nothing
else. One full run moves 2 of Patrick's credits to Zhang Yuan, and the broker example stays reserved
until it is cancelled. Patrick needs at least 5 available at the start, which is enough for about
three full runs. If Patrick runs short, Zhang Yuan posts an errand for Patrick to deliver. Never edit
a balance.

**Rehearsals don't reset.** In a rehearsal, Evan presses **Reject** at 11:30 instead of Approve, so
Jonus is still a student for the demo. Errands that were used up are posted again.

### Before the timer

About 30 minutes before the slot:

1. Run the demo from one presenting laptop, with one Chrome profile per account (profile icon →
   **Add**) at `https://foc.anselmlong.com/login`. Each owner signs in to their own profile on that
   laptop beforehand, typing their own password; nobody shares a password or a session. Presenters
   take turns at the keyboard. The side-by-side steps (01:30, 03:30, 04:30 and 05:00) need both
   windows on the screen the graders watch, which one laptop guarantees. If the demo is presented
   over a call instead, both people in each side-by-side step share their screens.
2. Zhang Yuan and Jonus pick **Courier** in the menu's switch, as the local seed does. It only changes
   their lists.
3. Note each student's available and reserved credits on **Wallet**, because rehearsals change them
   (“Credits” above). Patrick needs at least 5 available.
4. Patrick posts the three ready errands in the composer: pickup **Printer @ Com 2**, zone
   **PGP House 7**, instructions “Meet at the PGP House 7 lobby counter.” They are “CS3219 project
   prints from SoC to PGP” (reward 2), “Project reading notes — cancellation example” (reward 1)
   and “Project poster — two couriers, one acceptance” (reward 1). An errand stays open for an hour
   (`ORDER_ACCEPTANCE_WINDOW_MS`), so post them no earlier than 30 minutes before the slot. If one
   expires, post it again.
5. `curl -s https://foc.anselmlong.com/edge/ready` answers `"status":"ok"` with nothing in `down`.

### Operator access on AWS

Only the web app is public. There is no Mailpit, because SES sends the activation emails.
Prometheus, Grafana and RabbitMQ management listen only on the host. A shell on the host comes from
the AWS console: EC2 → the instance → **Connect** → **Session Manager**. It needs no SSH key and no
open port 22. Then:

```bash
sudo -iu ubuntu
cd ~/foc-app
docker compose config --images | sort -u | grep -c ghcr.io
```

The last line should print 6, one per application image. Each `*-migrate` service reuses its
service's image, so without `sort -u` it would print 11. If it prints 0, the host's `.env` doesn't
name the Compose files. Then prefix each `docker compose` command with
`COMPOSE_FILE=compose.yaml:compose.images.yaml`, adding `:compose.aws.yaml` if that file exists,
which is what the deploy uses. `--no-build` makes a mistake fail instead of building on the host.

Anselm has this access and runs the broker step at 13:00 while Isaac and Jonus narrate. Session
Manager is a shell in the browser, so open it before the slot, run `sudo -iu ubuntu` and
`cd ~/foc-app`, and keep that tab ready. The
Prometheus, Grafana and RabbitMQ tabs are for questions only. To show one, forward its port to your
laptop. Grafana, for example, needs the AWS CLI and its Session Manager plugin:

```bash
aws ssm start-session --target <instance id> --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3005"],"localPortNumber":["3005"]}'
```

Then open `http://localhost:3005`. That is also where the admin console's Grafana link points, so
it works while the forward is open. The port is `GRAFANA_PORT` in the host's `.env`, 3005 by
default. The report and CI tabs, the last four `open` lines under “Operator tabs and commands”, work
from anywhere.

## Local fallback: start from zero

Use this if the AWS site fails on the day, and say that the demo has moved to local containers. It
is also the quickest clean rehearsal of everything except the AWS steps.

Prerequisites: Docker Desktop running; Git, Python 3 and npm installed; the current repository
checked out. All services run as **local Compose containers**, behind the edge (PLT-11 #286).
The dedicated project is `foc-d4-demo`; ports 14000–14011 leave the ordinary `foc` project alone.
`D4_PORT_BASE=15000` selects another contiguous twelve ports if needed.

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
because accepted/completed/expired errands cannot be rewound by rerunning a seed. An `.env` older
than the Chat Service lacks its key in `INTERNAL_SERVICE_KEYS`, and chat then answers “Could not
verify your identity”; `./scripts-init-env.sh`, which `--fresh` runs, adds it (#384).

That builds your checkout. To rehearse a release, start from a checkout of its tag and name it:

```bash
git checkout rc3-d4
FOC_IMAGE_TAG=rc3-d4 ./scripts-seed-demo.sh --fresh
```

Rehearse on the newest release candidate. The demo itself runs `v1.0-d4`, tagged on Tue 10 Nov.

It runs that release's images, which CI built and scanned, and builds nothing. It pulls them before
deleting anything, so a tag it cannot pull leaves the demo as it was. It prints `Demo images: rc3-d4`,
and with the demo context selected, `docker compose images` shows that tag on every application
image. The stack stays on those images: later commands need no tag, `--fresh` included.
`FOC_IMAGE_TAG= ./scripts-seed-demo.sh --fresh` goes back to building your checkout.

The images are the release's, but two things are still the demo's own. The services run with
`NODE_ENV=development`, because the seed refuses anything else. And the admin console's Grafana link
goes to `localhost:3005`, built into the image, rather than this demo's port: use the Grafana tab
below instead.

The tab helper opens five **separate Chrome profiles** on macOS; each has all its required tabs.
Sign each profile in with its corresponding private credential from
`.demo-state/foc-d4-demo/credentials.json`. That file is mode 600 and ignored; read it locally and
keep it off shared screens, commits and reports. The helper reads no passwords. On another OS,
`--print` lists every URL; open them in five distinct profiles/contexts, not five ordinary tabs
sharing one login. Tabs that opened before sign-in may redirect: after login, run the helper again
or reopen the printed URL in the same persona's profile.

On AWS these roles are played by the team's own accounts (“Accounts” above): Patrick is the
requester, Zhang Yuan the courier and Jonus the race courier. The timed script uses those names, so
locally read Alyssa Tan for Patrick, Ben Lim for Zhang Yuan and Chloe Ng for Jonus.

| Profile | Fictional persona | Initial role and purpose |
| --- | --- | --- |
| Requester | Alyssa Tan, `d4.requester@<allowed-domain>` | student, REQUESTER preference |
| Courier | Ben Lim, `d4.courier@<allowed-domain>` | student, COURIER preference |
| Race courier | Chloe Ng, `d4.race.courier@<allowed-domain>` | independent second student/courier |
| Admin A | Dina Koh, `d4.admin.a@<allowed-domain>` | administrator; own replaced bootstrap password |
| Admin B | Evan Teo, `d4.admin.b@<allowed-domain>` | independent administrator for second approval |

The seed uses the first configured allowed email domain (normally `u.nus.edu`) and the demo
project's Mailpit inbox. It waits for each activation email and follows its token through the
normal activation endpoint, which is where each account's password is set (#309); it never reads
a token from the User database. Each account has its own private generated password. The two admin accounts are created by the existing bootstrap
configuration and must replace that shared bootstrap password before obtaining sessions. Their
names are set through their own profile endpoint.

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

These are for the local stack; on AWS, see “Operator access on AWS”. Before any operator command
against the local demo, select its context:

```bash
. ./.demo-state/foc-d4-demo/ports.sh
docker compose ps
open "http://localhost:${PROMETHEUS_PORT}/alerts"
open "http://localhost:${GRAFANA_PORT}"
open "http://localhost:${RABBITMQ_MANAGEMENT_PORT}"
open "http://localhost:${MAILPIT_PORT}"
open "https://github.com/AY2627S1-CS3219-P30/foc-app/blob/main/docs/reports/credit-conservation-2026-10-01.md"
open "https://github.com/AY2627S1-CS3219-P30/foc-app/blob/main/docs/reports/2026-10-28-stack-recovery.md"
open "https://github.com/AY2627S1-CS3219-P30/foc-app/blob/main/docs/reports/load-2026-10-29.md"
open "https://github.com/AY2627S1-CS3219-P30/foc-app/actions/workflows/ci.yml"
```

The first four tabs are Prometheus alerts, Grafana, RabbitMQ management and Mailpit; the remaining
four are the conservation, recovery, live-update reports and CI evidence. The timed script uses
Mailpit, the conservation report and CI; keep the others ready for questions. Mailpit is local demo
infrastructure and catches every activation email for this isolated project. Use the configured
private operator credentials from `.env` locally, never place them in a command argument or
screenshot. The exported ports also handle a non-default `D4_PORT_BASE`.
Use `docker compose start rabbitmq` to recover a deliberately stopped broker. Keep this terminal
in the repository root with the demo context selected.

## N1.4 browser arrangement — before the timer

Use the persona profiles: on AWS, the ones from “Before the timer”; locally, the ones
`scripts-demo-tabs.py` opens. No extra account or service is needed. Put Patrick's window and Zhang Yuan's window side by side, with both pages visible. A background
tab closes its stream and catches up when shown again, so switching between hidden tabs alone
does not demonstrate delivery to an already-visible page.

1. Zhang Yuan: select the existing **Feed** (`/feed`) tab; keep its **Live** label visible.
2. Patrick: select **Suppliers** for the composer at 01:30. On submission, keep the resulting
   “D4 dispute example” detail page visible alongside Zhang Yuan's feed. Do not accept that example yet;
   its acceptance belongs to the later dispute segment.
3. Before the prints acceptance at 04:30, select Patrick's existing **prints** detail tab
   and Zhang Yuan's existing **prints** detail tab. Confirm **Live** on both, then leave Patrick untouched
   while Zhang Yuan accepts. Show Patrick changing from **Open** to **Accepted** without reloading.
4. Keep only the windows needed on screen; close duplicate windows from earlier helper runs.
   Each visible tab uses one stream; the service permits five per user and the edge ten per
   address. A refused stream falls back to polling rather than breaking the ordinary APIs.

Jonus says: “The server sends an authenticated one-way notification that an errand changed.
The page reads the current data through the normal API. The notification cannot change the
errand or a balance, and polling continues if the stream is unavailable.”

The exact labels are **Live**, **Reconnecting…** and **Updating every 30 s**. A visible update
only after a reload is not evidence of the live path. If the label is polling, disclose that and
use the load report plus `web-app/e2e/live-journey.e2e.ts`: the browser test checks a new card and
an acceptance arriving within three seconds without a reload, and a `503 LIVE_UNAVAILABLE`
response displaying the polling fallback. Do not confuse browser offline mode (all requests
fail) with disabling only the stream.

## Timed script and expected observations

The story follows the course's own example: Patrick needs CS3219 project prints brought from SoC
to PGP. Explain why a choice was made rather than narrating every click; the slides after the demo
carry the detail. Presenters are proposed from the deck's team slide, so confirm the handoffs in the
two real rehearsals. Every segment below has a fallback; a fallback is disclosed evidence, not a
claim that a failed live action succeeded.

| Time | Presenter | Action and words to say | Evidence / fallback |
| --- | --- | --- | --- |
| 00:00–01:30 | Anselm, Isaac | Register an address that has never signed up. On AWS, Isaac registers with Isaac's own NUS email and opens the email there, on screen. Locally, use a clearly fictional address and open its message in Mailpit at `http://localhost:${MAILPIT_PORT}`. Click the activation link, choose a password and press **Activate account**: **Your account is active**. “Only the inbox owner can activate, and chooses the password there, so whoever signed the address up never does. Activation creates the wallet through an event; the browser never sets a balance.” Patrick opens `/admin`: **This area is for administrators**. | If the email is delayed, or the link is over 30 minutes old, use **Send a new link** once on `/activate`, then check the inbox again (locally, search Mailpit). Do not register repeatedly or display passwords. If the wallet is delayed, show Credit's dead letters and audit evidence. |
| 01:30–03:30 | Patrick, Jonus | “Patrick's prints errand is already up, and there's a second errand to post.” Patrick: Suppliers → search **Printer** to show the catalogue. Then **Active requests** → **New request** → pick **Printer @ Com 2** → item “D4 dispute example”, zone PGP House 7, reward **1**. Review the available balance and its projection, then post. **N1.4:** Zhang Yuan's feed is visible with **Live**; the new card appears without a reload. Leave it unaccepted. | If the composer fails, keep the refusal and use the preseeded prints errand for the core flow. The composer is covered by the release suite (`release-journeys.e2e.ts`); do not mark a live failure passed from a seed API call. |
| 03:30–04:30 | Zhang Yuan | Zhang Yuan and Jonus open **Accept** on the card “Project poster — two couriers, one acceptance” in their own feeds. Zhang Yuan confirms, then Jonus: **Another courier accepted this errand first, or it closed.** “One conditional update in the database decides the winner, so the app can't have two.” Zhang Yuan withdraws: the errand is **Open** again and the reward stays reserved. | If the timing is missed, show the CI contention test (1 of 100 simultaneous accepts wins) and its 409. If a step fails, refresh to get the current version; never force a status back. |
| 04:30–05:00 | Jonus | Patrick's and Zhang Yuan's prints pages side by side, both **Live**. Zhang Yuan accepts. Patrick's page goes **Open** → **Accepted** with no one touching it. Use the words under “N1.4 browser arrangement”. | If the label shows polling, disclose it and show the 29 Oct report and `live-journey.e2e.ts`. |
| 05:00–06:30 | Patrick, Zhang Yuan, Anselm | **N1.2 chat.** Patrick: “Please leave them at the PGP House 7 lobby counter.” Zhang Yuan sees it at once, because Zhang Yuan's panel holds the Chat Service's notify-only socket, which tells it to read, and Zhang Yuan replies. Jonus opens the same errand: its public details, no chat panel and no delivery instructions. “Chat asks Order who the participants are on every request, so there is no copy to fall behind, and a courier who withdraws loses access at once.” Say, without demonstrating: 20 messages a minute, kept 90 days after the errand ends. | Locally, “Could not verify your identity” means an old `.env`: see “Local fallback: start from zero”. Otherwise show `chat-journey.e2e.ts` in CI. If a message takes about 2 s, the socket is down and the panel is polling: say so, as nothing is missed. On a release before `rc3-d4` the panel always polls. |
| 06:30–08:00 | Isaac | Zhang Yuan records pickup and delivery. Patrick's page shows **Delivered, confirm receipt**; Patrick confirms, and it reaches **Complete**. Open the receipt and follow **See it in your wallet**. Show both ledgers: Patrick's total −2, Zhang Yuan's +2. Back on the errand, chat's history stays readable and sending is off. “Credits only moved when Credit confirmed it, once.” | If the transfer is slow, wait for the actual reply and show the errand's history. No SQL credit edits. |
| 08:00–09:00 | Isaac | Patrick cancels the **cancel** errand, then the reopened **race** errand. Both reach **Cancelled**, and the wallet shows the credits released. “Withdrawing removed a courier; cancelling returned the reward.” | If a release is delayed, show the errand's history and wait. Restart only the named demo dependency. |
| 09:00–11:30 | Zhang Yuan, Jonus | Zhang Yuan accepts the “D4 dispute example”, records pickup and delivery. Patrick, in chat: “It wasn't at the counter when I came down.”, then **I didn't receive it** → **Report**: **With an administrator**. Within about 10 s the sweep refers it to one admin: open Admin → Errands → the errand in both profiles, and the one who sees **Decide for the requester** is the one referred. They read the conversation (read-only, and the read is recorded), give a reason and decide. Patrick's errand reaches **Cancelled**, with the decision in its history. “A dispute is decided through the same state machine, so an admin can't edit a balance.” | If the composer errand is absent, say the dispute is unavailable and show `dispute-outcome.e2e.ts` in CI. Do not fake a referral or a second person's action. |
| 11:30–13:00 | Anselm, Jonus | Dina: Users → Jonus → **Make administrator**, with a reason and her password: **Requested. Nothing changes until another administrator approves it.** Evan: Role requests → **Approve**, with a reason and his own password. Show the audit trail naming both, and read-only Wallets. “Two people for a role change, and no API edits a balance.” | If an approval fails, leave the request pending and say so. Never share one admin's session. In a rehearsal on AWS, Evan presses **Reject** instead, so Jonus is still a student for the demo. |
| 13:00–15:30 | Isaac, Jonus, Anselm | On Isaac's cue, `docker compose stop rabbitmq`. On AWS, Anselm runs it in Session Manager in the AWS console, already open in `~/foc-app` (“Operator access on AWS”). It stops the live site's broker, so nobody else should be using the site. Locally, run it in the demo context. Patrick posts another **1-credit** request, “D4 broker example”: it stays **Waiting for credits**, because its event waits in the outbox. On Isaac's cue, `docker compose start rabbitmq` (Anselm, on AWS). Within about 15 s the same errand reaches **Open**, and the wallet shows one reservation. “Nothing was lost and nothing happened twice.” | If it is too slow, bring RabbitMQ back at once and show the `scripts-demo-failures.sh` CI evidence. This is the outbox retrying, not the reconciler: do not claim every fast recovery was the scheduled job. |
| 15:30–16:30 | Isaac | Admin → Operations → **Run ledger audit**: **PASS**, 0 mismatches. (Locally, `npm run audit:credits` runs the same audit from the terminal.) Open the conservation report: no credit created or lost across 804 generated errands, with messages dropped and duplicated. “N3.2 compares pending errands with Credit's records and resends the same command.” | A failed audit is not zero mismatches: keep its run ID and investigate with the runbook. Do not demonstrate corruption on this database. |
| 16:30–17:00 | Jonus | Show the latest green `main` run in CI. Name what is still reserved: the broker example. “No administrator edited a balance; every change has a normal transaction and ledger history.” Back to the slides. | Give the actual remaining issue instead of claiming everything is clean. |

**If you are running late,** drop these, in this order: the second cancellation (the race errand then
stays open and reserved, so say so at the close); the two-admin approval (slide “Other decisions”
covers it); the live audit run (show the last run in Operations). Keep the race, chat, the dispute
and the broker stop, because each is someone's main part. The recovery drill is not in the 17 minutes:
the Deployment strategy slide gives its figure, and its report tab is ready for questions.

The completed prints payment changes Patrick's total by −2 and Zhang Yuan's by +2. Cancellation and release
do not change a wallet's total. All three students together retain `3 × A`, and held or reserved
credits still count. With `A` = 10, the script ends at Patrick 7 available and 1 reserved (the broker
example), Zhang Yuan 12 and Jonus 10. On AWS, start from the balances noted before the timer; the changes
are the same. The daily financial audit checks the complete database, beyond these three wallets.
Cancel the broker example afterwards if a zero-reserved ending is wanted.

## Reproduce the evidence and recover a failed rehearsal

On AWS there is no reseed: data stays between runs. If an errand expired or was used up, Patrick
posts it again. If Jonus was promoted in a run, Jonus stays an administrator, so the next run needs
another student account in that role; in rehearsals Evan presses **Reject** instead. If the site
itself fails, follow [Deploying to AWS](../runbooks/aws-deploy.md), or move to the local fallback
and say so. The commands below are for the local stack.

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
cancellation, disputes, suspension/reassignment, controlled-clock expiry/auto-confirmation, the
admin console and the subsequently merged N1.4 live-update/fallback journey; see the [web README](../../web-app/README.md#full-release-suite-tst-02-160). CI
runs it once on each pull request, and twice from clean volumes on every push to `main`. Preserve traces/screenshots on failure and record run links.

For a 429 during repeated practice, respect Retry-After and stop creating extra accounts. For
401/403, use the correct persona's own profile and current session; do not copy a token between
actors. If a seed was interrupted during activation, run it again: it asks for a new link and
reads it from the project's Mailpit. If no email arrives, use `--fresh` on this disposable project. If a deadline expired while preparing, use `--fresh`;
the seed does not reset a persisted deadline or undo a terminal transition.

## Rehearsal acceptance — actual non-owners only

| Run | Non-owner | Where and what ran | Date / duration | Result and evidence |
| --- | --- | --- | --- | --- |
| 1 | UNRESOLVED | AWS, the deployed commit from `.deploy-history` | UNRESOLVED | Pending actual rehearsal |
| 2 | UNRESOLVED | AWS, `v1.0-d4` | UNRESOLVED | Pending actual rehearsal |

Record who actually performed the steps, where it ran and the commit (on AWS, the last line of
`.deploy-history`; locally, the tag and clean-start command), which segments ran
live, the timed result, failures/fallbacks and evidence links. An agent run, CI personas or an
owner's solo rehearsal are not two non-owner rehearsals. #160 is closed (#325); #167 stays open until
both real rehearsals are recorded, including their timing. #288 coordinates the release-candidate
schedule; do not replace its dates or invent sign-offs here.
