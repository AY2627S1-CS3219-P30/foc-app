# @foc/test-harness

Shared test-only fixtures and contract checks (TST-01, #145). It is never built into a service
image. See [docs/testing.md](../docs/testing.md) for the suites and how to run them.

| Export                       | Purpose                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `createEphemeralPostgres`    | A uniquely named, migrated PostgreSQL database per suite, dropped on dispose |
| `createEphemeralBroker`      | Per-run RabbitMQ queue names and retry namespace, deleted on dispose         |
| `createMemoryBroker`         | RabbitMQ's routing in memory, for suites that run without a broker           |
| `ContractValidator`          | Validates real HTTP responses against `contracts/<service>.openapi.yaml`     |
| `findOpenApiBreakingChanges` | Breaking-change detection between two OpenAPI documents                      |
| `findEventBreakingChanges`   | Breaking-change detection between two versions of the event payload schemas  |
| `renderEventSchemas`         | Renders the event catalogue as `contracts/events.schema.json`                |

```bash
npm test -w @foc/test-harness                                     # the harness's own tests
npm run contracts:compat -w @foc/test-harness -- --base origin/main
npm run contracts:events                                          # regenerate event schemas
```
