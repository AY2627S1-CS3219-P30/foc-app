# Credit Service

Owned by **Isaac**. The service owns wallets, reservations, immutable credit history and the closed
credit-economy invariants in [ADR 0007](../docs/adr/0007-credit-invariant-and-double-entry-ledger.md).

## Runtime model

- Each wallet stores non-negative whole-number `available` and `reserved` balances. `total` is always
  derived as their sum.
- First `user.activated` creates one wallet and issues exactly 10 credits. Inbox deduplication and the
  wallet primary key make both broker redelivery and repeated activation harmless.
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

There is deliberately no caller-selectable student route and no HTTP mutation route. The complete
wire contract is [`contracts/credit-service.openapi.yaml`](../contracts/credit-service.openapi.yaml).

`NONE` has a detail of `UNKNOWN`, `IN_FLIGHT`, or `REJECTED`; rejected reservations also expose the
recorded rejection reason. `RESERVED` includes the immutable reservation transaction reference.
`RELEASED` and `TRANSFERRED` include both reservation and terminal references. Repeated queries are
read-only and return the same IDs and timestamps.

## Closed-economy surface audit

| Surface                       | Authorized effect | Trust/correctness boundary                                            |
| ----------------------------- | ----------------- | --------------------------------------------------------------------- |
| `user.activated`              | `ISSUE`           | `user-service` producer, inbox, wallet/issuance uniqueness            |
| `order.reservation-requested` | `RESERVE`         | `order-service` producer, inbox, conditional debit and order key      |
| `order.completion-requested`  | `TRANSFER`        | `order-service` producer, reservation lock and terminal key           |
| `order.release-requested`     | `RELEASE`         | `order-service` producer, reservation lock and terminal key           |
| HTTP routes                   | None              | Runtime route inventory is GET-only; user/admin/internal guards apply |
| Migrations/operations         | None at runtime   | Migration role changes schema only; no balance-set command exists     |

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
`INTERNAL_SERVICE_KEY` (outbound User lookup) and `INTERNAL_SERVICE_KEYS` (inbound Credit callers);
`RABBITMQ_URL` enables consumption and outbox relay. Shared variables are
documented in [`.env.example`](../.env.example). A missing required value stops startup.

```bash
cp .env.example .env
docker compose up -d --build
curl http://localhost:3004/health
```

The image runs as the unprivileged `node` user and includes a health check. Build it from the
repository root because it imports the shared workspace packages:

```bash
docker build -f credit-service/Dockerfile -t foc/credit-service .
```

The normal suite uses PGlite and skips the separate-connection concurrency case. Run that case
against a disposable real PostgreSQL database (CI does this automatically):

```bash
TEST_CREDIT_DATABASE_URL=postgres://postgres:postgres_dev@localhost:55432/foc_credit_test \
  npm test -w @foc/credit-service
```
