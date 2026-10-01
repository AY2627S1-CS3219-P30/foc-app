# State Table
**Order lifecycle.** The Order Service requirements refer to the states and transitions below. Any transition not listed is not permitted. The last column is what the web app shows for each state.

| State | Meaning | Final | Web app shows |
| ----- | ----- | :---: | ----- |
| PENDING\_CREDIT | The request is submitted and waiting for the Credit Service to reserve its reward. Couriers cannot see it. | No | Waiting for credits |
| OPEN | The reward is reserved and the order is waiting for a courier to accept it. | No | Open |
| ACCEPTED | A courier is assigned and the order is waiting for pickup. | No | Accepted |
| PICKED\_UP | The courier has collected the items and the order is waiting for delivery. | No | In transit |
| DELIVERED | The courier has recorded delivery and the order is waiting for the requester to confirm receipt or report non-receipt. | No | Delivered, confirm receipt |
| DISPUTED | The order is referred to an administrator and is waiting for their decision. | No | With an administrator |
| COMPLETION\_PENDING\_CREDIT | Delivery is accepted and the order is waiting for the Credit Service to transfer the reward to the courier. | No | Paying the courier |
| RELEASE\_PENDING\_CREDIT | The order is ending without payment and is waiting for the Credit Service to return the reward to the requester; the order records a release reason of cancelled or expired. | No | Returning credits |
| REJECTED | The reward could not be reserved and no credits are held. | Yes | Not placed |
| COMPLETED | The reward has been transferred to the courier. | Yes | Complete |
| CANCELLED | The reward has been returned to the requester after a cancellation or a dispute resolved for the requester. | Yes | Cancelled |
| EXPIRED | The reward has been returned to the requester because the acceptance deadline passed without a courier keeping the order. | Yes | Expired |

The web app's mock data has only five statuses today (`open`, `accepted`, `in_transit`, `complete`, `cancelled`); the other seven arrive when it is wired to this service.

# Transition Table
**Guard** is what must also be true, beyond the order being in the From state and the actor being allowed. If a guard fails, the order does not change and the caller is refused. Every student and administrator action also needs an active account: a suspended caller is refused before any guard is checked. A reply from the Credit Service is acted on only if it names the same order and amount the request did.

**Emits** is what the transition sends, written to the outbox in the same transaction (see *Sending and receiving safely*). Every transition sends `order.status-changed`. A transition into a `*_PENDING_CREDIT` state also sends the request that state waits for.

| From | Trigger | Actor | Guard | To | Emits |
| ----- | ----- | ----- | ----- | ----- | ----- |
| PENDING\_CREDIT | Reward reserved | Credit Service | Requester not suspended | OPEN | `order.status-changed` |
| PENDING\_CREDIT | Reward reserved | Credit Service | Requester suspended while waiting | RELEASE\_PENDING\_CREDIT (cancelled) | `order.release-requested`, `order.status-changed` |
| PENDING\_CREDIT | Reservation rejected | Credit Service | — | REJECTED | `order.status-changed` |
| OPEN | Accept | Student | Actor is not the requester; acceptance deadline not passed | ACCEPTED | `order.status-changed` |
| OPEN | Cancel | Requester | — | RELEASE\_PENDING\_CREDIT (cancelled) | `order.release-requested`, `order.status-changed` |
| OPEN | Requester suspended | System | — | RELEASE\_PENDING\_CREDIT (cancelled) | `order.release-requested`, `order.status-changed` |
| OPEN | Acceptance deadline passes | System | — | RELEASE\_PENDING\_CREDIT (expired) | `order.release-requested`, `order.status-changed` |
| ACCEPTED | Record pickup | Assigned courier | — | PICKED\_UP | `order.status-changed` |
| ACCEPTED | Cancel | Requester | — | RELEASE\_PENDING\_CREDIT (cancelled) | `order.release-requested`, `order.status-changed` |
| ACCEPTED | Requester suspended | System | — | RELEASE\_PENDING\_CREDIT (cancelled) | `order.release-requested`, `order.status-changed` |
| ACCEPTED | Withdraw or pickup timeout | Assigned courier (withdraw) or System | Acceptance deadline not passed | OPEN | `order.status-changed` |
| ACCEPTED | Withdraw or pickup timeout | Assigned courier (withdraw) or System | Acceptance deadline passed | RELEASE\_PENDING\_CREDIT (expired) | `order.release-requested`, `order.status-changed` |
| ACCEPTED | Courier suspended | System | — | OPEN, with the acceptance deadline extended by the time the courier held the order | `order.status-changed` |
| PICKED\_UP | Record delivery | Assigned courier | — | DELIVERED | `order.status-changed` |
| PICKED\_UP | Report non-delivery | Requester | Delivery period since pickup has passed | DISPUTED | `order.status-changed` |
| PICKED\_UP | Delivery period passes, or requester suspended | System | Requester suspended and delivery period passed | DISPUTED | `order.status-changed` |
| PICKED\_UP | Courier suspended | System | — | DISPUTED | `order.status-changed` |
| DELIVERED | Confirm receipt | Requester | — | COMPLETION\_PENDING\_CREDIT | `order.completion-requested`, `order.status-changed` |
| DELIVERED | Auto-confirmation period passes | System | — | COMPLETION\_PENDING\_CREDIT | `order.completion-requested`, `order.status-changed` |
| DELIVERED | Report non-receipt | Requester | — | DISPUTED | `order.status-changed` |
| DISPUTED | Resolve for courier | Administrator | A reason is given | COMPLETION\_PENDING\_CREDIT | `order.completion-requested`, `order.status-changed` |
| DISPUTED | Resolve for requester | Administrator | A reason is given | RELEASE\_PENDING\_CREDIT (cancelled) | `order.release-requested`, `order.status-changed` |
| COMPLETION\_PENDING\_CREDIT | Transfer confirmed | Credit Service | — | COMPLETED | `order.status-changed` |
| RELEASE\_PENDING\_CREDIT | Release confirmed | Credit Service | Recorded reason is cancelled | CANCELLED | `order.status-changed` |
| RELEASE\_PENDING\_CREDIT | Release confirmed | Credit Service | Recorded reason is expired | EXPIRED | `order.status-changed` |

# Timers
The periods come from the D1 backlog and are configurable.

| Timer | Starts when | Length | When it runs out |
| ----- | ----- | ----- | ----- |
| Acceptance deadline | The order becomes OPEN | 60 minutes | An OPEN order expires. An ACCEPTED order keeps its courier, but a later withdrawal or pickup timeout expires it instead of reopening it. A courier suspension extends the deadline by the time that courier held the order. |
| Pickup | A courier accepts | 30 minutes | The courier is removed, handled as a withdrawal. |
| Delivery | The courier records pickup | 2 hours | The requester may report non-delivery. If the requester is suspended, the order is referred automatically, at the end of the period or at the suspension if the period has already passed. |
| Auto-confirmation | The courier records delivery | 24 hours | Receipt is confirmed. |
| Credit wait | The order enters PENDING\_CREDIT | 5 minutes | An operator is alerted. The order is not rejected, and still opens if the reservation arrives. |

# Waiting for the Credit Service
While an order is in any `*_PENDING_CREDIT` state, no participant action, administrator action or timer changes it; only the Credit Service's reply does.

- **Credit Service down.** Requests wait in the broker. The order moves on once the Credit Service replies; nobody has to resubmit.
- **Transfers and releases do not fail as a business outcome.** The credits are already reserved, so a transfer or release has no reason to be refused. A missing reply leaves the order pending for retry or support handling (D1 OS-FR5.1.2); reconciliation (ORD-09) re-sends the same request, which the Credit Service applies at most once.
- **Messages that cannot be processed** are retried five times and then dead-lettered for an operator. They are never dropped.
- **The release reason** (cancelled or expired) is kept on the order. The Credit Service does not need it and does not send it back.

# Services it talks to

| Service | How | What for |
| ----- | ----- | ----- |
| Credit Service | Messages, both directions | Reserve, transfer and return each order's reward. Every `*_PENDING_CREDIT` state is waiting for one of its replies. |
| User Service | HTTP, through `@foc/auth-client` | Who is calling, whether they are an administrator, and that their account is active. Checked on every request; a suspension takes effect within 5 seconds. |
| User Service | Messages, received | Suspensions, which drive the "requester suspended" and "courier suspended" transitions. |
| Supplier Service | HTTP, `GET /suppliers/:id` | At creation: refuse an inactive supplier and keep a copy of the supplier on the order, so it survives later changes. The call carries the requester's own token, so the Supplier Service needs no service-to-service route. |
| Web app | HTTP | Every student and administrator command and query. |
| Any listener | Messages, sent | Each status change, for live updates and chat. It carries no private details. |

## Messages

Routing keys and executable payload schemas are in `platform/src/events/catalogue.ts`. Reservation,
completion/transfer and release messages are catalogued; order-status payloads remain proposed until
the Order lifecycle implementation adds them.

| Message | Direction | Carries | Schema |
| ----- | ----- | ----- | ----- |
| `order.reservation-requested` | Sent | order, requester, amount | In catalogue |
| `credit.reserved` | Received | order, requester, amount, restated so the reply can be checked against the request | In catalogue |
| `credit.reservation-rejected` | Received | the same, plus the reason: insufficient credits (with the available balance) or amount out of range | In catalogue |
| `order.completion-requested` | Sent | order, requester, courier, amount | In catalogue |
| `credit.transferred` | Received | request facts, transfer reference, and both resulting wallet balances (D1 OS-FR5.1.3) | In catalogue |
| `order.release-requested` | Sent | order, requester, amount | In catalogue |
| `credit.released` | Received | request facts, release reference, and requester resulting balance | In catalogue |
| `order.status-changed` | Sent | order, previous status, new status, when; no private fields | In catalogue |
| `user.suspended` | Received | user | In catalogue |

## Sending and receiving safely

- **Sending.** A transition that sends a message writes it to this service's outbox table in the same database transaction as the status change. Nothing calls the publisher directly. The shared relay from EVT-02 (#135) publishes each row after commit, so a crash between saving and sending delays the message but never loses it. The outbox table arrives with the first order migration (ORD-01, ORD-02).
- **Receiving.** Each received message's id is recorded in the same transaction as the transition it causes, so a redelivered reply changes nothing (EVT-02).
- **Dependency.** The User Service already writes catalogue-validated suspension events to its outbox, and the shared relay publishes them when RabbitMQ is configured (as it is in Compose). The remaining work is the Order Service consumer and its suspension transition handling; until those are implemented, suspension events do not change orders.

## Persistence and projections

The generated migration under `order-service/drizzle/` creates the Order-owned `orders`,
`order_status_history`, `order_idempotency_keys`, `processed_events`, and `outbox_events` tables.
Database constraints enforce the closed
status set, reward range, non-empty item list, version counter, terminal rejection shape, and the
courier required by assigned/delivery states. `order_status_history` records the previous and new
status, action, actor, order version, and timestamp; one history row is permitted per order version.

`src/orders/order-state-machine.ts` is the executable source for transition, actor, guard, and emitted
event rules. The generated matrix test evaluates every status × action × actor combination and checks
reachability and exits, while the table above remains its human-readable counterpart. XState is not
used: the lifecycle is a finite declarative table and introducing another runtime would add a second
representation without improving the current guard model. Revisit this if parallel/nested states are
introduced.

`GET /orders/:id` returns an authenticated projection. Exact delivery instructions and participant IDs
are visible only to the requester, assigned courier, or the administrator named by a referral.
`PENDING_CREDIT` and `REJECTED` errands are private to their requester, and absent resources and
hidden private resources both return `404` to avoid revealing their existence. The complete schema is in
`contracts/order-service.openapi.yaml`.

`POST /orders` requires an active authenticated requester and an `Idempotency-Key`. It validates the
entire request, fetches an active Supplier and captures its snapshot, then commits the private
`PENDING_CREDIT` row, initial history, idempotency claim, public status fact, and
`order.reservation-requested` outbox row in one transaction. A replay with the same requester, key,
and body returns the recorded order without contacting Supplier again; reuse with different facts is
refused. The shared relay publishes committed rows after the transaction, so Credit downtime delays
opening but never rejects or loses the errand. Credit's validated reply moves the row to `OPEN` with
its acceptance deadline or to terminal `REJECTED` with the recorded reason and available balance.
The transactional inbox and business-state check make 100 duplicate replies one transition.

`CREDIT_WAIT_TIMEOUT_MS` defines when #150 reconciliation must consider a `PENDING_CREDIT` row stale;
creation never rejects it merely because the timer passes. `created_at`, status, and the existing
`orders_status_created_idx` provide the durable discovery boundary that recovery will consume.

`GET /orders` returns at most 100 unexpired `OPEN` errands ordered by acceptance deadline. Its
structured item summary omits item notes, exact delivery instructions, participant IDs, and every
pending or rejected order. `GET /orders/:id` gives that same public projection to an unrelated
student. A caller can explicitly request `?view=private`; only the requester, assigned courier, or
the administrator named in `referred_admin_id` receives it, and every other caller receives `403`.
ORD-11 (#171) owns setting the referral owner and deciding the dispute; this read surface only
enforces the authorization boundary.

`POST /orders/:id/accept` requires the version observed during discovery. A single conditional
`UPDATE` checks `OPEN`, that exact version, a live deadline, and that the courier is not the
requester. The winner becomes the sole courier at version + 1; history and the privacy-safe status
event commit in the same transaction. Every loser receives `409` with the current status and
version. Authentication fails closed for suspended accounts, and acceptance deliberately performs
no Credit balance check: a zero-credit student must be able to earn credits by delivering.

### Fulfilment, completion and receipt (ORD-04)

`POST /orders/:id/pickup` and `POST /orders/:id/deliver` (assigned courier) and
`POST /orders/:id/confirm-receipt` (requester) each take `{ "expectedVersion" }`. Every lifecycle
command after acceptance goes through one repository path: it locks the row, resolves the caller's
role against the order (requester, assigned courier, other student, administrator), asks the
executable transition table for a decision, and only then writes the version-checked update, the
history row and every emitted event in one transaction. A caller who may never do the action gets
`403 ACTION_FORBIDDEN`; a wrong state gets `409 INVALID_ORDER_STATE`; a stale version gets
`409 ORDER_CHANGED`. Each carries the current status and version, and none of them changes anything.

Confirmation moves the order to `COMPLETION_PENDING_CREDIT` and writes `order.completion-requested`
(order, requester, courier, reward) to the outbox. No participant, administrator or timer action
exists from that state in the transition table, so only Credit's reply can move it (OS-FR7.1.3).
`credit.transferred` is accepted only from `credit-service`, through the transactional inbox, and
only if it restates the recorded requester, courier and amount. A mismatch, an unknown order, or an
order not waiting for a transfer changes nothing and is dead-lettered for an operator. Credit has
no transfer-failure event, so an unconfirmed transfer simply stays pending. A confirmation repeated
under a new event ID with the same transaction is a no-op; a different transaction is refused.

The confirming transaction records `completed_at` and the Credit transaction ID, and writes the
`order_receipts` row: order, requester, courier, supplier snapshot, reward, every state timestamp and
the Credit transaction reference (OS-FR5.1.2). `GET /orders/:id/receipt` returns it to the
participants and the referred administrator. Database triggers make `order_receipts` and
`order_status_history` append-only.

The first migration includes a deterministic demonstration errand at
`00000000-0000-4000-8000-000000000129`; after Compose is healthy, an authenticated caller can retrieve
its projection from `/orders/00000000-0000-4000-8000-000000000129`.

# UML Diagram
```mermaid
stateDiagram-v2
  direction TB

  classDef credit fill:#EEEDFE,stroke:#534AB7,color:#3C3489
  classDef final fill:#F1EFE8,stroke:#2C2C2A,stroke-width:2.5px,color:#2C2C2A

  [*] --> PENDING_CREDIT : Request submitted

  PENDING_CREDIT --> OPEN : Reward reserved<br/>(Credit Service)
  PENDING_CREDIT --> REJECTED : Reservation rejected<br/>(Credit Service)
  PENDING_CREDIT --> RELEASE_PENDING_CREDIT : Reward reserved, requester<br/>suspended meanwhile (Credit Service)<br/>reason = cancelled

  OPEN --> ACCEPTED : Accept<br/>(student other than requester)
  OPEN --> RELEASE_PENDING_CREDIT : Cancel (Requester) or<br/>requester suspended (System)<br/>reason = cancelled
  OPEN --> RELEASE_PENDING_CREDIT : Acceptance deadline passes (System)<br/>reason = expired

  ACCEPTED --> PICKED_UP : Record pickup<br/>(assigned courier)
  ACCEPTED --> RELEASE_PENDING_CREDIT : Cancel (Requester) or<br/>requester suspended (System)<br/>reason = cancelled
  ACCEPTED --> OPEN : [before deadline] Withdraw (courier)<br/>or pickup timeout (System)
  ACCEPTED --> OPEN : Courier suspended (System)<br/>deadline extended
  ACCEPTED --> RELEASE_PENDING_CREDIT : [after deadline] Withdraw (courier)<br/>or pickup timeout (System)<br/>reason = expired

  PICKED_UP --> DELIVERED : Record delivery<br/>(assigned courier)
  PICKED_UP --> DISPUTED : Report non-delivery after<br/>delivery period (Requester)
  PICKED_UP --> DISPUTED : Delivery period passes with requester<br/>suspended, or courier suspended (System)

  DELIVERED --> COMPLETION_PENDING_CREDIT : Confirm receipt (Requester) or<br/>auto-confirmation period passes (System)
  DELIVERED --> DISPUTED : Report non-receipt<br/>(Requester)

  DISPUTED --> COMPLETION_PENDING_CREDIT : Resolve for courier, with reason<br/>(Administrator)
  DISPUTED --> RELEASE_PENDING_CREDIT : Resolve for requester, with reason<br/>(Administrator)<br/>reason = cancelled

  COMPLETION_PENDING_CREDIT --> COMPLETED : Transfer confirmed<br/>(Credit Service)
  RELEASE_PENDING_CREDIT --> CANCELLED : Release confirmed, reason cancelled<br/>(Credit Service)
  RELEASE_PENDING_CREDIT --> EXPIRED : Release confirmed, reason expired<br/>(Credit Service)

  REJECTED --> [*]
  COMPLETED --> [*]
  CANCELLED --> [*]
  EXPIRED --> [*]

  class PENDING_CREDIT,COMPLETION_PENDING_CREDIT,RELEASE_PENDING_CREDIT credit
  class REJECTED,COMPLETED,CANCELLED,EXPIRED final
```

---

## Running this service

Owned by **Zhang Yuan**. Implements the errand lifecycle from creation to a terminal state.

### Prerequisites

Node 22.12 or later (`nvm use` picks it up from `.nvmrc`). Install dependencies
once from the repository root — this is an npm workspace, so a per-service
`npm install` is neither needed nor correct:

```bash
npm install
```

### Commands

Run these from the repository root.

| Command                                   | What it does                  |
| ----------------------------------------- | ----------------------------- |
| `npm run dev:order`                       | Start with reload on change   |
| `npm run build -w @foc/order-service`     | Compile TypeScript to `dist/` |
| `npm test -w @foc/order-service`          | Run PGlite tests and, with `TEST_ORDER_DATABASE_URL`, the real PostgreSQL 100-courier race |
| `npm run typecheck -w @foc/order-service` | Type-check without emitting   |
| `npm run lint`                            | Lint every service            |

### Required environment

| Variable       | Example         | Notes                                   |
| -------------- | --------------- | --------------------------------------- |
| `SERVICE_NAME` | `order-service` | Tags every log line                     |
| `PORT`         | `3003`          | Bind port                               |
| `NODE_ENV`     | `development`   | `development` \| `test` \| `production` |
| `LOG_LEVEL`    | `info`          | Defaults to `info`                      |
| `DATABASE_URL` | `postgres://…`   | Order-owned PostgreSQL database         |
| `SUPPLIER_SERVICE_URL` | `http://localhost:3002` | Supplier validation and snapshot reads |
| `CREDIT_WAIT_TIMEOUT_MS` | `300000` | Age at which pending credit needs reconciliation |
| `ACCEPTANCE_WINDOW_MS` | `3600000` | Deadline started when reservation succeeds |

A missing required variable stops the service at boot and names the variable.
Nothing falls back to an insecure default.

```bash
SERVICE_NAME=order-service PORT=3003 \
  DATABASE_URL=postgres://order_service:order_service_dev@localhost:55432/foc_order \
  SUPPLIER_SERVICE_URL=http://localhost:3002 \
  CREDIT_WAIT_TIMEOUT_MS=300000 ACCEPTANCE_WINDOW_MS=3600000 \
  npm run dev:order
curl -i http://localhost:3003/health
```

Apply the same generated migrations used by Compose with:

```bash
DATABASE_URL=postgres://order_service:order_service_dev@localhost:55432/foc_order \
  npm run db:migrate -w @foc/order-service
```

### What you get from `@foc/platform`

Importing `PlatformModule.forRoot(...)` gives this service a `GET /health`
endpoint, structured JSON logging where every line carries a correlation ID,
request logging, a shared error envelope, and graceful shutdown on `SIGTERM`.
Do not re-implement these per service — extend the shared package instead, so a
change lands once rather than four times.

### Docker

```bash
docker build -f order-service/Dockerfile -t foc/order-service .
```

The build context is the **repository root**, not this folder, because the image
needs the workspace manifests and `@foc/platform`. The image runs as a non-root
user and declares a `HEALTHCHECK`. `compose.yaml` runs it on port 3003.

### Next tickets

ORD-05 (#148) cancellation, withdrawal and expiry; ORD-09 (#150) recovery and privacy verification.
