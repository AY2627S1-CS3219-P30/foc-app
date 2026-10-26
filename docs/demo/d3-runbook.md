# D3 demo runbook

Fifteen minutes of live demo, then thirty of questions. This is what we run, who runs it, how long
each part takes, and what to do when a step fails in front of the mentor
([PLT-07 #236](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/236)).

Everything shown is a script in this repository that checks its own output, so a part either
passes on screen or says what went wrong. CI runs the same scripts on every pull request, so the
latest green run on GitHub is always a fallback: open it and read the log aloud.

| Script                                       | Shows (D3 part)                                               | Takes on a warm stack |
| -------------------------------------------- | ------------------------------------------------------------- | --------------------- |
| `./scripts-smoke.sh`                         | Start-up, isolation, hardening, broker accounts (4)           | 12 s                  |
| `./scripts-demo-journey.sh --pause`          | Registration to allocation, an errand, refusals (1, 2)        | 7 s, plus narration   |
| `./scripts-demo-journey.sh --stage`          | Prepares one dead letter to redrive live (3.4)                | 93 s, before the slot |
| `./scripts-demo-journey.sh --redrive-staged` | Redrives it through the API, if the console fails             | 1 s                   |
| `./scripts-demo-failures.sh`                 | Killed consumer, duplicate, stale, bad version, forgery (3.4) | 12 s                  |
| `./scripts-restart-check.sh`                 | Restart, recreate, lose Postgres (4.2, 4.3)                   | 77 s                  |

## Before the slot

Do this on the demo laptop, from a clean clone, starting 30 minutes before. The first build is the
only slow step, and its time on a machine with nothing cached has not been measured: do it the day
before as well.

```bash
git clone https://github.com/AY2627S1-CS3219-P30/foc-app.git && cd foc-app
./scripts-init-env.sh                 # every secret is generated here; nothing is in the repository
docker compose up -d --build          # 30 s with images cached; allow ten minutes for a first build
docker compose ps -a                  # nine rows healthy; the four *-migrate rows have exited (0)
./scripts-smoke.sh                    # "All smoke checks passed."
./scripts-demo-journey.sh --stage     # leaves one dead letter that a redrive will fix (95 s)
docker compose restart user-service   # last: clears the registration limit, see below
```

`--stage` ends by printing the dead letter's id and where the administrator's password is
(`DEMO_ADMIN_PASSWORD` in the git-ignored `.env.demo.local`).

If this laptop ran the stack before PLT-06 (#240) merged on 20 Oct, its volumes hold passwords the
new `.env` does not know, and the services fail with `password authentication failed`. Run
`docker compose down -v` once, before `up`. On a clean clone there is nothing to do.

The User Service allows 20 registrations an hour from one address, counted in memory, and every
script here registers its own students from this laptop: the journey three, the failure demo
three. Restarting the User Service clears the count, which is why it is the last step. Rehearse as
often as you like before it; after it, the slot uses six.

Then open, and leave open:

| Tab                  | Address                                  | Signed in as                                     |
| -------------------- | ---------------------------------------- | ------------------------------------------------ |
| Admin console        | <http://localhost:3000/admin/operations> | `admin@u.nus.edu`, `DEMO_ADMIN_PASSWORD`         |
| Admin console, users | <http://localhost:3000/admin/users>      | the same session                                 |
| Dashboard            | <http://localhost:3005>                  | nobody: viewing needs no sign-in                 |
| RabbitMQ             | <http://localhost:15672>                 | `RABBITMQ_USER`, `RABBITMQ_PASSWORD` from `.env` |
| Terminal, large font | the repository root                      |                                                  |

Check the dashboard shows one dead letter waiting and the `DeadLetterWaiting` alert firing. If it does
not within a minute, see [If something fails](#if-something-fails).

## The fifteen minutes

Each part is presented by the owner of what it shows. One person drives the terminal throughout;
the presenter talks.

| Time  | Part                                                | Presents                      | Run                                              |
| ----- | --------------------------------------------------- | ----------------------------- | ------------------------------------------------ |
| 0:00  | 1. It starts, and what is running                   | Jonus                         | `docker compose ps`, the smoke test's last lines |
| 1:30  | 2. Registration to allocation                       | Anselm, then Isaac            | journey, part A                                  |
| 3:30  | 3. An errand, request to payment                    | Patrick, Zhang Yuan, Isaac    | journey, parts B and C                           |
| 7:00  | 4. What the backend refuses                         | Zhang Yuan                    | journey, part D                                  |
| 8:30  | 5. Messages that go wrong                           | Jonus, then Patrick           | `./scripts-demo-failures.sh`, dashboard, a redrive in the console |
| 11:30 | 6. Containers: restart, recreate, lose a dependency | Jonus                         | three commands by hand                           |
| 13:30 | 7. Nice-to-haves                                    | each owner, 15 s              | none ([#237](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/237)) |
| 14:30 | Buffer                                              |                               |                                                  |

Parts 2 to 4 are one command, which stops before each part until Enter is pressed:

```bash
./scripts-demo-journey.sh --pause
```

### 1. It starts, and what is running (Part 4.1, 4.3) — 1:30

Show `docker compose ps`. Say: nine containers. The web app and four services, each service with
its own image, its own migrate job, its own database role and its own broker account; and
Postgres, RabbitMQ, Prometheus and Grafana from pinned public images.

Switch to the browser for a second: <http://localhost:3000> is the web app, one of the nine.

Show the end of `./scripts-smoke.sh` (run it; it takes about 12 seconds). Point at four lines:

- `every container runs as non-root`
- `postgres:5432 is published on 127.0.0.1 only`
- `user-service hides /internal/introspect on its public port`
- `the broker refuses user.activated from the Order Service`

**If it fails:** a line says which check. Read it out, say what it protects, and move on; the
journey does not depend on it.

### 2. Registration to allocation (Part 2.2) — 2:00

Press Enter for part A. Anselm: a student registers and activates; the User Service saves the
account and an outbox row in one transaction, and does not call Credit.

Isaac: Credit hears `user.activated` and issues 10 credits. Point at `10 available, 0 reserved`
and at the ledger's single `ISSUE` entry. The allocation is one constant
(`credit-service/src/credits/types.ts`). A repeat of the event cannot issue twice: part 5 shows it.

**If the wallet does not arrive:** the script says so after 30 seconds. Show
`docker compose logs --tail=20 credit-service` and the outbox panel on the dashboard: the event is
either waiting in the User Service's outbox or in Credit's queue, and that is the answer to "what
if allocation is delayed".

### 3. An errand, request to payment (Parts 1.5, 2.3) — 3:30

Enter for part B. Patrick takes the first call: the supplier lookup, which is where an errand's
pickup place comes from; the Order Service keeps a copy of it on the errand. Zhang Yuan narrates
the rest as they appear: `POST /orders` with the requester's token, the courier's `accept`,
`pickup`, `deliver`, the requester's `confirm-receipt`. Every call carries the caller's token; the Order Service asks the User Service
who that is.

Isaac narrates the three wallet lines:

| Line                           | Requester | Courier | Why                                     |
| ------------------------------ | --------- | ------- | --------------------------------------- |
| before                         | 10/0      | 10/0    |                                         |
| delivered, not yet confirmed   | 7/3       | 10/0    | reserved when the errand was created    |
| after                          | 7/0       | 13/0    | transferred when receipt was confirmed  |

Point at the history line: seven states, two of them waiting on Credit
(`PENDING_CREDIT`, `COMPLETION_PENDING_CREDIT`). That is the asynchronous workflow of Part 3.

Enter for part C: the cancellation. `4/3` becomes `7/0`, released exactly once.

The same balances in the browser, if wanted: the admin console's **Wallets** tab, the requester's
email. It shows available, reserved and the ledger (starting credits, reserved, transferred,
released), every line read from the Credit Service. Looking is recorded with the admin's name.

**If a call returns something else:** the script prints the status and error code it got. Run
`./scripts-demo-journey.sh` again without `--pause`: it signs up new students, so a second run is
independent of the first.

### 4. What the backend refuses (Part 1.3, 1.4) — 1:30

Enter for part D. Zhang Yuan reads the six refusals; each is the Order Service's answer, with its
error code, to a real request:

- your own errand: `403 SELF_ACCEPTANCE_FORBIDDEN`
- a second courier: `409 ORDER_NOT_OPEN`
- a bystander: `403 ACTION_FORBIDDEN`
- delivery before pickup: `409 INVALID_ORDER_STATE`
- the courier confirming their own delivery: `403 ACTION_FORBIDDEN`
- a second completion: `409 INVALID_ORDER_STATE`, one transfer, the courier's balance unchanged

"An admin viewing a requester's orders" (Part 1.3), in the browser: **Users**, open a "Demo
requester" (the journey makes one per run). Their errands are listed under "Errands they requested",
read from `GET /admin/orders?requesterId=` (ORD-15); a student's token gets `403` from the same
call. Each errand links to its trace on the Operations tab.

### 5. Messages that go wrong (Part 3.4) — 3:00

Run `./scripts-demo-failures.sh` (12 seconds). Jonus reads the five failure headings: Credit
killed mid-workflow, the same event three times, a late duplicate of a reply, a version nobody
supports, and the Order Service forging an activation. A sixth heading checks that the closed
economy still balances after all of them.

Switch to the dashboard. Point at three panels: **Dead letters waiting** (3), **Firing alerts**
(`DeadLetterWaiting`), and lower down **Repeated, stale and waiting steps (last hour)**, which
counts the repeat and the stale reply. Say it plainly if asked: no Alertmanager runs in this stack,
so an alert is shown on the dashboard and at <http://localhost:9090/alerts> and nobody is paged.

Switch to the admin console's Operations tab; Patrick drives it. The dead letters list opens on
the Order Service: choose **Credit Service** above it. Three dead letters are waiting on
`foc.credit.wallet-provisioning`, each with its reason:

| Reason                                                     | From                       | A redrive would                  |
| ---------------------------------------------------------- | -------------------------- | -------------------------------- |
| `role "credit_service" is not permitted to log in`         | `--stage`, before the slot | succeed: the cause is gone       |
| `unsupported schema version 2 for user.activated; ...`     | the failure demo, just now | fail again, as a new dead letter |
| `sender order-service may not publish user.activated: ...` | the failure demo, just now | fail again, as a new dead letter |

**Inspect** the first. "Message, as it arrived" is the whole event: `eventId`, `eventType`,
`schemaVersion`, `producer`, `correlationId`, `causationId` and the `payload`. That is Part 3.2's
sample payload, and how a repeat is recognised (its `eventId`). Before the slot, Credit could not
reach its database for longer than its retries last while this student activated. Close it,
**Redrive** it with a reason, then show that the student now has a wallet, issued once:

```bash
. ./.env.demo.local
docker compose exec -T postgres psql -U postgres -d foc_credit \
  -c "select available, reserved from wallets where user_id = '$DEMO_STRANDED_STUDENT'"
```

**If the console does not load or the redrive fails:** `./scripts-demo-journey.sh --redrive-staged`
redrives the same dead letter through the API in a second, and checks the wallet itself.

### 6. Containers: restart, recreate, lose a dependency (Part 4.2, 4.3) — 2:00

Three things by hand, about 40 seconds of waiting in all.

```bash
COUNT='select status, count(*) from orders group by 1 order by 1'
docker compose exec -T postgres psql -U postgres -d foc_order -c "$COUNT"   # the errands so far
docker compose down && docker compose up -d     # every container removed and created; volumes kept (25 s)
docker compose exec -T postgres psql -U postgres -d foc_order -c "$COUNT"   # the same rows
```

Then reload the Operations tab (the admin is still signed in), choose Credit Service and set the
status to Redriven: the dead letter from part 5 is still there; Inspect shows who redrove it and
why. Open a demo student under **Users**: their errands are still listed.

```bash
docker compose stop postgres
curl -i localhost:3003/health                   # 503 {"status":"unavailable","dependencies":{"database":"down",...}}
docker compose start postgres
curl -i localhost:3003/health                   # 200 again within two seconds; no service restarted
```

The same from the browser, with one service gone: the account page from above, then

```bash
docker compose stop order-service
```

Reload the page. Only the two errand lists say "Couldn't load errands"; the account, its actions
and its audit trail still load, because each section asks its own service. Then
`docker compose start order-service` (healthy in a second or two) and press **Try again** on a list.

If there is time, the broker, which is the other case the instructions name:

```bash
docker compose stop rabbitmq
curl -s localhost:3003/health                   # still 200: {"status":"ok",...,"dependencies":{"database":"up","broker":"down"}}
docker compose start rabbitmq
```

Say: a service keeps taking writes without the broker, because the event is saved with the change
and sent when the broker is back. That is the difference from losing the database, and part 5's
first step (Credit killed, the errand waits, then opens) already showed it. Do not run the journey
while the broker is down: new students get no wallet, so it prints failures and waits about a
minute at each step. In the dry run, errands saved meanwhile opened about 40 seconds after
`start`. `./scripts-restart-check.sh` covers Postgres only, so this step has no script behind it.

Say: `down -v` is the one command that deletes data. The full version of this part, with a request
waiting in a queue across each restart, is `./scripts-restart-check.sh`, which CI runs.

**If the stack does not come back healthy in a minute:** `docker compose ps`, then
`docker compose logs --tail=30` for the unhealthy row. Continue from the dashboard and the CI log
while it recovers.

### 7. Nice-to-haves (Part 5) — 1:00

Each owner, in one sentence: the feature, the problem it solves, where it stands. The plan is
[#237](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/237).

## If the mentor changes the code

Rehearsed with the initial allocation, because the effect shows in the first check of the journey.

```bash
# credit-service/src/credits/types.ts: INITIAL_CREDIT_ALLOCATION = 10  ->  12
docker compose up -d --build --force-recreate --no-deps credit-service   # one container, about 8 s
./scripts-demo-journey.sh                                                # 9 s; fails, as it should
```

The journey then prints, among five failed checks:

```text
FAIL  the new student's wallet is 12/0, not 10/0
FAIL  balances are requester 9/0, courier 15/0
```

That is the point: its checks are the claims we make, and a changed rule breaks the ones that
state it. `docker compose ps` shows only `credit-service` restarted; the others' uptime is
unchanged. Change the line back and run the same `up` command (2 seconds, from cache) before
continuing.

Use that exact command. In rehearsal, plain `docker compose up -d --build credit-service` built
the new image every time but twice left the old container running; `--force-recreate` replaced it
five times out of five. `--no-deps` skips the migrate job, so leave it off if the change adds a
migration.

If the journey still passes after the change, the old container is still running. Check what it
holds, and run the `up` command again:

```bash
docker compose exec -T credit-service grep ALLOCATION /app/credit-service/dist/credits/types.js
```

For a change to shared code in `platform/`, every service image is rebuilt:
`docker compose up -d --build`, about half a minute with the cache warm.

## Where the answer to a "why" question is

| Question (D3 part)                                             | Where                                                                                                                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Why PostgreSQL, and one database per service (1.1, 2.1)        | [Order schema §1](../order-service/schema.md), [Credit schema §1](../credit-service/schema.md); [ADR 0003](../adr/0003-service-boundaries-and-data-ownership.md) |
| Credit's tables, constraints and invariants (2.1)              | [Credit schema](../credit-service/schema.md) §2–§3                                                                                                               |
| Why 10 credits, and how it is configured (2.2)                 | [Credit README, The initial allocation](../../credit-service/README.md#the-initial-allocation)                                                                   |
| A wallet that is late or never arrives (2.2)                   | [Credit README, When the allocation fails or is delayed](../../credit-service/README.md#when-the-allocation-fails-or-is-delayed)                                 |
| Balances before and after each operation (2.3)                 | `./scripts-demo-credits.sh`; [Credit README](../../credit-service/README.md#balances-before-and-after)                                                           |
| The errand states and who may trigger each (1.2)               | `order-service/src/orders/order-state-machine.ts`; the Order Service README                                                                                      |
| One courier only; acceptance racing cancellation (1.4)         | `system-tests/test/races.test.ts`; `expectedVersion` on every action                                                                                             |
| Why Order and Credit talk by events (2.4, 3.1)                 | [ADR 0002](../adr/0002-asynchronous-order-credit-saga.md)                                                                                                        |
| Why RabbitMQ; events and requests; ordering; repeats (3.1-3.3) | [ADR 0009](../adr/0009-messaging-rabbitmq-events-and-ordering.md)                                                                                                |
| A change saved but not published (3.3)                         | README, "Publishing with a database write: the outbox and inbox"                                                                                                 |
| Who a service believes (1.3, 2.4)                              | [ADR 0004](../adr/0004-authentication-and-trust.md)                                                                                                              |
| Dockerfiles, images, secrets, networks, restarts (4)           | README, "Containers: secrets, networks and restarts"                                                                                                             |
| CI and what it gates on (4.4)                                  | README, "Continuous integration"                                                                                                                                 |

## If something fails

| Symptom                                                           | Do                                                                                                                                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `required variable ... is missing a value`                        | `./scripts-init-env.sh`                                                                                                                                                   |
| `password authentication failed` at start                         | The volumes are older than `.env`: `docker compose down -v && docker compose up -d --build`                                                                               |
| A port is taken                                                   | `docker compose ps -a` in other projects; stop them. Ports are in `.env`                                                                                                  |
| A container is unhealthy                                          | `docker compose logs --tail=30 <service>`; `docker compose up -d` again                                                                                                   |
| The dashboard is empty                                            | Wait 30 seconds (two scrapes); check <http://localhost:9090/targets>                                                                                                      |
| The Operations tab shows no dead letters                          | It opens on the Order Service: choose **Credit Service** above the list                                                                                                   |
| `DeadLetterNotParked` shows as pending                            | Normal just after the failure demo; it fires only after two minutes, which means Credit is down                                                                           |
| The admin password is not accepted                                | It is `DEMO_ADMIN_PASSWORD` in `.env.demo.local`; if that file is gone, `docker compose down -v` and start again                                                          |
| `Registration is rate-limited`                                    | `docker compose restart user-service` (20 registrations an hour from one address, counted in memory)                                                                      |
| Credit is unhealthy after an interrupted `--stage` or `--redrive` | Its database login was left disabled: `docker compose exec -T postgres psql -U postgres -c "ALTER ROLE credit_service LOGIN"`. Running the journey again also restores it |
| A script fails half way                                           | Run it again: each run makes its own students and errands                                                                                                                 |
| Nothing works                                                     | `docker compose stop`, then `./scripts-demo-journey.sh --up` runs the journey on a separate stack; or open the latest green CI run                                        |

## Rehearsals

The acceptance criterion is two runs from a clean clone with the same result, and one rehearsal by
the whole team.

| Date        | Who                        | From a clean clone | Result                                                                                                                                               |
| ----------- | -------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13 Oct 2026 | Jonus (solo)               | yes, twice         | Both runs: smoke 58, failures 17, stage 6, journey 22, journey with redrive 32, restart check 30; no failures                                        |
| 20 Oct 2026 | Dry run, `main` at 849a1ac | yes, once          | Smoke 59, stage 7, journey 22, failures 17, restart check 30; no failures. Console and browser steps checked; the broker step was rewritten (part 6) |
|             | Whole team                 |                    | Not yet done                                                                                                                                         |

## Afterwards

```bash
docker compose down        # keeps the data
docker compose down -v     # deletes it
```
