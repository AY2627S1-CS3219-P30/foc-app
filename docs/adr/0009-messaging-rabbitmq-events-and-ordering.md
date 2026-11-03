# ADR 0009 — Messaging: RabbitMQ, what a message is, and ordering

- **Status:** Accepted
- **Date:** 2026-10-13
- **Deciders:** Group 30; approvals tracked in [the ADR index](README.md)
- **Ticket:** [EVT-03 #153](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/153)
- **Built by:** EVT-01 [#119](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/119), EVT-02
  [#135](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/135), PLT-05
  [#154](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/154), EVT-03
  [#153](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/153)

## Context

[ADR 0001](0001-runtime-and-service-framework.md) left the message broker to the ticket that
introduced it, and [ADR 0002](0002-asynchronous-order-credit-saga.md) decided that Order and Credit
work as an asynchronous saga without saying what carries the messages. EVT-01 chose RabbitMQ and
the code has used it since, but the reasoning was never written down. This record does that, and
answers three questions the saga leaves open: what kind of thing a message is, how a repeat is
recognised, and whether the order messages arrive in matters.

The requirements it answers are EI-FR1.1 (a slow or unavailable service must not block another's
step), EI-NFR1 (no step is lost; recovery is bounded), EI-NFR2 (a step may be repeated, late or out
of order) and EI-NFR3 (a change to what one service sends must not silently break another).

## Decision

### 1. RabbitMQ carries every asynchronous step

The six workflows of EI-FR1.1.1 travel through one RabbitMQ broker
([`platform/src/events`](../../platform/src/events)): creating a wallet on activation, sharing
suspensions and role changes, reserving, transferring and returning credits, and sharing errand
status changes.

Why asynchronous at all is ADR 0002's decision: creating an errand must not fail because Credit is
down, and no transaction spans two services' databases. Why RabbitMQ:

- **Delivery behaviour.** Each message is delivered at least once. A publisher waits for the
  broker's confirmation, a consumer acknowledges only after its handler returns, and a message a
  crashed consumer never acknowledged is delivered again. That is exactly what the outbox and inbox
  (EVT-02) are built on.
- **Reliability we would otherwise write ourselves.** Durable queues and persistent messages
  survive a broker restart. A per-message time-to-live and dead-letter exchanges give delayed
  retries (1 s, 5 s, 15 s, 60 s, then set aside: 81 s in all, inside the 5 minutes of EI-NFR1.1.2)
  and a dead-letter queue per consumer, declared in
  [`topology.ts`](../../platform/src/events/topology.ts).
- **Routing that matches service ownership.** A topic exchange routes by event type, and each
  consumer owns a queue. Adding a consumer of `order.status-changed` binds a queue; the Order
  Service does not change.
- **Operational cost.** One container, a management UI, and a Prometheus exporter that reports
  queue depth, which is the consumer lag on the dashboard.

### 2. Messages are facts and requests, in one envelope

The approach is both event-driven and message-based, and each message is one or the other:

| Kind    | Messages                                                                                                                                                                                   | Meaning                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Fact    | `user.activated`, `user.suspended`, `user.reactivated`, `user.role-changed`, `credit.reserved`, `credit.reservation-rejected`, `credit.transferred`, `credit.released`, `order.status-changed` | Something happened. Any number of services may listen; the sender expects no reply.   |
| Request | `order.reservation-requested`, `order.completion-requested`, `order.release-requested`                                                                                                     | Order asks Credit to act. Exactly one consumer, which answers with a fact about the outcome. |

Both kinds use the same envelope, the same exchange and the same guarantees. A routing key is
prefixed by the service that sends it, so the sender is readable from the key
([`catalogue.ts`](../../platform/src/events/catalogue.ts)). Each event type has one payload schema
there. The publisher checks a payload against it before sending (EVT-03) and the consumer checks
it again on receipt, so a shape that would be dead-lettered fails where it was produced.

A real reservation request, as the Credit Service receives it:

```json
{
  "eventId": "5f0c2a8e-7b1d-4c39-9a52-1e6d3b7f4a10",
  "eventType": "order.reservation-requested",
  "schemaVersion": 1,
  "aggregateId": "5d47f350-3ac0-4ed9-b4c5-3fe085be8227",
  "occurredAt": "2026-10-13T08:43:58.252Z",
  "producer": "order-service",
  "correlationId": "0f4e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b",
  "causationId": "0f4e7c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b",
  "payload": {
    "orderId": "5d47f350-3ac0-4ed9-b4c5-3fe085be8227",
    "requesterId": "e4e1cb1f-e395-4f3f-bdbe-f6dcaf5bce48",
    "amount": 3
  }
}
```

- **What it means:** hold 3 of this requester's credits for this errand.
- **When it is produced:** in the same database transaction that saves the errand as
  `PENDING_CREDIT`, as an outbox row. The relay publishes it after the commit.
- **Who consumes it:** the Credit Service alone, on `foc.credit.reservations`, and only from the
  producer `order-service`.
- **What it triggers:** one recorded reservation outcome and one reply, `credit.reserved` or
  `credit.reservation-rejected`, which moves the errand to `OPEN` or `REJECTED`.

`correlationId` is the browser request that started it all, and `causationId` the message or
request that directly caused this one. `aggregateId` is the errand or user the message is about.

### 3. A repeat is recognised twice over

- **By event id.** A consumer records `eventId` in its inbox (`processed_events`) in the same
  transaction as the effect. The outbox relay reuses the row's id on every publish, so a
  redelivery, or a publish repeated after a crash, is the same event and has no further effect.
- **By business key.** Credit also keys each operation by errand and operation type
  (`credit_operations`), and a wallet by user. A request sent again under a new event id, as
  reconciliation does, is answered from the recorded outcome and moves no additional credits.

### 4. Ordering is not guaranteed and not required

Retries through delay queues, and more than one instance of a consumer, mean two messages can
arrive in either order. Nothing depends on the order of arrival. Each case has a defined answer,
and none of them infers a credit outcome from which message came first:

| Case                                                                                  | What the consumer does                                                                                                         | Seen as                              |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| The same message again                                                                | Acknowledges it; no further effect                                                                                             | `foc_events_duplicate_total`         |
| A step older than a change already applied, such as a second `credit.reserved` after the errand has been accepted | Acknowledges and ignores it, and logs it for operators (`StaleEventError`)                           | `foc_events_stale_total`             |
| A step before the one it depends on: a transfer before its reservation, a reservation before the wallet | Retries with the usual delays; if the earlier step never arrives, sets it aside for review (`PredecessorMissingError`) | `foc_events_deferred_total`, then a dead letter |
| A message in a major version the consumer was not written for                         | Sets the whole message aside before reading its payload, saying the form is unsupported                                        | a dead letter, reason `unsupported_version` |
| A reply that contradicts what is recorded                                             | Sets it aside for review; changes nothing                                                                                      | a dead letter                        |
| A change saved but not yet published                                                  | Nothing is lost: the outbox row is published when the broker is reachable                                                      | `foc_outbox_backlog`                 |
| An event published before its consumer has ever declared its queue                    | The broker hands it back (it is sent as mandatory) and the publish fails; the outbox keeps it and retries until the queue exists | `foc_outbox_backlog`, `last_error` "unroutable" |

`order.status-changed` carries `orderVersion`, the errand's version after the change, so a service
that follows an errand's status keeps the highest version it has applied and ignores anything at
or below it.

A dead letter is kept in the consuming service's database, raises an alert, and can be redriven
unchanged once its cause is fixed (PLT-05).

### 5. A contract change is additive, or it is a new major version

Adding an optional field, an event or a consumer is compatible, and CI checks every contract change
against `main` (EI-NFR3.1.1). `orderVersion` was added that way. A change that removes a field or
changes its meaning is a new `schemaVersion`. A consumer accepts only the versions it lists
(`supportedVersions`, version 1 by default), so a version 2 message is never read by version 1
code, even when its payload happens to fit the old schema (EI-NFR3.1.2).

## Alternatives considered

- **Synchronous calls between Order and Credit.** Rejected in ADR 0002: an errand could not be
  created while Credit was down, and a failure between the two writes needs compensation anyway.
- **Kafka.** A partitioned, ordered log suits high-volume streams and replay by many readers. We
  need per-message acknowledgement, delayed retry and dead-lettering for a few messages per errand,
  all of which RabbitMQ provides and Kafka leaves to the application. It is also heavier to run and
  to explain in a 15-minute demo. Its per-partition ordering buys nothing here, because section 4
  removes the need for ordering.
- **Redis Streams.** Consumer groups and acknowledgements exist, but durability depends on how
  persistence is configured, and delayed retries and dead-lettering would be our code.
- **A shared database table polled by both services.** No broker to run, but it couples services
  through one database, against [ADR 0003](0003-service-boundaries-and-data-ownership.md).
- **Relying on message order.** A single consumer per queue would give order within a queue but
  not across the request and reply queues, would rule out a second instance, and would still break
  on a retry. Making each consumer correct in any order is less to get wrong.

## Consequences

- Every consumer must be idempotent, and is: the inbox and the business keys are not optional.
- Order and Credit are consistent eventually. The gap is visible to users as the
  `*_PENDING_CREDIT` states and to operators as queue depth and the outbox backlog.
- A stale reply no longer pages anyone. Before EVT-03, a second `credit.reserved` that arrived
  after an errand had moved on was dead-lettered.
- Start-up order no longer decides whether a step survives. Before EVT-03, a producer that started
  on a clean broker before its consumer had its event confirmed and then discarded: started that
  way, the seeded administrator never got a wallet. Events that need a consumer are listed in
  `REQUIRES_CONSUMER`; an event with no durable consumer yet, such as `order.status-changed`, is
  not, and is dropped if nobody is bound.
- One more container to run and watch. Each service has a broker login of its own, limited to its
  own routing keys and queues (PLT-06,
  [#155](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/155)).
- A message's producer is still a claim inside the envelope, but it is now checked against the
  broker account that published the message, which the broker vouches for, so one service cannot
  pass a message off as another's ([ADR 0004](0004-authentication-and-trust.md)).

## Revisit if

Message volume grows past what one broker node handles, a consumer needs to replay history from
the beginning (a log would suit that better), or a workflow appears whose correctness does depend
on order and cannot be made order-independent.
