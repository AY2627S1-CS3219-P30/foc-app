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
by the caller. Broker messages are accepted only on a declared queue, for the declared event type
and declared producer. In this deployment, producer identity is an envelope claim protected by
broker credentials/topology; it is not an end-to-end signature. Production broker users should be
restricted to publishing their service prefix.

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

## Revisit if

Services become internet-addressable without a trusted broker/network boundary, the threat model
requires cryptographic event provenance, or introspection latency/availability misses its SLO.

