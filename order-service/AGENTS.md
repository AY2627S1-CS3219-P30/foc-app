# Order Service — agent notes

**Plan first.** Remaining work is specified in `order-service/PLAN.md`: settled decisions, one
section per PR, the tests each PR requires, and its done condition. Implement the PR you are given;
its decisions are settled, so build them as written. `README.md` is the lifecycle reference.

## Conventions the code relies on

- **Every status change goes through `OrdersRepository.transition()`**, which asks the rule table in
  `src/orders/order-state-machine.ts`. A new behaviour is a new rule or context field there. A write
  that keeps the status (e.g. assigning an admin) still bumps `version` and writes a history row.
- **Events** are written with `insertOutboxEvent` in the same transaction as the change.
  Consumers wrap handlers in `withInbox`; a reply that does not match the order throws
  `UnparseableMessageError` (dead-lettered, never guessed at).
- **Time**: timers compare against the database clock (`databaseNow()`); a deadline is saved on
  the row when the order moves (ADR 0006).
- **Privacy**: reads go through `projectOrder`; a missing order and a hidden private one both
  answer `404`.
- **Refusals** are `ApiException(status, CODE, message, { status, version })`.
- **Migrations**: edit `src/db/schema.ts`, then `npm run db:generate -w @foc/order-service`.
  Backfills and triggers go in a custom migration (`npx drizzle-kit generate --custom --name <name>`
  from `order-service/`).

## Tests

- **Build shared packages first.** Services import the compiled `dist/` of `@foc/platform` and
  `@foc/auth-client`. In a fresh checkout, or after editing either, run `npm ci` and
  `npm run build -w @foc/platform -w @foc/auth-client` before typecheck or tests; otherwise
  imports fail to resolve.
- In-memory only: boot the module with `test/helpers/app.ts` (PGlite, fake authenticator with
  requester, stranger, bystander, two admins and a suspended student). This plan adds no
  `*.postgres.test.ts`; the existing ones skip without `TEST_POSTGRES_URL`, which is expected.
- HTTP dependencies are faked through their fetch injection token (`SUPPLIER_FETCH`,
  `CREDIT_STATUS_FETCH`); give any new client one.
- Each new endpoint gets an entry in `contracts/order-service.openapi.yaml` and a
  `contract.assert` per status in `test/provider.contract.test.ts`.
- A participant action and a timer on the same order: test each ordering in sequence; the row lock
  in `transition()` makes the simultaneous case resolve to one of them.
