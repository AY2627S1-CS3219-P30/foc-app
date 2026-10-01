# Testing

How the test suites are separated and how to run each one (PL-NFR4.1.1, PL-NFR4.1.2). The shared
fixtures and contract checks live in [`test-harness/`](../test-harness) (`@foc/test-harness`,
TST-01 #145). Each service fills the suites with its own cases.

## Suites at a glance

| Suite                   | Files                                         | Needs                    | Command                                                 |
| ----------------------- | --------------------------------------------- | ------------------------ | ------------------------------------------------------- |
| Unit                    | `*.test.ts` testing pure modules              | nothing                  | `npm test` (or `npm test -w @foc/<service>`)            |
| Integration (in-memory) | `*.test.ts` booting a Nest module over PGlite | nothing                  | `npm test`                                              |
| Contract                | `*.contract.test.ts` + compatibility check    | git history              | `npm run test:contract`                                 |
| Concurrency (real DB)   | `*.postgres.test.ts`                          | `TEST_POSTGRES_URL`      | `TEST_POSTGRES_URL=… npm run test:concurrency`          |
| Broker integration      | `*.integration.test.ts`                       | `RABBITMQ_URL`           | `RABBITMQ_URL=… npm test -w @foc/platform`              |
| System (cross-service)  | `system-tests/test/*.test.ts`                 | `TEST_POSTGRES_URL`      | `TEST_POSTGRES_URL=… npm test -w @foc/system-tests`     |
| End-to-end              | Owned by TST-02 (#160)                        | the Compose stack        | `./scripts-smoke.sh --up` today; journeys arrive in #160 |
| Load                    | Owned by NTH-05 (#165)                        | the Compose stack        | Separate from CI; arrives in #165                       |

Suites that need a real server skip themselves when their variable is unset, so `npm test` passes on
a clean clone with nothing running. CI sets every variable, so nothing is skipped there.

## Isolation: no shared developer database

- **In-memory integration tests** boot each service against its own PGlite instance with the
  generated migrations applied. Nothing touches a developer database.
- **Real-PostgreSQL tests** call `createEphemeralPostgres({ adminUrl: TEST_POSTGRES_URL, label,
  migrationsFolder })`. It creates a uniquely named database, applies the service's generated
  migrations, and drops the database in `dispose()`. `TEST_POSTGRES_URL` must name a role that
  can create databases. Point it at the server's `postgres` database, never at a service database.
- **Broker tests** call `createEphemeralBroker(RABBITMQ_URL, label)`. It gives each run its own
  queue names and retry namespace and deletes them in `dispose()`. The `foc.events` exchange is the
  production topology under test and stays shared, so a test must assert on its own aggregate or
  correlation IDs.

Against the Compose stack:

```bash
docker compose up -d postgres rabbitmq
export TEST_POSTGRES_URL=postgres://postgres:postgres_dev@localhost:55432/postgres
export RABBITMQ_URL=amqp://foc:foc_dev@localhost:55672
npm test
```

## System tests

[`system-tests/`](../system-tests) runs the real Order and Credit code together. Each service gets
its own freshly migrated PostgreSQL database, as deployed. Their outbox relays and consumers are
connected through an in-memory bus that enforces the same producer and catalogue checks as
RabbitMQ, and that can drop or duplicate any delivery. `Stack.start(TEST_POSTGRES_URL, label)` boots
the pair; `settle()` relays and delivers until nothing is in flight. CI runs the suite in the
`Shared packages` job.

## Contract checks (EI-NFR3.1.1)

Contracts are the OpenAPI files in [`contracts/`](../contracts) plus
`contracts/events.schema.json`, which is generated from the event catalogue.

1. **Compatibility.** `npm run contracts:compat -w @foc/test-harness -- --base <ref>` compares every
   contract with its version at `<ref>`. It fails on a removed operation or success response, a
   required response field that was removed or made optional, a request field that became
   required, a request enum that lost a value, or any field whose type was redefined. Event payloads
   are checked in both directions. CI runs it against the pull request's merge base, so **an
   incompatible schema change fails CI before merge**. Additive changes pass.
2. **Provider checks.** Each service's `test/provider.contract.test.ts` sends real requests to the
   running module and validates every response against its OpenAPI document with
   `ContractValidator.for('<service>').assert(method, pathTemplate, response)`. An undocumented
   status, or a body that violates the schema, fails the test.
3. **Consumer checks.** The web app generates its client types from the contracts
   (`web-app/scripts/generate.ts`). `bun test` fails if they are stale, and `bun run
   typecheck:contracts` fails if consumer code no longer compiles against them.
4. **Event schemas.** After changing `platform/src/events/catalogue.ts`, run
   `npm run contracts:events` and commit `contracts/events.schema.json`. A harness test fails if the
   file falls behind the catalogue.

## Adding tests

- A new real-database case: name it `*.postgres.test.ts` and use `createEphemeralPostgres`.
- A new endpoint: document it in the contract and add a `contract.assert(...)` call for each status
  it returns in that service's `provider.contract.test.ts`.
