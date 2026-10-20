# ADR 0004 — Authentication, authorization and service trust

- **Status:** Proposed; implementation basis
- **Date:** 2026-10-01
- **Deciders:** Group 30; approvals tracked in [the ADR index](README.md)
- **Ticket:** [FND-02 #183](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/183)

## Context

Client-supplied roles, ownership or service identity cannot be trusted. Services need a common rule
for user requests and internal messages without sharing User Service tables.

## Decision

User Service issues short-lived EdDSA bearer JWTs containing subject and session identifiers. A
receiving service validates the token and resolves live account status and roles through User
Service using its internal service key. `@Authenticated()` requires an active identity;
`@AdminOnly()` additionally requires a server-resolved `ADMIN` role. Domain code compares the
verified subject with the resource owner. Request bodies, query parameters and browser state never
grant roles or ownership.

Internal HTTP routes require a configured service key and must expose only the minimum data needed
by the caller. Each calling service has a key of its own, so one service cannot present itself as
another, and each service serves `/internal/**` on a second port that only the services' network
reaches; on the published port those routes answer `404` (PLT-06).

Broker messages are accepted only on a declared queue, for the declared event type and declared
producer. Producer identity is an envelope claim, and since PLT-06 two things make the claim hold.

First, each service signs in to RabbitMQ with an account of its own, which may

- publish to the shared exchange only under its own routing-key prefix (`user.*`, `order.*`,
  `credit.*`; the Supplier Service, which publishes nothing, none);
- declare, write to and read only the exchanges and queues under its own name;
- not write to the default exchange, which reaches any queue by name. Delayed retries and redrives
  go through a per-service `foc.<service>.requeue` exchange instead.

So the broker refuses the Order Service a direct publish of `user.activated`, or a write into a
Credit queue, with a 403. That is not enough on its own. RabbitMQ checks a routing key only on the
exchange a client publishes to, and an account that may write to the shared exchange may also bind
an exchange of its own into it, or name it as a queue's dead-letter exchange, and route any key in
that way.

Second, therefore, a consumer checks who published a message, not only what the message says.
Every publish carries the publisher's account as the AMQP `user-id`, which RabbitMQ checks against
the login and which travels with the message through bindings and dead-lettering. A consumer sets
aside any message whose sender is not the producer it names, whatever route it took. A service
republishes other services' messages itself (a retry, a dead letter, a redrive); it does so under
its own account and records the first sender in a header that is believed only on messages
published under the reader's own account, which no one else can do
([`sender.ts`](../../platform/src/events/sender.ts)). The failure demo has the Order Service try
both the direct publish and the binding, and checks that no wallet is created.

It is still not an end-to-end signature: a service that is itself compromised can publish any
event under its own prefix, and the broker operator's account, the one account allowed to publish
under another's name, can publish anything.

Credit has no public mutation endpoint. Its economic mutations come from catalogued events whose
producer is checked (`user-service` for issuance, `order-service` for reservations), then pass the
same domain and idempotency rules as any future authenticated internal endpoint.

## Alternatives considered

- **Trust JWT roles until expiry:** avoids introspection but leaves demoted/suspended access live.
- **Trust gateway headers:** lets callers forge authority if they reach a service directly.
- **Sign every event:** stronger provenance, but operationally heavier than broker ACLs for this
  deployment; retain as a hardening option.

## Consequences

Authorization decisions remain server-side and revocations take effect within the cache window or
immediately on identity-change events. User Service availability can affect uncached requests.

Every shared exchange is still declared by every service, so each account can configure
`foc.events` and its dead-letter exchange, and a compromised service could delete them. That stops
work until a service reconnects and declares them again; it does not let it forge anything.
A service may also bind its own queue to another service's events and read them: reading is not
restricted by routing key, only publishing is. The sender check applies where a subscription
names the producer it expects, which every credit-moving one does; the cache invalidations that
do not are harmless to forge.

The broker accounts, the service keys and the database roles are all created from `.env`, which is
generated per machine and never committed ([README](../../README.md#secrets)).

## Revisit if

Services become internet-addressable without a trusted broker/network boundary, the threat model
requires cryptographic event provenance, or introspection latency/availability misses its SLO.

