# ADR 0003 — Service boundaries and data ownership

- **Status:** Proposed; implementation basis
- **Date:** 2026-10-01
- **Deciders:** Group 30; approvals tracked in [the ADR index](README.md)
- **Ticket:** [FND-02 #183](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/183)

## Context

The services need independent ownership even though local development uses one PostgreSQL server.
Reading another service's tables would make deployments and invariants inseparable.

## Decision

| Service | Owns | May learn from another service only through |
| --- | --- | --- |
| User | accounts, credentials, sessions, roles, status | — |
| Supplier | supplier catalogue and availability | authenticated HTTP/events |
| Order | errands, participants, lifecycle, deadlines and snapshots | authenticated HTTP/events |
| Credit | wallets, reservations, credit transactions and ledger | authenticated HTTP/events |

No service reads, writes, joins, constrains or migrates another service's tables. Local and deployed
PostgreSQL use one database and role per service, as provisioned by `postgres-init.sql`. Cross-service
foreign keys are forbidden; IDs in messages are references validated by the owning workflow.

Order alone decides whether an order transition is valid. Credit alone decides whether and how a
credit movement is valid. User alone decides live caller identity and roles. Supplier alone decides
whether a supplier is active; Order stores the snapshot needed for historical stability.

## Alternatives considered

- **Shared database/schema:** easier joins, but bypasses APIs, couples migrations and leaks write
  authority.
- **One Postgres server per service locally:** strongest physical isolation, but unnecessary resource
  and operations cost for this project; separate databases/roles enforce the required boundary.

## Consequences

Cross-service views are composed from APIs or events and can be temporarily stale. Each service owns
its migrations, recovery and invariants. Administrators use service APIs and never edit tables.

## Revisit if

Services are deliberately recombined into one deployable boundary, or infrastructure cannot provide
separate databases and roles. A revisit must preserve a single writer for every invariant.

