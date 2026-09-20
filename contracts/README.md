# contracts/

Shared wire contracts (OpenAPI / AsyncAPI). Execution plan §8.1: contract changes need the producer
owner, one consumer owner, and Dev 3 or Dev 4 review; within v1, changes are additive only.

> **Location note.** FND-03 (#117) says `packages/contracts`, but execution plan §3.1 / §8.1 and the root
> `README.md` use a flat layout with a top-level `contracts/`. This folder follows the plan. If the team
> prefers `packages/`, it is a `git mv`.

## Files

| File                          | Status                                    | Owner  |
| ----------------------------- | ----------------------------------------- | ------ |
| `user-service.openapi.yaml`   | Draft 1 — awaiting review                 | Anselm |
| `supplier-service.openapi.yaml` | Not started                             | Patrick |

## Cross-service proposals for approval (FND-03 scope)

These are **proposals, not decisions**. They live here so Jonus and Patrick can approve or change them in a PR
instead of a workshop. The User Service spec is written against them.

| Topic              | Proposal                                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------------------- |
| Error envelope     | `{ "error": { "code", "message", "correlationId", "details": [{ "field", "code", "message" }] } }`. `code` is a stable SCREAMING_SNAKE machine code; clients never parse `message`. |
| Status codes       | 401 unauthenticated · 403 forbidden · 404 absent · 409 state conflict · 422 validation/business rule · 429 rate limited · 503 dependency down (callers fail closed). Matches plan §3.5. |
| Auth header        | `Authorization: Bearer <JWT>`. JWT claims: `sub`, `sid`, `iat`, `exp`, `jti` only — **no role or status**. |
| Caller identity    | Services read `sub` from the verified JWT, then call `GET /internal/users/{sub}` (`X-Service-Key`) for status and roles. Cache ≤ 5 s. Shared middleware is USR-06. |
| Service credential | `X-Service-Key: <per-service secret>` on `/internal/**`. User tokens are not accepted there.               |
| IDs                | UUID strings (v7 preferred for index locality).                                                            |
| Timestamps         | RFC 3339, UTC, e.g. `2026-09-21T08:30:00Z`.                                                                |
| Pagination         | Query `page` (≥ 1, default 1) and `pageSize` (default 20, 1–100). Response `{ items, page, pageSize, total }`. Note: offset pagination is fine at this scale; SS-FR3.1.1 in the backlog should be checked against this before freezing. |
| Correlation        | Read `X-Correlation-Id`, generate one if absent, echo on the response, include in every log line and event. |
| Port (local)       | user-service `3001`, supplier `3002` (from `compose.yaml`).                                                |

## Event envelope (proposal, for EVT-01)

```json
{
  "eventId": "uuid",
  "eventType": "UserActivated",
  "schemaVersion": 1,
  "aggregateId": "uuid",
  "aggregateVersion": 3,
  "occurredAt": "2026-09-21T08:30:00Z",
  "producer": "user-service",
  "correlationId": "string",
  "causationId": "string | null",
  "payload": {}
}
```

`aggregateVersion` is optional (plan §3.2 lists it; FND-03's scope list omits it — decide at review).

### Events published by the User Service

| `eventType`       | When                                         | Payload (see `components.schemas` in the OpenAPI) |
| ----------------- | -------------------------------------------- | -------------------------------------------------- |
| `UserActivated`   | Exactly once, on first activation            | `{ userId }`                                        |
| `UserSuspended`   | Each transition into `SUSPENDED`             | `{ userId, status, reasonRef, occurredAt }`         |
| `UserReactivated` | Each transition back to `ACTIVE`             | `{ userId, status, reasonRef, occurredAt }`         |

> **Conflict to resolve.** Execution plan §3.2 names `UserActivated` and `UserStatusChanged`. The
> submitted backlog (US-FR4.1.4) and USR-03 (#122) name `UserSuspended` and `UserReactivated`. This draft
> follows the backlog, which is the frozen document.

## Open questions for Jonus / Patrick

0. The platform's `ErrorEnvelopeFilter` derives `code` from the HTTP status only. This spec uses domain codes (`EMAIL_ALREADY_REGISTERED`, `LAST_ADMIN`, …) and structured `details`. USR-01 extends the filter additively so an exception can carry its own `code` and `details`; status-derived codes remain the fallback. Affects every service, so Jonus reviews.
1. Is `preferredMode` on the profile acceptable for the requester↔courier switch, or should the toggle be client-only?
2. Access token in memory + refresh in an `HttpOnly` cookie: does the gateway (or `web-app` dev proxy) keep API and web on the same site so `SameSite=Strict` works?
3. JWT signing: which algorithm and where does the verification key come from for other services (shared secret vs. JWKS endpoint)? Proposed: EdDSA with a JWKS at `GET /.well-known/jwks.json` — not yet in the spec.
4. Framework and runtime (PLT-01) decide the OpenAPI → types generator. The spec is generator-neutral.
