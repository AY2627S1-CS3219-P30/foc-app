# Credit Service

Owned by **Isaac**. The service owns wallets, reservations, immutable credit history and the closed
credit-economy invariants in [ADR 0007](../docs/adr/0007-credit-invariant-and-double-entry-ledger.md).
Why PostgreSQL, and every table, constraint and trigger, is in
[docs/credit-service/schema.md](../docs/credit-service/schema.md).

## Runtime model

- Each wallet stores non-negative whole-number `available` and `reserved` balances. `total` is always
  derived as their sum.
- First `user.activated` creates one wallet and issues the initial allocation, 10 credits unless
  configured otherwise (see [The initial allocation](#the-initial-allocation)). Inbox deduplication and
  the wallet primary key make both broker redelivery and repeated activation harmless.
- `order.reservation-requested` is accepted only with producer `order-service`. One to five credits
  move from available to reserved with the transaction, double-entry ledger and reply outbox row in
  one database transaction.
- The conditional debit (`WHERE available >= amount`) and database checks prevent negative balances
  under concurrency.
- A duplicate order/request returns another copy of its recorded reply without another movement. A
  reused order ID with different requester/amount is rejected and appended to the audit-alert table.
- A missing wallet is retried because activation may still be in flight. Invalid amount and
  insufficient funds are recorded terminal business outcomes.
- `order.completion-requested` consumes the matching reservation and atomically debits the
  requester's reserved account, credits the courier's available account, and records both resulting
  balances in `credit.transferred`.
- `order.release-requested` atomically moves the matching reservation back to the requester's
  available account and records the result in `credit.released`.
- Transfer and release lock the reservation and share a database-enforced terminal-operation key, so
  they are mutually exclusive even when received concurrently. A mismatched or second terminal
  operation changes no balance and appends an audit alert.
- Request/reply consumers retain their inbox record but deliberately re-run the business-idempotent
  handler on transport replay. This reproduces a lost reply from the immutable recorded result while
  the order/operation constraints prevent a second movement.

The service owns its PostgreSQL database. Migrations under `drizzle/` are applied by the discrete
`credit-service-migrate` Compose container; the application never migrates at boot.

## The initial allocation

D3 Part 2.2. Every new student's wallet is issued **10 credits**: `INITIAL_CREDIT_ALLOCATION` in
[`src/credits/types.ts`](src/credits/types.ts), proposed in D1 and kept since.

**Why 10.** A reward is 1 to 5 credits (`MAX_RESERVATION_AMOUNT`; Order validates the same range).
Ten credits fund two errands at the highest reward and ten at the lowest, so a new student can try
the app as a requester several times before needing to earn anything. It is deliberately not much
more. The economy is closed: credits are never bought, and every credit a requester spends is earned
by a courier, so the allocation only sets how many credits circulate (students × allocation). Too
little, and a student could not post an errand at the highest reward on their first day; too much,
and nobody would need to deliver to keep requesting, which is the exchange FoC exists for. A student
who runs out can still browse, accept and deliver errands to earn more (ADR 0007).

**How it is configured.** Set `INITIAL_CREDIT_ALLOCATION` to a whole number from 5 to 50; unset, it
is the default above. The lower bound is the largest reward, so a new student can always post any
errand; the upper bound stops a typo from minting credits that every later errand inherits. Any
other value stops the service at boot with the reason, rather than issuing the wrong amount. The
service logs the value it uses when it starts (`new wallets are issued the initial allocation`).

```bash
echo INITIAL_CREDIT_ALLOCATION=12 >> .env
docker compose up -d --force-recreate --no-deps credit-service
```

A change applies to wallets created afterwards. Existing wallets keep what they were issued: each
`ISSUE` transaction records its own amount, and conservation is checked against those recorded
amounts, so the economy still balances across a change. There is deliberately no way to change one
student's allocation or top a wallet up: that would be a balance-setting path, which the closed
economy rules out.

## When the allocation fails or is delayed

D3 Part 2.2: registration succeeds, but the wallet does not arrive straight away.

1. **Activation never waits for Credit.** The User Service activates the account and writes
   `user.activated` to its outbox in the same transaction, then answers. It does not call Credit, so
   Credit being slow or down cannot fail a registration (ADR 0002, ADR 0009).
2. **Until the wallet exists**, `GET /wallets/me` answers `404 WALLET_NOT_FOUND`. The student can sign
   in and browse. An errand they post waits as `PENDING_CREDIT`: Credit retries a reservation whose
   wallet does not exist yet, since the activation may still be on its way.
3. **The message is delivered at least once.** If the User Service cannot reach the broker, the
   event waits in its outbox and the relay keeps trying (the `OutboxEventStuck` alert fires after
   2 minutes). If Credit is down, the event waits in the durable `foc.credit.wallet-provisioning`
   queue and is handled when Credit returns.
4. **If handling it fails**, for example because Credit's database is unreachable, the consumer tries
   five times over about 81 seconds (1 s, 5 s, 15 s, 60 s; `platform/src/events/topology.ts`), then
   sets the message aside as a dead letter with the reason (PLT-05).
5. **An operator is told.** A waiting dead letter raises `DeadLetterWaiting`
   (`observability/alerts.yml`) and appears in the admin console's Operations tab and at
   `GET /admin/dead-letters`. Once the cause is fixed, `POST /admin/dead-letters/{id}/redrive` puts the
   message back unchanged.
6. **However often it arrives, one wallet is issued.** The inbox drops a repeated event id, and the
   wallet primary key and `credit_transactions_issue_wallet_key` drop a second activation for the
   same student. A redrive, a broker redelivery and a duplicate publish all end with one wallet and
   one `ISSUE`.

`./scripts-smoke.sh` signs a student up and waits for the wallet (CI runs it); `test/wallets.test.ts`
turns 100 duplicate activations into one wallet; `scripts-demo-failures.sh` replays an activation and
dead-letters one it cannot read.

## Balances before and after

D3 Part 2.3. `./scripts-demo-credits.sh` runs this against the stack (`docker compose up -d` first,
or pass `--up` for a throwaway copy), printing both wallets as their owners read them and the ledger
lines each operation wrote:

| Moment                               | Requester | Courier | What moved                               |
| ------------------------------------ | --------- | ------- | ---------------------------------------- |
| both signed up                       | 10/0      | 10/0    | `ISSUE` × 2                              |
| errand posted, reward 3: **reserve** | 7/3       | 10/0    | requester available → requester reserved |
| delivered, not yet confirmed         | 7/3       | 10/0    | nothing: payment waits for confirmation  |
| receipt confirmed: **transfer**      | 7/0       | 13/0    | requester reserved → courier available   |
| second errand posted, reward 2       | 5/2       | 13/0    | requester available → requester reserved |
| second errand cancelled: **release** | 7/0       | 13/0    | requester reserved → requester available |

Balances are `available/reserved`, shown here for the default allocation; the script expects
balances relative to what the two wallets were actually issued, so it passes with any allocation.
The two students hold twice the allocation between them throughout. The script ends by running
`check-invariants` in the container: the same checks the tests use
([`src/credits/invariants.ts`](src/credits/invariants.ts)), for every wallet on the stack. CI runs it.

To check a running stack's economy at any time (read-only; exits 1 on any violation):

```bash
docker compose exec -T credit-service node credit-service/dist/check-invariants.js
```

## Daily financial audit (CRD-10)

Credit checks every wallet against its ledger once per UTC day and on demand, using one consistent
database snapshot. Each run appends immutable PASS/MISMATCH/ERROR evidence; it never changes a
balance. Administrators see the latest result and can start a scan in **Admin → Operations**.
Operators can run `npm run audit:credits` from the repository root (exit 0 clean, 1 mismatch,
2 busy/failure). Metrics and Prometheus rules report mismatches, failed scans and overdue scans.
See the [ledger-audit runbook](../docs/runbooks/credit-ledger-audit.md) for incident response,
restricted findings, scheduling and test evidence. This differs from Order's pending-saga recovery
job (#152), which replays ordinary idempotent commands.

## HTTP API

Student/admin routes require an active identity resolved by `@foc/auth-client`. The internal status
route uses the ADR-0004 `X-Service-Key` mechanism and accepts only configured service callers.

| Method and path                                | Caller           | Result                                                           |
| ---------------------------------------------- | ---------------- | ---------------------------------------------------------------- |
| `GET /wallets/me`                              | Student/admin    | Own available, reserved and derived total                        |
| `GET /wallets/me/ledger?limit=20&cursor=…`     | Student/admin    | Own immutable activity, newest first                             |
| `GET /admin/wallets/{userId}`                  | Admin            | Any wallet; access is audited                                    |
| `GET /admin/wallets/{userId}/ledger`           | Admin            | Any ledger; access is audited                                    |
| `GET /internal/orders/{orderId}/credit-status` | Internal service | Read-only `NONE`, `RESERVED`, `RELEASED`, or `TRANSFERRED` state |
| `GET /admin/orders/{orderId}/credit`           | Admin            | One errand's operations, transactions, alerts, dead letters      |
| `GET /admin/credit-alerts`                     | Admin            | Audit alerts across errands, newest first                        |
| `GET /admin/activity-alerts`                   | Admin            | `BULK_WALLET_READS` alerts about administrators (ADM-04)         |
| `GET /admin/dead-letters`, `/{id}`             | Admin            | Inputs that failed every retry, searchable; the message as kept  |
| `POST /admin/dead-letters/{id}/redrive`        | Admin            | Sends one dead letter back, unchanged, to the queue it failed on |
| `GET /admin/ledger-audits/latest`              | Admin            | Last financial audit summary, or null before the first run       |
| `POST /admin/ledger-audits/run`                | Admin            | Append an on-demand financial audit; no balance changes          |

There is deliberately no caller-selectable student route and no HTTP route that moves credit. The
redrive (PLT-05) puts a failed input back, byte for byte, on the queue of the
subscription that failed it, which decides again through its inbox and checks; the route itself
records only who redrove it and why. The other POST appends a ledger audit result. The admin trace,
alert and audit-summary routes show no balance, so they are
not recorded wallet reads. The complete wire contract is
[`contracts/credit-service.openapi.yaml`](../contracts/credit-service.openapi.yaml).

**Ledger rows.** `amount` is always positive. `totalChange` is the signed change the transaction
made to this wallet's total, summed from its own double-entry lines: `ISSUE` is `+amount`, `RESERVE`
and `RELEASE` are `0`, and `TRANSFER` is `-amount` for the requester and `+amount` for the courier.
It equals the difference in `resultingTotal` from the previous row, across cursor pages too.

**Watching the admins (ADM-04).** Every admin wallet or ledger read is recorded in
`admin_wallet_reads`. When one administrator has read `ADMIN_WALLET_READS_ALERT_PER_HOUR` (50 by
default) distinct wallets within an hour, the service raises `BULK_WALLET_READS` once for that hour
in `admin_activity_alerts` and logs it as a warning. Both tables are append-only.

`NONE` has a detail of `UNKNOWN`, `IN_FLIGHT`, or `REJECTED`; rejected reservations also expose the
recorded rejection reason. `RESERVED` includes the immutable reservation transaction reference.
`RELEASED` and `TRANSFERRED` include both reservation and terminal references. Repeated queries are
read-only and return the same IDs and timestamps.

## Closed-economy surface audit

| Surface                       | Authorized effect | Trust/correctness boundary                                        |
| ----------------------------- | ----------------- | ----------------------------------------------------------------- |
| `user.activated`              | `ISSUE`           | `user-service` producer, inbox, wallet/issuance uniqueness        |
| `order.reservation-requested` | `RESERVE`         | `order-service` producer, inbox, conditional debit and order key  |
| `order.completion-requested`  | `TRANSFER`        | `order-service` producer, reservation lock and terminal key       |
| `order.release-requested`     | `RELEASE`         | `order-service` producer, reservation lock and terminal key       |
| HTTP routes                   | None              | Reads, unchanged-input redrive and financial audit; guards apply  |
| Migrations/operations         | None at runtime   | Migration role changes schema only; no balance-set command exists |

There is no purchase, withdrawal, cash-out, gift, arbitrary transfer, balance-set, administrative
mutation, or direct cross-service database path. `closed-economy.test.ts` fails if a new HTTP route
or economic event input appears without updating and reviewing the explicit surface manifest.

## Events

| Queue                            | Consumes                      | Trusted producer | Result                                             |
| -------------------------------- | ----------------------------- | ---------------- | -------------------------------------------------- |
| `foc.credit.wallet-provisioning` | `user.activated`              | `user-service`   | wallet + `ISSUE` transaction                       |
| `foc.credit.reservations`        | `order.reservation-requested` | `order-service`  | `credit.reserved` or `credit.reservation-rejected` |
| `foc.credit.completions`         | `order.completion-requested`  | `order-service`  | `credit.transferred`                               |
| `foc.credit.releases`            | `order.release-requested`     | `order-service`  | `credit.released`                                  |

All queues use bounded retry and a dead-letter queue. Every handler uses the transactional inbox.
The outbox relay publishes committed replies with at-least-once delivery.

What a consumer does with a message that is not the ordinary case (EVT-03, PLT-06):

| Message                                                                         | Outcome                                                                                                      |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| The same event id again                                                         | Acknowledged, no effect, counted (`foc_events_duplicate_total`)                                              |
| A request sent again under a new event id                                       | Answered from the recorded result; no additional credits move                                                |
| A completion or release before its reservation; a reservation before the wallet | Retried with the usual delays (`foc_events_deferred_total`); a dead letter if the earlier step never arrives |
| A major `schemaVersion` this service does not list                              | Dead-lettered whole, before its payload is read (`unsupported_version`)                                      |
| Published by a broker account other than the trusted producer's                 | Dead-lettered (`untrusted_sender`); see [ADR 0004](../docs/adr/0004-authentication-and-trust.md)             |

`test/delivery.test.ts` drives the real consumers through a broker for the out-of-order and
unsupported-version cases, and for a crash before and after the transfer commits.
`test/terminal-operations.test.ts` covers a request that is sent again.

## Commands

Run from the repository root after `npm ci`:

| Command                                      | Purpose                                        |
| -------------------------------------------- | ---------------------------------------------- |
| `npm run dev:credit`                         | Start with reload                              |
| `npm run db:migrate -w @foc/credit-service`  | Apply migrations to `DATABASE_URL`             |
| `npm run db:generate -w @foc/credit-service` | Generate a migration after changing the schema |
| `npm run typecheck -w @foc/credit-service`   | Type-check                                     |
| `npm test -w @foc/credit-service`            | Unit/integration tests                         |
| `npm run build -w @foc/credit-service`       | Build runtime and migration entry point        |

Required variables are `SERVICE_NAME`, `PORT`, `DATABASE_URL`, `USER_SERVICE_URL`,
`INTERNAL_SERVICE_KEY` (outbound User lookup) and `INTERNAL_SERVICE_KEYS` (inbound Credit callers;
it must include Order's `INTERNAL_SERVICE_KEY`, which Order's reconciliation job (CRD-07) presents
to read `/internal/orders/{orderId}/credit-status`);
`RABBITMQ_URL` enables consumption, outbox relay and dead-letter parking. Optional:
`ADMIN_WALLET_READS_ALERT_PER_HOUR` (default 50) and `INITIAL_CREDIT_ALLOCATION` (5 to 50, default
10; see [The initial allocation](#the-initial-allocation)). Shared variables are
documented in [`.env.example`](../.env.example). A missing required value stops startup.

```bash
./scripts-init-env.sh   # creates .env; every secret is generated on your machine
docker compose up -d --build
curl http://localhost:3004/health
```

The image runs as the unprivileged `node` user and includes a health check. Build it from the
repository root because it imports the shared workspace packages:

```bash
docker build -f credit-service/Dockerfile -t foc/credit-service .
```

The normal suite uses PGlite and skips the separate-connection concurrency case. Run that case
against real PostgreSQL by pointing `TEST_POSTGRES_URL` at a role that may create databases; the
shared test harness creates, migrates and drops a uniquely named database per run (CI does this
automatically, see [docs/testing.md](../docs/testing.md)):

```bash
set -a; . ./.env; set +a   # the stack's addresses and logins, from your .env
TEST_POSTGRES_URL=$HOST_POSTGRES_URL npm test -w @foc/credit-service
```
