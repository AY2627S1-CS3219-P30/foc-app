# ADR 0002 — Asynchronous Order/Credit saga

- **Status:** Proposed; implementation basis
- **Date:** 2026-10-01
- **Deciders:** Group 30; approvals tracked in [the ADR index](README.md)
- **Tickets:** [FND-02 #183](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/183), [CRD-02 #140](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/140)

## Context

The submitted D1 backlog says Order synchronously reserves credits before saving an errand, while
`order-service/README.md` defines a durable `PENDING_CREDIT` state and asynchronous replies. The
teaching-team feedback warns against coupling Order availability to Credit availability and says an
order must not be placed until its credits are reserved.

## Decision

Reservation is an asynchronous saga. Order atomically saves a private `PENDING_CREDIT` order and an
`order.reservation-requested` outbox row. Credit consumes that request, atomically records exactly
one reservation outcome and a reply outbox row, then emits `credit.reserved` or
`credit.reservation-rejected`. Only `credit.reserved` makes the order `OPEN`; therefore an order is
not placed or visible to couriers before its reward is held.

There is no “credits held but order failed to save” compensation path: the order and request are one
Order-database transaction, and Credit cannot hold credits without the committed request. After a
later cancellation or expiry, Order enters `RELEASE_PENDING_CREDIT` and repeatedly emits the same
release request until Credit confirms it. Completion follows the equivalent transfer flow.

The authoritative transition table is `order-service/README.md`. Every transition identifies the
actor, guard, resulting state and emitted events. Credit replies must repeat order, requester and
amount so Order can match them to its request.

Completion can be initiated by requester confirmation, expiry of the 24-hour auto-confirmation
period, or an audited administrator decision for the courier. The latter two are legitimate system
confirmations: they prevent a requester from holding a completed courier reward indefinitely.

This explicitly supersedes D1 `OS-FR1.1` (“no errand record shall be persisted”), `CS-FR3`/
`CS-FR3.1` (“answer immediately”), and the synchronous five-minute rollback in `CS-FR3.1.3`.
The submitted artifact remains historical; DOC-02 (#186) owns its traceability/backlog revision.

## Alternatives considered

- **Reserve synchronously, then save:** simpler happy path, but Order creation fails whenever Credit
  is unavailable and requires compensation if saving fails after reservation.
- **Distributed transaction:** would hide service ownership behind a coordinator and is not
  supported by the independently owned databases.

## Consequences

Order and Credit are eventually consistent. Pending orders are durable but not discoverable by
couriers. At-least-once messages require inbox deduplication, business-key idempotency and
transactional outboxes. A wait timeout alerts an operator; it does not invent a rejection.

## Revisit if

The course contract requires a bounded synchronous response, or operational evidence shows the
pending-state experience cannot meet the product requirement. Reversal requires coordinated Order,
Credit, event-contract and backlog migrations.

