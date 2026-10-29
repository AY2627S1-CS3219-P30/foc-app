# ADR 0005 — HTTP and event error contract

- **Status:** Proposed; implementation basis; amended 2026-10-20 and 2026-10-22 (see [Amendment](#amendment--doc-04-2026-10-20))
- **Date:** 2026-10-01
- **Deciders:** Group 30; approvals tracked in [the ADR index](README.md)
- **Ticket:** [FND-02 #183](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/183)

## Context

Clients need stable failure semantics, while internal details and transient infrastructure errors
must not leak. Asynchronous business rejections also need to be distinguished from delivery failure.

## Decision

Every HTTP failure has the shape implemented by `platform/src/errors.ts`:

```json
{"error":{"code":"WALLET_NOT_FOUND","message":"Wallet not found.","correlationId":"…","details":{}}}
```

Clients may branch on HTTP status and stable `error.code`. `message` is display text and may change;
`details` is optional and contract-specific; `correlationId` is for support. Unknown exceptions are
logged and returned as `500 INTERNAL` without their original message.

| Condition | HTTP | Stable code |
| --- | ---: | --- |
| malformed request, or an `Idempotency-Key` reused with a different request | 400/422 | `BAD_REQUEST`, `VALIDATION_FAILED` or documented domain code (`IDEMPOTENCY_KEY_REUSED`) |
| missing/invalid authentication | 401 | auth-client code |
| authenticated but unauthorized | 403 | documented domain code, otherwise `FORBIDDEN` |
| missing resource | 404 | resource-specific code, otherwise `NOT_FOUND` |
| state conflict | 409 | documented domain code, otherwise `CONFLICT` |
| throttled | 429 | `RATE_LIMITED` |
| dependency temporarily unavailable | 503 | documented domain code, otherwise `UNAVAILABLE` |

For events, a valid terminal business outcome is a catalogued reply event, such as
`credit.reservation-rejected`. A malformed, wrong-type or untrusted-producer message is dead-lettered.
A transient handler/infrastructure failure is retried and then dead-lettered; it is never converted
into a business rejection.

## Alternatives considered

- **Status codes only:** cannot distinguish domain conditions with the same status.
- **Return exception text:** unstable and can disclose secrets.
- **Treat every event failure as retryable:** wastes retry budget on malformed input.

## Consequences

New client-visible codes and event rejection reasons are contract changes and require tests. Logs
hold diagnostic detail; public responses do not.

## Amendment — DOC-04, 2026-10-20

Raised by Zhang Yuan on [#238](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/238), where the
table and the services disagreed. The services were left as they are and the table changed:

- **403 and 503** allow a documented domain code, as 400, 404 and 409 already did. The services use
  them, for example Order's `SELF_ACCEPTANCE_FORBIDDEN`, `ACTION_FORBIDDEN`,
  `PRIVATE_ORDER_FORBIDDEN`, `NOT_REFERRED_ADMIN`, `CONFLICT_OF_INTEREST`,
  `SUPPLIER_SERVICE_UNAVAILABLE` and `SUPPLIER_CONTRACT_INVALID`, and User's `ACCOUNT_SUSPENDED`,
  `ACCOUNT_NOT_ACTIVATED`, `PASSWORD_CHANGE_REQUIRED`, `CSRF_REJECTED`, `SELF_APPROVAL_FORBIDDEN`,
  `CONFLICT_OF_INTEREST`, `SELF_DEMOTION_FORBIDDEN` and `SELF_SUSPENSION_FORBIDDEN`. These are
  examples; each service's contract in `contracts/` lists all of its codes.
- **An `Idempotency-Key` reused with a different request** is a malformed request (`422
  IDEMPOTENCY_KEY_REUSED`), not a conflict: the same key with the same request replays the first
  answer, so there is nothing to conflict with. The Order Service (`POST /orders`) and the Supplier
  Service (creating a supplier) both answer 422, so moving to 409 would have been a breaking contract
  change in two services for no gain.

## Revisit if

Versioned APIs need a richer standard such as RFC 9457, or observability proves correlation IDs are
insufficient for distributed traces.

