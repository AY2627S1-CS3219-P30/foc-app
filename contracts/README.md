# contracts/

Shared wire contracts: one OpenAPI file per service, and the event schemas. Within v1, changes are
additive only.

> **Location note.** FND-03 (#117) says `packages/contracts`. The repository keeps a flat layout
> instead, with `contracts/` at the top level beside the services.

## Files

| File                            | Status                   | Owner              |
| ------------------------------- | ------------------------ | ------------------ |
| `user-service.openapi.yaml`     | Implemented              | Anselm             |
| `supplier-service.openapi.yaml` | Implemented              | Patrick            |
| `credit-service.openapi.yaml`   | Implemented              | Isaac              |
| `order-service.openapi.yaml`    | Implemented              | Zhang Yuan         |
| `chat-service.openapi.yaml`     | Implemented              | Zhang Yuan, Anselm |
| `events.schema.json`            | Generated from catalogue | —                  |

For the implemented operations, the service answers as its file says: each has a provider test
(`<service>/test/provider.contract.test.ts`), and CI fails a change that breaks a contract against
the branch's merge base (locally: `npm run test:contract`, against `origin/main`).

A WebSocket cannot be described in OpenAPI. The Chat Service's notify-only socket (`/socket`,
#346) is documented in its contract's description and, in full, in
[chat-service/README.md](../chat-service/README.md#the-socket). Its frames carry no data beyond an
errand's ID and latest message number; everything else is read through the routes in the file.

`events.schema.json` is generated from `platform/src/events/catalogue.ts` by `npm run
contracts:events`; do not edit it by hand. CI fails a pull request that changes any file here
incompatibly (removed or redefined required field, removed operation, newly required request
field). See [docs/testing.md](../docs/testing.md#contract-checks-ei-nfr311).

A breaking change the team accepts goes in `approved-breaking-changes.json`: the exact line the
check prints, the pull request, why, and who reviewed it. The check lets through only those lines. An entry can be deleted once its pull request has merged and main has been pushed
again, since no later base still has the old contract.

## Cross-service conventions (FND-03)

Agreed in FND-03 and followed by every service and contract.

| Topic              | Proposal                                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Error envelope     | `{ "error": { "code", "message", "correlationId", "details": [{ "field", "code", "message" }] } }`. `code` is a stable SCREAMING_SNAKE machine code; clients never parse `message`.                                             |
| Status codes       | 401 unauthenticated · 403 forbidden · 404 absent · 409 state conflict · 422 validation/business rule · 429 rate limited · 503 dependency down (callers fail closed). Matches plan §3.5.                                         |
| Auth header        | `Authorization: Bearer <JWT>`. JWT claims: `sub`, `sid`, `iat`, `exp`, `jti` only — **no role or status**.                                                                                                                      |
| Caller identity    | Services verify the JWT, then ask the User Service `GET /internal/introspect` (`X-Service-Key`) for the account's status and roles. A good answer is cached ≤ 5 s, a failure never. `auth-client/` does this for every service. |
| Service credential | `X-Service-Key: <per-service secret>` on `/internal/**`. User tokens are not accepted there.                                                                                                                                    |
| IDs                | UUID strings (v7 preferred for index locality).                                                                                                                                                                                 |
| Timestamps         | RFC 3339, UTC, e.g. `2026-09-21T08:30:00Z`.                                                                                                                                                                                     |
| Pagination         | Listings use `page` / `pageSize`; immutable ledgers use opaque `cursor` / `limit` so concurrent appends cannot shift later pages. Limits default to 20 and are capped at 100.                                                   |
| Correlation        | Read `X-Correlation-Id`, generate one if absent, echo on the response, include in every log line and event.                                                                                                                     |
| Ports              | Browsers reach every service through the edge at `/api/<service>`. Inside the stack: user `3001`, supplier `3002`, order `3003`, credit `3004`, chat `3006` (from `compose.yaml`).                                              |

## Event envelope (EVT-01)

```json
{
  "eventId": "uuid",
  "eventType": "user.activated",
  "schemaVersion": 1,
  "aggregateId": "uuid",
  "occurredAt": "2026-09-21T08:30:00Z",
  "producer": "user-service",
  "correlationId": "string",
  "causationId": "string",
  "payload": {}
}
```

The schema is `platform/src/events/envelope.ts`; every field is validated on send and on receive. The
plan's optional `aggregateVersion` was left out. Where order matters, the payload says it:
`order.status-changed` carries the errand's `orderVersion`, and a reader ignores a change at or below
the one it applied. See the root README's [envelope](../README.md#the-envelope).

### Events published by the User Service

| `eventType`         | When                                  | Payload (schemas: `platform/src/events/catalogue.ts`) |
| ------------------- | ------------------------------------- | ----------------------------------------------------- |
| `user.activated`    | Exactly once, on first activation     | `{ userId, activatedAt }`                             |
| `user.suspended`    | Each transition into `SUSPENDED`      | `{ userId, status, reasonRef, occurredAt }`           |
| `user.reactivated`  | Each transition back to `ACTIVE`      | `{ userId, status, reasonRef, occurredAt }`           |
| `user.role-changed` | Each `ADMIN` grant or revoke (USR-07) | `{ userId, roles, reasonRef, occurredAt }`            |

> The names are the shared catalogue's routing keys (EVT-01), which settled the earlier conflict between the
> execution plan's `UserStatusChanged` and the backlog's `UserSuspended` / `UserReactivated`: the backlog's two events,
> named by the catalogue's convention.

### Order/Credit terminal-operation events

The executable Zod schemas live in `platform/src/events/catalogue.ts`. All request facts are restated
in the reply so Order can compare the response to the command it recorded. Resulting balances are
snapshots captured in the same transaction as the movement and are replayed unchanged when a reply
is lost.

| `eventType`                  | Producer         | Payload                                                                  |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `order.completion-requested` | `order-service`  | `{ orderId, requesterId, courierId, amount }`                            |
| `credit.transferred`         | `credit-service` | Request facts plus `{ transactionId, requesterBalance, courierBalance }` |
| `order.release-requested`    | `order-service`  | `{ orderId, requesterId, amount }`                                       |
| `credit.released`            | `credit-service` | Request facts plus `{ transactionId, requesterBalance }`                 |

Each balance is `{ available, reserved, total }`, with non-negative whole numbers and
`total = available + reserved`. Credit accepts both commands only from an envelope claiming
`order-service`; deployments must pair that check with producer-specific RabbitMQ credentials/ACLs,
as described in ADR 0004.

## Questions settled during the build

Asked of Jonus and Patrick while the first drafts were written; each is now answered in the code.

0. **Domain error codes.** Settled: an `ApiException` carries its own `code` and `details`, and the
   status-derived code is only the fallback (`platform/src/errors.ts`;
   [ADR 0005](../docs/adr/0005-error-contract.md)).
1. **`preferredMode` on the profile.** Settled: it stays on the profile, and the web app's requester
   and courier switch sets it.
2. **The same site for a `SameSite=Strict` refresh cookie.** Settled for the local stack: the web app
   and the APIs are all on `localhost`, which is one site whatever the port. It would not hold for a
   web app on its own domain (a `*.vercel.app` one, say); the edge proxy
   ([PLT-10 #285](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/285)) puts everything on one
   origin.
3. **JWT signing and key distribution.** Settled: EdDSA (Ed25519), with the public keys at
   `GET /.well-known/jwks.json`, now in the spec
   ([ADR 0004](../docs/adr/0004-authentication-and-trust.md)). How services cache the keys and pick
   up a new one is in [auth-client: Key rotation](../auth-client/README.md#key-rotation).
4. **The OpenAPI to types generator.** Settled: `openapi-typescript` and `openapi-fetch`
   (`web-app/scripts/generate.ts`); the web app's tests fail if the generated types fall behind a
   contract.
5. **`GET /suppliers` as a page.** Settled: SUP-02 merged, and the listing answers
   `{ items, page, pageSize, total }`.

The participant chat browser client (#161) generates `web-app/src/lib/generated/chat-service.ts`
from the chat contract and calls all four operations through `/api/chat` at the edge. It accepts
both send success statuses, preserves `Retry-After` on errors, uses GET pagination for reconnect
catch-up, and never sends or marks read in the admin console. See the
[web app chat notes](../web-app/README.md#participant-chat-n12-161) for state and deployment details.
