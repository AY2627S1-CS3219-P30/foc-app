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
npm test -w @foc/test-harness                                     # the harness's and the repository checks below
npm run contracts:compat -w @foc/test-harness -- --base origin/main
npm run contracts:events                                          # regenerate event schemas
npm run traceability -w @foc/test-harness                         # regenerate docs/traceability.md
```

## Repository checks in `test/`

Besides the harness's own tests, `test/` checks files no service owns, without starting a stack. Each
runs in CI's Shared packages job.

| File                                               | Checks                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `compose-config.test.ts`                           | No secret in a Compose file or its fallbacks; the stack runs in production mode (PLT-10)               |
| `stack-readiness.test.ts`                          | `/edge/ready` reports the stack ready only when every page can work (PLT-13)                           |
| `publish-images.test.ts`, `release.test.ts`        | `compose.images.yaml`, the publish job, and cutting a release from a tag without rebuilding (REL-03)   |
| `scan-vulnerabilities.test.ts`, `ci-gates.test.ts` | The Trivy scan's gate, and coverage reporting (NTH-04)                                                 |
| `recovery-tools.test.ts`                           | A backup bundle is checked before a restore (PLT-09)                                                   |
| `event-retention.test.ts`                          | Each service prunes its event tables on its own timer (PLT-12)                                         |
| `load-harness.test.ts`                             | The k6 load test and live updates under load (TST-03, N1.4)                                            |
| `demo-seed.test.ts`                                | The D4 seed stays isolated and private, and can run on a release's images                              |
| `traceability.test.ts`                             | Every test `docs/traceability.yaml` names still exists (REL-02)                                        |
| `e2e-clock.test.ts`                                | `e2e-clock.mjs`, the controlled clock `compose.e2e.yaml` mounts into the release suite's backends only |
