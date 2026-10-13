# ADR 0006 — UTC time and timer ownership

- **Status:** Proposed; implementation basis
- **Date:** 2026-10-01
- **Deciders:** Group 30; approvals tracked in [the ADR index](README.md)
- **Ticket:** [FND-02 #183](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/183)

## Context

Order deadlines, event times and ledger history must agree across services and remain testable.

## Decision

Persist instants as PostgreSQL `timestamptz` and exchange ISO-8601 UTC strings ending in `Z`.
Display-zone conversion belongs to the web app. A service owns the clock for data it owns: database
defaults timestamp durable rows, and the service initiating a domain transition supplies its event's
business occurrence time. Consumers do not rewrite producer times; they separately record processing
time.

Order owns acceptance, pickup, delivery, auto-confirmation and credit-wait deadlines. Their durations
come from validated Order Service environment/configuration, with the D1 values as defaults; they are
snapshotted or their computed deadline is persisted on each order so a later config change does not
retroactively move existing deadlines. Credit owns transaction/ledger occurrence time.

Tests inject/freeze an application clock where a business rule depends on “now”; they do not sleep.
Database transaction timestamps are used for ordering durable records, with a unique ID tie-breaker.

## Alternatives considered

- **Local time in each service:** ambiguous at timezone/DST boundaries.
- **Client timestamps:** untrusted and inconsistent.
- **Hard-coded durations:** cannot satisfy configurable-period requirements or deterministic tests.

## Consequences

Only presentation uses Asia/Singapore or another local zone. Timer workers may run more than once;
the transition guard and idempotency key make retries harmless.

## Revisit if

The product needs user-specific calendar semantics rather than elapsed durations, or measured clock
skew exceeds the tolerance of a workflow.

