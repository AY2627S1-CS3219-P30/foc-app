# Order Service — remaining lifecycle plan

Agreed 2026-10-08. Covers the work left after #152/#165: a "my errands" list, ORD-11 (#171),
ORD-10 (#170) and ORD-06 (#149). The transition table in `src/orders/order-state-machine.ts`
already declares every rule these tickets need; what is missing is the endpoints, timers, consumers
and context that let them fire.

Out of scope here: ORD-12 (#181, latency), NTH-02 (#162, chat), ORD-08 (#131, snapshot sign-off),
and per-service internal keys in User Service (a separate hardening ticket if wanted).

## Decisions

| #   | Decision                                                                                                                                                                                                                          | Why                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Four PRs in order: my errands → ORD-11 → ORD-10 → ORD-06                                                                                                                                                                          | ORD-10 and ORD-06 raise referrals into ORD-11; ORD-06 needs ORD-10's delivery deadline                                                                                              |
| 2   | Each referral is **auto-assigned** to one admin, who alone reads its private details and decides it                                                                                                                               | OS-FR2.1.2 limits private reads to the admin an errand is "referred to"                                                                                                             |
| 3   | Conflict of interest: anyone who appears in the errand's history as requester or courier (including a courier who withdrew or timed out) can be neither assigned nor decide — `403 CONFLICT_OF_INTEREST`                          | D3 feedback on #171                                                                                                                                                                 |
| 4   | One admin decides, with a required reason. No two-person rule, no password re-entry. No separate audit process: the history row (admin, reason, time) is the record, and one read-only admin route shows decisions to the console | OS-FR9.1.1 needs the reason; ADM-02 needs decisions visible                                                                                                                         |
| 5   | The delivery period (2h) and auto-confirmation (24h) deadlines are **saved on the order** when it moves, and returned in the private view. The pickup timer is left as it is                                                      | ADR 0006: a config change must not move an existing deadline; the UI needs both times (#170 feedback, WEB-05)                                                                       |
| 6   | Whether a user is suspended is **asked of User Service** (`GET /internal/users/:id`) when a rule needs it; Order keeps no copy                                                                                                    | User Service stays the only source of account status                                                                                                                                |
| 7   | User Service gains `GET /internal/admins` (active admin IDs) behind the existing `ServiceKeyGuard`. Any keyed service can call it; it reveals no more than `/internal/users/:id` already does                                     | Order needs the admin list to assign referrals                                                                                                                                      |
| 8   | "Fewest referrals" = undecided disputes currently assigned; ties go to the lower all-time count, then the lower user ID                                                                                                           | Spreads current load; deterministic for tests                                                                                                                                       |
| 9   | The move to `DISPUTED` commits with no admin; the lifecycle scheduler assigns one on its next run (≤10s), retrying while User Service is down. No eligible admin → one `REFERRAL_UNASSIGNED` operator alert                       | A referral never fails because User Service is down                                                                                                                                 |
| 10  | Each scheduler run checks every assigned admin on an undecided dispute (`/internal/users/:id/permissions`) and clears the assignment if they can no longer act; decision 9 then reassigns it                                      | No dispute stuck with a suspended or demoted admin; no dependency on ORD-06                                                                                                         |
| 11  | The `user.suspended` handler confirms the suspension with User Service before acting, and does nothing if the user is active again                                                                                                | A stale or forged message cannot cancel errands. If User Service is down past the retries (~81s) the message is set aside; timeouts still close the errands and no credits are lost |
| 12  | One `GET /orders/mine`: errands where the caller is requester or current courier, each with `myRole`, newest change first, at most 100, no paging yet                                                                             | WEB-02/03/05 dashboards; add paging when one student passes 100                                                                                                                     |
| 13  | A receipt's `delivered_at` may be null, for an errand an admin completed before any delivery was recorded                                                                                                                         | Otherwise the receipt insert fails and the transfer confirmation loops forever (`order_receipts.delivered_at` is `NOT NULL` today)                                                  |

## How each PR is built

Test-first (`/tdd`), at these agreed seams only; in-memory tests, no new `*.postgres.test.ts`:

| Seam             | Reached through                                        | Used for                                          |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------- |
| HTTP endpoints   | `test/helpers/app.ts`                                  | every command, read and refusal                   |
| Message handlers | the consumer's handler method, called with an envelope | Credit replies, `user.suspended`                  |
| Scheduler        | `LifecycleScheduler.sweep()`                           | every timer and the admin assignment jobs         |
| User Service     | the new client's fetch injection token                 | admin list, permissions, suspended or not, outage |

Each PR section ends with a **Done when** block: paste it as `/goal` once the seams are agreed.
The existing `*.postgres.test.ts` suites show as skipped; that is expected.

## PR A — My errands (no ticket yet)

- `GET /orders/mine` in `orders.controller.ts`, declared **before** `GET /orders/:id` (else `mine`
  is parsed as an order ID and refused with 400).
- `OrdersRepository.listMine(userId)`: `requester_id = $1 OR courier_id = $1`, ordered by
  `updated_at DESC, order_id`, limit 100. Each row through `projectOrder` plus
  `myRole: 'REQUESTER' | 'COURIER'`.
- Tests: requester sees their pending and rejected errands; a withdrawn courier does not see the
  errand; unrelated student sees nothing. Provider contract check.
- Docs: `contracts/order-service.openapi.yaml`, README.

**Done when**

```
/goal PR A in order-service/PLAN.md is done: every test listed under PR A exists; after the last code edit this session ran `npm run typecheck -w @foc/order-service`, `npm run lint`, `npm test -w @foc/order-service` and `npm run test:contract`, each exiting 0 with 0 failed tests; contracts/order-service.openapi.yaml, order-service/README.md and PROJECT_PR_CONTEXT.md are updated; all work is committed on the current branch.
```

## PR B — ORD-11 (#171) administrator referral and decision

**User Service** (reviewed by Anselm)

- `GET /internal/admins` in `user-service/src/users/internal.controller.ts` → `{ items: [{ userId }] }`
  for active admins. Test and `contracts/user-service.openapi.yaml` entry.

**Migration 0010**

- `order_status_history.reason text NULL`.
- `order_receipts.delivered_at` nullable (decision 13); `OrderReceipt.timestamps.deliveredAt: string | null`.
- `REFERRAL_UNASSIGNED` added to `order_operator_alerts_kind_enum`.

**Code**

- `src/orders/user-directory.client.ts`, modelled on `credit-status.client.ts`:
  `listAdmins()` and `permissions(userId)`, using the existing `USER_SERVICE_URL` and
  `INTERNAL_SERVICE_KEY`. Any failure → "unavailable", never a guess.
- `transitionUsing` fills `reasonProvided` from the command and writes `reason` to the history row.
- Assignment, in `lifecycle.scheduler.ts`, each run:
  1. For each `DISPUTED` errand with an admin: if `permissions` says they can no longer act, clear
     `referred_admin_id` (history `ADMIN_UNASSIGNED`).
  2. For each `DISPUTED` errand with no admin: from `listAdmins()`, drop anyone in the errand's
     history, pick per decision 8, set `referred_admin_id` under the row lock (history
     `ADMIN_ASSIGNED`).
     Both bump the version (so a replaced admin's stale decision gets 409), write a history row with
     `previous_status = new_status = 'DISPUTED'` and actor `SYSTEM`, and emit no status message. If
     no admin is eligible, raise `REFERRAL_UNASSIGNED` once.
- Endpoints in `admin-orders.controller.ts` (`@AdminOnly()`):
  - `GET /admin/orders/referred` — the caller's assigned disputes with private details, plus every
    unassigned dispute without them, each with the history action that referred it.
  - `POST /admin/orders/:id/resolve` — `{ outcome: 'COURIER' | 'REQUESTER', reason (1–500 chars,
trimmed), expectedVersion }` → `RESOLVE_FOR_COURIER` / `RESOLVE_FOR_REQUESTER`.
    Participant → `403 CONFLICT_OF_INTEREST`; any admin other than the assigned one →
    `403 NOT_REFERRED_ADMIN`; repeat or stale → `409`.
  - `GET /admin/orders/decisions` — newest 100 decision history rows: order, admin, outcome,
    reason, time.

**Tests**

- A repeated or stale resolve → `409`, and still only one credit request in the outbox.
- Conflict of interest refused at assignment and at decision; a different admin is assigned.
- Assigned admin suspended (fake directory) → cleared and reassigned on the next run.
- No eligible admin → one alert, however many runs.
- Resolve for courier on a dispute raised from `PICKED_UP` → transfer confirmed → `COMPLETED`
  with a receipt whose `deliveredAt` is null.
- Extend `order-mutation-matrix.test.ts` and `order-privacy.test.ts` with the new routes and the
  assigned / unassigned / replaced admin.

**Done when**

```
/goal PR B in order-service/PLAN.md is done: every test listed under PR B exists; after the last code edit this session ran `npm run typecheck -w @foc/order-service`, `npm run typecheck -w @foc/user-service`, `npm run lint`, `npm test -w @foc/order-service`, `npm test -w @foc/user-service` and `npm run test:contract`, each exiting 0 with 0 failed tests; contracts/order-service.openapi.yaml, contracts/user-service.openapi.yaml, order-service/README.md and PROJECT_PR_CONTEXT.md are updated; all work is committed on the current branch.
```

## PR C — ORD-10 (#170) requester outcome actions and auto-confirmation

**Migration 0011**

- `orders.non_delivery_report_at`, `orders.auto_confirm_at` (nullable `timestamptz`); partial
  index on `auto_confirm_at WHERE status = 'DELIVERED'`.
- Backfill errands already `PICKED_UP` / `DELIVERED` with the D1 defaults (2h / 24h), since a
  migration cannot read the environment.

**Config**: `DELIVERY_PERIOD_MS`, `AUTO_CONFIRM_MS`, required; `compose.yaml` sets
`7200000` / `86400000`; README env table.

**Code**

- `RECORD_PICKUP` sets `non_delivery_report_at = at + DELIVERY_PERIOD_MS`; `RECORD_DELIVERY` sets
  `auto_confirm_at = at + AUTO_CONFIRM_MS` (passed as the command `patch` from the service).
- `transitionUsing` fills `deliveryPeriodPassed` from `non_delivery_report_at <= now`.
- `POST /orders/:id/report-non-delivery` and `POST /orders/:id/report-non-receipt` through `run()`.
- Private view returns `nonDeliveryReportAt` and `autoConfirmAt`.
- Scheduler: `DELIVERED` past `auto_confirm_at` → `AUTO_CONFIRM`, re-checked under the lock.

**Tests**

- Auto-confirm requests the transfer exactly once.
- Confirm then auto-confirm, auto-confirm then confirm, and report then auto-confirm → one outcome
  each; the later one is refused or skipped, and only one credit request is in the outbox.
- Report non-delivery before 2h → 409; after → `DISPUTED`.
- A disputed errand ignores every timer.

**Done when**

```
/goal PR C in order-service/PLAN.md is done: every test listed under PR C exists; after the last code edit this session ran `npm run typecheck -w @foc/order-service`, `npm run lint`, `npm test -w @foc/order-service` and `npm run test:contract`, each exiting 0 with 0 failed tests; DELIVERY_PERIOD_MS and AUTO_CONFIRM_MS are in compose.yaml and the README env table; contracts/order-service.openapi.yaml, order-service/README.md and PROJECT_PR_CONTEXT.md are updated; all work is committed on the current branch.
```

## PR D — ORD-06 (#149) participant suspension

**Code**

- Durable queue `foc.order.user-suspensions` bound to `user.suspended`, `withInbox`, producer
  `user-service`. The handler confirms with `GET /internal/users/:id` (add `lookup(userId)` to the
  directory client) and stops if the user is active. Otherwise it locks the user's active errands
  in `order_id` order (no deadlock with a concurrent suspension of the other participant) and
  applies, through `transition()`:

  | User is   | Errand in                                  | Action                   | Result                                                                     |
  | --------- | ------------------------------------------ | ------------------------ | -------------------------------------------------------------------------- |
  | Requester | `OPEN`, `ACCEPTED`                         | `REQUESTER_SUSPENDED`    | `RELEASE_PENDING_CREDIT` (cancelled)                                       |
  | Requester | `PICKED_UP`, past `non_delivery_report_at` | `DELIVERY_PERIOD_PASSED` | `DISPUTED`                                                                 |
  | Courier   | `ACCEPTED`                                 | `COURIER_SUSPENDED`      | `OPEN`; deadline += `now − accepted_at`; courier and `accepted_at` cleared |
  | Courier   | `PICKED_UP`                                | `COURIER_SUSPENDED`      | `DISPUTED`                                                                 |

  Anything else is left alone (delivered errands continue and auto-confirm; CS-FR1.2.1).

- `timestampPatch` treats `COURIER_SUSPENDED` → `OPEN` like a withdrawal, plus the deadline extension.
- Reservation consumer moves onto `transition()`. On `credit.reserved` it asks User Service
  whether the requester is suspended (`requesterSuspended` context). If User Service is down it
  throws: the message is retried and then set aside, and reconciliation re-sends the reservation
  request after `CREDIT_WAIT_TIMEOUT_MS`, so the errand still converges. Never "assume active".
- Scheduler: `PICKED_UP` past `non_delivery_report_at` → ask User Service about the requester →
  `DELIVERY_PERIOD_PASSED` if suspended.

**Tests**

- Each of the five #149 branches gives exactly its outcome, with the action recorded in history.
- No credits move except through the requester-suspended cancellation.
- Duplicate message → no second change; message for a user active again → no change.
- User Service down: suspension message and reservation reply both retry and change nothing.
- Requester suspended while `PENDING_CREDIT` → reservation arrives → released (cancelled).

**Done when**

```
/goal PR D in order-service/PLAN.md is done: every test listed under PR D exists; after the last code edit this session ran `npm run typecheck -w @foc/order-service`, `npm run lint`, `npm test -w @foc/order-service` and `npm run test:contract`, each exiting 0 with 0 failed tests; order-service/README.md (including the Messages and Next tickets sections) and PROJECT_PR_CONTEXT.md are updated; all work is committed on the current branch.
```

## Known limits (`ponytail:` comments in code)

- A courier who accepts within the ≤5s identity-cache window right after their suspension was
  processed keeps the errand until the pickup timeout.
- A `PICKED_UP` errand past 2h whose requester is active is re-checked with User Service on every
  scheduler run.
- The pickup timer still reads `PICKUP_TIMEOUT_MS` at sweep time rather than a saved deadline
  (ADR 0006); left alone because it is tested and behaves the same unless the config changes.

## Every PR

Branch from `order-service`, after merging `main` into it so it carries the earlier PRs. Open the
PR against `main`.

README (transition notes, env, endpoints), `contracts/order-service.openapi.yaml`,
`PROJECT_PR_CONTEXT.md`, in-memory tests at the agreed seams, one non-author review. You open the
PR yourself.
