# ADR 0001 — Runtime, framework and repository layout

- **Status:** Accepted
- **Date:** 2026-09-20
- **Deciders:** Group 30
- **Ticket:** [PLT-01 #115](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/115)

## Context

Four backend services must be built by four different people in parallel, share
a contract with a Next.js front end, exchange asynchronous messages from Sprint 2,
and run in containers for D2. Before PLT-01 the repository contained no backend
code, so nothing constrained the choice except the execution plan's decision log,
which proposed a TypeScript stack with NestJS services.

## Decision

**TypeScript on Node 22, NestJS 12, one npm workspace, flat repository layout.**

### Runtime — Node 22.12, not Node 20 and not Bun

Node 20 reached end of life in April 2026 and is no longer receiving security
updates. Node 22.12 is the minimum that supports `require(esm)`, which matters
because much of the ecosystem has not finished the ESM migration.

`web-app` uses Bun and keeps it. Bun is excellent for a Next.js front end, but
adopting it for the services would mean either a second lockfile format in the
same workspace or converting the front end mid-sprint. The services use npm
workspaces; `web-app` stays on Bun and is **excluded from the workspace** so the
two package managers never contend for the same `node_modules`.

### Framework — NestJS 12

Considered: Hono, Fastify, Express, NestJS.

NestJS chosen because:

- Four services written by four people need one imposed shape. A minimal router
  gives freedom this team does not want; five files that look alike are worth
  more than five files that are each individually elegant.
- `@nestjs/microservices` has a first-class RabbitMQ transport, which is direct
  leverage for EVT-01 and EVT-02 in the heaviest iteration.
- It matches the execution plan's decision log, so D4 needs no explanation for a
  divergence.
- Dependency injection and modules are recognisable architectural patterns that
  the D4 rubric explicitly asks the team to reason about.

The cost is real: more ceremony per endpoint, and a learning curve for anyone
who has not used it. Accepted because the project runs for eight more weeks, not
one — on a one-week horizon the answer would have been Hono.

### Layout — flat, npm workspaces, no nesting

The course document requires one folder per microservice, and the execution plan
(§3.1) rules out `apps/`, `services/` and `packages/` grouping. npm workspaces do
not require nesting, so every deployable unit stays at the repository root:

```
platform/           shared service runtime (this ticket)
contracts/          OpenAPI/AsyncAPI + generated types (FND-03, not yet created)
user-service/  supplier-service/  order-service/  credit-service/
web-app/            Next.js front end, Bun, outside the npm workspace
```

`platform/` is deliberately separate from `contracts/`. `platform/` holds runtime
code every service executes — config validation, logging, correlation, health,
the error envelope. `contracts/` will hold the wire schemas FND-03 freezes. One
is imported and run; the other is generated from and validated against.

## Consequences

- Every service imports `PlatformModule.forRoot(...)` and gets `/health`,
  structured logging with a correlation ID, the shared error envelope and
  graceful shutdown. Changing any of those is one edit, not four.
- **The workspace is ESM.** NestJS 12 ships `"type": "module"` with no CommonJS
  build, so every package sets `"type": "module"`, TypeScript uses
  `module: nodenext`, and relative imports carry an explicit `.js` extension.
  This is not optional and not stylistic.
- `nestjs-pino` was dropped. It declares NestJS 12 support but ships CommonJS,
  so it cannot load ESM-only NestJS on any Node below 22.12. `platform/` wraps
  pino directly instead — about sixty lines, and no dependency on a third party
  keeping pace with NestJS releases.
- Tests use Vitest rather than Jest. Vitest runs ESM natively; getting Jest to do
  the same needs more configuration than the test suites are worth. `@nestjs/testing`
  works unchanged with either.
- Database and message-broker choices are **not** settled here. Those belong to
  the tickets that introduce them (PLT-02, EVT-01, and each service's own).

## Revisit if

A teammate is blocked on NestJS for more than a day, or `@nestjs/microservices`
turns out not to fit the workflows in EI-FR1.1.1. Both would be grounds to
reopen this before contracts freeze — not after.
