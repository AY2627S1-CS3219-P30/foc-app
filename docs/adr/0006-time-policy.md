# ADR 0006 — UTC time and timer ownership

- **Status:** Accepted; amended 2026-10-20 (see [Amendment](#amendment--doc-04-2026-10-20))
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
come from validated Order Service environment/configuration, with the D1 values as defaults. The
acceptance deadline, the delivery deadline and the auto-confirmation time are computed when the errand
reaches the state they guard and persisted on it (`acceptance_deadline_at`, `non_delivery_report_at`,
`auto_confirm_at`), so a later config change does not move them. The pickup timeout and the credit
wait are not persisted: each scheduler run measures them from `accepted_at` and `created_at` against
the current `PICKUP_TIMEOUT_MS` and `CREDIT_WAIT_TIMEOUT_MS`, so changing either applies to errands
already in flight. Credit owns transaction/ledger occurrence time.

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
skew exceeds the tolerance of a workflow, or the pickup timeout is changed while errands are in flight:
it removes the courier, so a pickup deadline persisted at acceptance would then be the fix.

## Amendment — DOC-04, 2026-10-20

Raised by Zhang Yuan on [#238](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/238): the
decision said every deadline is snapshotted or persisted, but the Order Service persists three of the
five. The record now says which, rather than the code changing in the week of the D3 demo. The credit
wait only raises an operator alert, so measuring it live costs nothing; the pickup timeout is the one
to persist if its setting ever changes in production.

