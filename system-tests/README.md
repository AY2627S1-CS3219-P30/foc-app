# @foc/system-tests

Cross-service evidence for the credit economy (CRD-07 #152, NTH-05 #165). The real Order and Credit
code — repositories, consumers, outbox relays, scheduler and reconciler — runs together, each
service on its own freshly migrated PostgreSQL database, as deployed. Nothing between a service and
its database is mocked.

| File                                 | What it proves                                                                                                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/conservation.property.test.ts` | Seeded randomised order sequences (random actors, rewards, refusals, lapsed deadlines, dropped and duplicated messages, reconciliation) never break an economy invariant                      |
| `test/races.test.ts`                 | 100 simultaneous acceptances pay one courier (OS-FR3.1.2); transfer and release racing for one reservation leave one terminal outcome; concurrent reservations never overspend a wallet       |
| `test/fault-matrix.test.ts`          | A crash at every write boundary of either service (inbox, operation, wallet, transaction, ledger, order, history, receipt, outbox insert, relay mark) converges with one effect per operation |
| `test/broker-replay.test.ts`         | Over a real RabbitMQ: every event published twice, a crashed consumer retried through the broker, then the whole run replayed — one effect each                                               |
| `test/reconciliation.test.ts`        | Each lost request or reply is repaired by reconciliation with exactly one Credit transaction                                                                                                  |

## Invariants (`src/invariants.ts`)

- No wallet is negative or fractional.
- Every ledger transaction balances.
- Credits held equal credits issued: credits change only at issuance (ADR 0007).
- Each order has at most one reservation and at most one terminal outcome (transfer or release), never a terminal without a reservation.
- Once settled, Order's status and Credit's transactions agree for every order, and none is left waiting on Credit.

A violation fails the test, and so the build.

## Commands

```bash
# Bounded suite, as CI runs it (Shared packages job)
TEST_POSTGRES_URL=postgres://postgres:postgres_dev@localhost:55432/postgres \
RABBITMQ_URL=amqp://foc:foc_dev@localhost:55672 npm test -w @foc/system-tests

# Replay one property seed exactly, or widen the CI profile
PROPERTY_SEEDS=3 TEST_POSTGRES_URL=… npm test -w @foc/system-tests
PROPERTY_SEEDS=1,2,3,4,5,6,7,8 PROPERTY_STEPS=200 TEST_POSTGRES_URL=… npm test -w @foc/system-tests

# Load run and dated report against the containerized PostgreSQL and RabbitMQ (one command)
npm run report:conservation
```

`npm run report:conservation` starts Compose's `postgres` and `rabbitmq`, then runs
`npm run load -w @foc/system-tests`. That load run covers 20 seeds × 150 steps × 10 users, 100-way
acceptance contention and a RabbitMQ replay run. It writes
`docs/reports/credit-conservation-<date>.md` and `.json`, and exits non-zero if any invariant is
violated. `LOAD_SEEDS`, `LOAD_FIRST_SEED`, `LOAD_STEPS` and `LOAD_USERS` size the run; the same
values replay the same sequences. The services run in-process against the containerized
infrastructure, so every Credit and Order transaction is a real PostgreSQL transaction and every
broker delivery in the replay check is a real RabbitMQ delivery.
