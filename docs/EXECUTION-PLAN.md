# CS3219 Complete Product and Engineering Execution Plan

**Project Group 30** · AY26/27 Semester 1
**Planning horizon:** 17 September – 11 November 2026
**Prepared:** 10 September 2026

> An implementation-ready plan covering product scope, architecture, backlog, dependencies, five developer workstreams, sprint delivery, integration, testing, risk, and launch readiness.

## Contents

0. [Executive direction](#0-executive-direction)
1. [Project reconstruction](#1-project-reconstruction)
2. [Gap analysis](#2-gap-analysis)
3. [Target state](#3-target-state)
4. [Master backlog](#4-master-backlog)
5. [Dependency analysis](#5-dependency-analysis)
6. [Five developer workstreams](#6-five-developer-workstreams)
7. [Sprint plan](#7-sprint-plan)
8. [Integration strategy](#8-integration-strategy)
9. [Testing strategy and ownership](#9-testing-strategy-and-ownership)
10. [Risk register](#10-risk-register)
11. [Decision log](#11-decision-log)
12. [Scope control and Definition of Done](#12-scope-control-and-definition-of-done)
13. [Final delivery roadmap](#13-final-delivery-roadmap)

---

## 0. Executive direction

Build a dependable campus errand marketplace in which an NUS student can request an errand, another student can claim and complete it, and a closed pool of platform credits moves exactly once. The implementation should demonstrate microservice boundaries and meaningful event-driven behavior without turning the semester project into an infrastructure project.

The plan treats the current submission as a strong requirements draft, not as evidence of completed code. No repository, deployed system, API definitions, schemas, automated tests, or runnable prototype were supplied for inspection. Therefore, the verified current state is requirements plus mockup descriptions only; implementation items below remain open until demonstrated in the repository.

**The release strategy is:**

1. Establish contracts, state machines, repository conventions, and a runnable skeleton.
2. Deliver User and Supplier services plus a responsive supplier experience for D2.
3. Implement the Order-Credit saga and full happy path for D3.
4. Add recovery, disputes, useful N2H features, observability, and evidence-producing tests.
5. Freeze scope and rehearse a deterministic D4 demo.

The selected N2H portfolio is deliberately narrow and integrated: admin/support operations, order history and reorder, participant chat with live status notifications, delivery disputes/auto-confirmation, and reliability/observability. Natural-language AI, translation, grouped runs, Kubernetes, and route navigation are deferred unless the committed release is already green.

---

## 1. Project reconstruction

### 1.1 Product objective and target users

The product is a peer-to-peer campus errand platform. It reduces the inconvenience of collecting items from campus stores, facilities, or landmarks by matching a requester with a courier. Compensation uses non-purchasable, non-withdrawable platform credits.

Primary users are active NUS students. Any active student may act as both requester and courier; the UI mode switch changes navigation, not authorization. Secondary users are administrators who maintain suppliers, review account activity, and resolve exceptional orders.

### 1.2 Core journeys

1. **Join** – student registers with an allowed campus email, activates the account, receives one wallet and 10 credits, and signs in.
2. **Request** – requester chooses a supplier, lists items, supplies a broad delivery zone plus private instructions, chooses a 1–5 credit reward, reviews the request, and submits it.
3. **Reserve and publish** – the system durably starts a reservation saga. The request is private while `PENDING_CREDIT`; it becomes `OPEN` only after the Credit Service reserves the reward.
4. **Discover and accept** – couriers browse privacy-safe open requests. One eligible courier wins an atomic claim; a requester cannot claim their own order.
5. **Fulfil** – the assigned courier marks pickup and delivery. Only valid actions for the current actor/state are exposed and accepted.
6. **Confirm and settle** – requester confirms delivery; the reserved credits transfer exactly once to the courier, and an immutable receipt is produced.
7. **Cancel, withdraw, expire, recover** – eligible cancellations release credits; courier withdrawal reopens an unexpired order; overdue open orders expire; pending financial states reconcile after failures.
8. **Review and repeat** – participants see history and wallet ledger entries and may create a fresh order from a past receipt.
9. **Communicate and support** – assigned participants can chat; users can dispute a delivered order; admins can inspect evidence and issue an outcome through the Order Service.

### 1.3 Required functionality

Confirmed mandatory capabilities are:

- Responsive web experience for requester and courier workflows.
- User Service for registration, activation, authentication, profiles, status, and RBAC.
- Supplier Service with admin CRUD/deactivation, rich seed data, search, filtering, and stable references.
- Order Service covering creation, discovery, atomic acceptance, pickup, delivery, confirmation, cancellation, withdrawal, and expiry.
- Credit Service covering initial issuance, balance/ledger, reservation, release, and transfer.
- Meaningful asynchronous/event-driven communication.
- Containerized services and supporting components with at least a local deployment.
- A single repository with one folder per microservice.

### 1.4 Evidence classification

| Classification | Items |
|---|---|
| **Confirmed** | Five-person team; responsive web app; User, Supplier, Order, and Credit microservices; closed 10-credit initial allocation proposed by D1; 1–5 credit rewards proposed by D1; 60-minute open period proposed by D1; RabbitMQ-like event workflow required conceptually; containerization; local deployment minimum; supplier seed data; no live courier tracking; vendor payment/catalogue/inventory outside scope; milestone dates and assessment expectations. |
| **Inferred** | Campus email activation needs a verifiable token flow; a gateway is useful to avoid exposing every service port; each service must own its data; order details need a supplier snapshot; a requester needs a way out when a courier never completes; a courier needs settlement protection when a requester never confirms; API/event schemas must be shared early; a repeatable demo dataset and runbook are essential. |
| **PM/engineering decisions introduced here** | TypeScript stack; React frontend; NestJS services; PostgreSQL with one logical database/user per service; RabbitMQ; thin API gateway; durable `PENDING_CREDIT` saga; `CREDIT_REJECTED` retained for support but not treated as an active errand; 24-hour auto-confirm unless disputed; explicit `DISPUTED` state; SSE for status updates and WebSocket for participant chat; structured OpenTelemetry-compatible telemetry; selected/deferred N2Hs; sprint boundaries and ownership. |
| **Unknown/unverified** | Existing repository and code state; team framework expertise; cloud budget/provider; whether NUS email delivery credentials are available; final D2/D3 appointment dates; mentor approval of N2Hs; exact prototype visuals; supplied template repository contents; CI organization permissions. |

### 1.5 Existing implementation and architecture

No implementation was available in the provided materials. The D1 document defines detailed FRs/NFRs and captions for desktop/mobile mockups, but does not establish that screens, services, containers, schemas, or tests exist. All implementation is therefore recorded as unverified/open. On day one, the team must inventory the actual repository and change task status rather than assuming greenfield work is complete.

### 1.6 Constraints and boundaries

- Vendor/item payment stays outside the platform. The request form must make the requester attest that payment or collection authorization is already arranged; credits compensate delivery only.
- No supplier menus, inventory, or checkout.
- No live courier tracking. A static map can be revisited later, but it is not in the committed plan.
- Credits are integers, cannot be bought, withdrawn, cashed out, gifted, or directly edited.
- Historical orders must survive supplier/user deactivation.
- Local Docker Compose is the reliable D4 fallback even if a cloud deployment is attempted.
- The final system must remain explainable by the team; operational technology is justified only where it demonstrates a requirement.

### 1.7 Requirements hygiene findings

The supplied D1 backlog is unusually detailed, but it is not yet safe to use as an executable source of truth. `US-FR4.1.2` is assigned twice to different requirements; the N2H section refers to `SS-FR4.1.2`, which does not exist; some requirement text mixes UI retry behavior into service semantics; and order creation simultaneously requires "no persisted record" on reservation failure and a durable asynchronous pending state. Sprint 0 must repair identifiers, add a supersession note for changed semantics, and establish one traceability matrix from official M-requirements to revised requirements, backlog IDs, code, and tests. Original submitted text should remain preserved for assessment history.

---

## 2. Gap analysis

| Gap | Why it matters | Required work | Priority | Dependencies |
|---|---|---|---|---|
| No verified implementation baseline | Estimates and milestone claims cannot be trusted without evidence | Inventory repository, run all existing code/tests, map requirements to artifacts, record owners/status | P0 | None |
| Contradictory order-creation semantics | "No record on failed reservation" conflicts with async `PENDING_CREDIT`, idempotency, and recovery | Adopt durable private pending order; publish reservation via outbox; expose 202; transition to `OPEN` or `CREDIT_REJECTED` | P0 | Architecture/state ADR |
| No frozen order state machine | Actor permissions and money movement will diverge across UI, Order, and Credit services | Write transition matrix including disputes and timeout behavior; generate tests from it | P0 | None |
| Duplicate/missing requirement identifiers | Traceability and grading evidence can point to the wrong behavior | Preserve the submitted D1 copy; issue unique IDs; replace nonexistent references; maintain old→new mapping | P0 | Repository audit |
| No API or event contracts | Five parallel workstreams otherwise block each other and integrate late | OpenAPI per service, AsyncAPI/event JSON Schemas, examples, compatibility checks, mock server | P0 | State ADR |
| No service/data ownership design | Shared tables would defeat microservice isolation and create unsafe coupling | Give each service a logical PostgreSQL DB and credentials; prohibit cross-service SQL; snapshot foreign display data | P0 | Architecture ADR |
| Unspecified identity propagation and service auth | A role toggle or forged request could bypass authorization | Signed short-lived JWT, refresh rotation, gateway validation, downstream validation, service credentials, status introspection/revocation strategy | P0 | User contract, gateway |
| Activation/email path unclear | Initial credit issuance depends on one-time activation | Implement tokenized activation with SMTP adapter and logged development mailbox; publish `UserActivated` once | P1 | User DB, broker |
| Suspended-token behavior incomplete | Existing tokens must stop sensitive actions quickly | Central introspection/revocation version cached at most five seconds; mutation endpoints fail closed | P1 | User Service, gateway |
| Supplier seed and history semantics incomplete | D2 and order receipts need stable, realistic data | Idempotent ≥30-record seed; soft deactivate; supplier snapshot on order creation | P1 | Supplier schema |
| No delivery/payment arrangement field | Courier could be asked to front real money even though payment is out of scope | Add `paymentArranged` acknowledgement and optional collection reference; forbid card/payment fields | P1 | Request UX, Order schema |
| Exact address privacy not fully modeled | Open listings may leak personal/location data | Split public `deliveryZone` from private `deliveryInstructions`; serializer/authorization tests | P0 | Order API |
| Atomic acceptance not implemented | Double assignment is a primary concurrency requirement | Conditional update on state/version/deadline and unique courier assignment; 100-way race test | P0 | Order DB |
| Financial invariant/recovery absent | Lost or duplicate messages can mint, burn, or lock credits | Ledger, transaction keys, row locks, inbox/outbox, reconciliation endpoint/job, fault tests | P0 | Credit schema, broker |
| Broker topology and failure policy undefined | "Uses messaging" is insufficient for M6/D3 | Durable exchanges/queues, routing keys, retry queues, DLQ, five-attempt policy, correlation IDs | P0 | Event contracts, Compose |
| Ordering/version behavior incomplete | Stale events could reverse visible state | Aggregate version in relevant events; inbox dedupe; ignore stale status projections; never infer financial state from order | P1 | Event envelope |
| Requester can withhold confirmation indefinitely | Courier credits could remain locked forever | Auto-confirm 24 hours after delivery unless disputed; notify participants; idempotent scheduled command | P1 | Order/Credit saga, scheduler |
| Dispute flow unspecified | "No cancellation after pickup" leaves no safe exceptional path | `DISPUTED` state, evidence/reason, admin decision through Order Service, audited settle-or-release outcome | P1 N2H | Admin auth, chat/audit |
| Courier abandonment after pickup unresolved | A requester and reservation can remain stuck | Add support escalation after SLA; no automated release after pickup; admin resolution with audit | P1 | Dispute/admin flow |
| Frontend state/error strategy undefined | Retries and optimistic actions can create duplicates or misleading UI | Typed API client, server state cache, idempotency keys, reconnect reconciliation, consistent error model | P0 | Contracts, app shell |
| No real-time progress mechanism | Async state is confusing when pages remain stale | SSE order-status stream with polling fallback; WebSocket only for chat | P1 | Gateway/event projection |
| Accessibility evidence postponed to final iteration | Late remediation can force UI rework | Keyboard/semantic/contrast checks in every component PR; automated axe scans in CI | P1 | Design system |
| No observability baseline | Async failures are otherwise invisible during demo and support | Structured logs, health/readiness, metrics for queue lag/retries/DLQ/pending age, trace/correlation propagation, dashboard | P1 | Platform scaffold |
| No security/privacy model | Campus identity, private delivery details, chat, and tokens are sensitive | Threat model, validation, rate limits, log redaction, CORS/CSRF decision, dependency/image scans, retention policy | P1 | Architecture |
| No CI/CD or quality gates | Parallel work will regress shared contracts and main | Lint/type/unit/contract/integration gates; image build and scan; protected main; preview artifacts | P1 | Repository scaffold |
| No backup/restore/rollback evidence | Persistence claims cannot be demonstrated | Volume backup/restore script and drill; immutable image tags; last-known-good Compose manifest | P2 | Stable data schemas |
| Too many proposed N2Hs | Breadth risks an incomplete mandatory product | Commit only to integrated N2Hs; place AI, translation, maps, grouped runs, Kubernetes behind launch gate | P0 product | Team decision/mentor review |
| No deterministic demo/operations package | A working product can still fail assessment due to setup or data issues | Seeded personas/scenario, one-command startup, smoke test, demo script, screenshots/video fallback, runbook | P1 | Integrated release |
| No analytics/event measurement | Team cannot show workflow reliability or locate drop-offs | Minimal product counters: created/open/accepted/completed/expired/disputed and time-to-accept/complete; no invasive tracking | P2 | Event stream/metrics |

---

## 3. Target state

### 3.1 Target architecture

```
Browser (React responsive web app)
 |
 v
API Gateway / edge routing ---- SSE/WebSocket ---- Browser
 |          |          |          |
 v          v          v          v
 User       Supplier    Order      Credit       Chat
 Service    Service     Service    Service      Service
 |          |          |          |            |
 user_db   supplier_db order_db   credit_db    chat_db
 \       |       /              /
 RabbitMQ durable event bus
 |
 retry queues + DLQ

 Cross-cutting: structured logs, metrics/dashboard, correlation IDs,
 health/readiness, CI, Docker Compose, seed/demo tooling.
```

Use a monorepo with `apps/web`, `services/user`, `services/supplier`, `services/order`, `services/credit`, `services/chat`, `gateway`, `packages/contracts`, `packages/config`, `packages/testkit`, and `infra`. The extra Chat Service is justified by independent retention, WebSocket connections, and participant authorization; if capacity drops, its first release may be a module behind the gateway without changing the public contract.

For local deployment, a single PostgreSQL server may host separate logical databases and users to save memory. Service credentials permit access only to their own database. No service reads another service's tables. RabbitMQ uses durable exchanges and queues. The gateway is thin: routing, request IDs, coarse rate limits, token verification, and streaming connection termination — not business logic.

### 3.2 Key interfaces

- REST/JSON for browser commands and queries; OpenAPI is the source of truth.
- Events use a common envelope: `eventId`, `eventType`, `schemaVersion`, `aggregateId`, `aggregateVersion` (when applicable), `occurredAt`, `producer`, `correlationId`, `causationId`, and typed payload.
- User Service publishes `UserActivated` and `UserStatusChanged`.
- Order Service publishes reservation/completion/release requests and `OrderStatusChanged` via transactional outbox.
- Credit Service publishes `CreditReserved`, `CreditReservationRejected`, `CreditsTransferred`, `CreditReleased`, and failure results via transactional outbox.
- Every consumer writes an inbox record in the same transaction as its local effect.
- Services resolve current identity through signed claims plus User authorization-state lookup for sensitive mutations; internal requests use separate service credentials.

### 3.3 Order and credit state model

```
PENDING_CREDIT --CreditReserved--> OPEN --accept--> ACCEPTED --pickup--> PICKED_UP
 |                               |                 |                    |
 +--reservation rejected-->      |                 +--withdraw--> OPEN  |
 CREDIT_REJECTED             |                                      v
 +--cancel/expiry--> *_PENDING_CREDIT  DELIVERED
 |               |
 CreditReleased         +--confirm/24h timeout-->
 v                  COMPLETION_PENDING_CREDIT
 CANCELLED / EXPIRED            |
 +--CreditsTransferred--> COMPLETED
 |
 +--dispute--> DISPUTED
 | admin settle/release
 v
 completion or cancellation pending
```

**Clarifications:**

- `PENDING_CREDIT` is durable but visible only to its requester/admin and is never discoverable.
- A permanent reservation rejection leaves a short support/history record (`CREDIT_REJECTED`) but no active errand. Retention may be limited to 30 days.
- Expiry applies only while `OPEN`. Acceptance and expiry race through the same conditional state/version update.
- Requester cancellation is allowed before pickup. Courier withdrawal from `ACCEPTED` reopens the order if still before deadline.
- After `PICKED_UP`, neither participant can directly cancel; they escalate.
- `DELIVERED` auto-confirms after 24 hours unless disputed. The timeout is a configurable product policy and must be shown in the UI.
- An admin never edits a wallet. Admin outcomes are commands to Order Service, which trigger the normal idempotent transfer/release path.

### 3.4 Data and privacy

- User Service owns credentials, roles, profile, session hashes, account status, and audit records.
- Supplier Service owns canonical suppliers and optional coordinates/tags/hours.
- Order Service stores IDs plus immutable snapshots required for receipts. Public projections exclude participant IDs and exact delivery instructions.
- Credit Service owns wallets, reservations, business transactions, immutable ledger entries, inbox, and outbox.
- Chat Service stores participant-scoped messages and moderation metadata; messages close at terminal state but remain available to participants/admin support under a documented retention period.
- Logs prefer opaque IDs over email, redact tokens/passwords/private instructions/chat text, and never carry vendor payment data.

### 3.5 Error and recovery behavior

- Validation errors return stable machine codes and field errors.
- `401` means missing/invalid session, `403` forbidden actor/resource, `404` absent or intentionally concealed resource, `409` stale state/idempotency conflict, `422` business rejection, `503` dependency unavailable, and `202` accepted asynchronous command.
- Mutations require idempotency keys. Same key/same body returns original result; same key/different body returns `409`.
- Outbox publishers retry until published; consumers acknowledge only after local commit; exhausted processing enters a DLQ with the original event.
- A reconciliation job checks old pending orders against Credit Service transaction status and reissues only existing idempotent commands. It never edits balances.
- The UI retains drafts, replaces optimistic state with authoritative results, explains pending states, and falls back from SSE to bounded polling.

### 3.6 Deployment and observability

- `docker compose up --build` starts gateway, web, five services, PostgreSQL, RabbitMQ, and the observability stack.
- Health checks distinguish liveness from readiness. A service is not ready until schema migration and mandatory dependencies are ready.
- CI runs formatting, lint, type checks, unit tests, contract compatibility, integration tests, selected E2E, dependency scan, and image build.
- Dashboards show HTTP error/latency, order counts by state, pending-state age, queue depth/lag, retries, DLQ count, and credit reconciliation failures.
- Correlation and order IDs connect the browser request to service logs and events.
- Local Compose remains the assessed fallback. Cloud deployment is a stretch only after release criteria pass.

---

## 4. Master backlog

Complexity uses **S** (≤2 ideal developer-days), **M** (3–5), **L** (6–9). An item larger than L must be split during refinement. "Parallel" names the work that can proceed concurrently after its dependencies, not permission to violate contracts.

### 4.1 Foundation, architecture, and platform

#### FND-01 — Repository/current-state audit
- **Epic:** Planning · **Priority:** P0 · **Complexity:** S · **Owner:** Dev 1
- **Description:** Inventory code, branches, template assets, runnable commands, tests, and requirement coverage; prevents false estimates.
- **Dependencies:** None · **Parallel:** Yes
- **Acceptance criteria:** Evidence table links every existing artifact and marks done/partial/missing.
- **Definition of Done:** Findings reviewed; backlog statuses updated; no user changes overwritten.

#### FND-02 — ADR pack and domain glossary
- **Epic:** Architecture · **Priority:** P0 · **Complexity:** M · **Owner:** Dev 3
- **Description:** Record service boundaries, chosen stack, data ownership, auth, saga semantics, state machine, error codes, and time policy.
- **Dependencies:** FND-01 · **Parallel:** Yes
- **Acceptance criteria:** All five developers approve ADRs; order transition matrix has actor, precondition, output/event.
- **Definition of Done:** ADRs versioned; contradictions and superseded D1 statements called out.

#### FND-03 — OpenAPI, AsyncAPI, schemas, mocks
- **Epic:** Contracts · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 3 + all
- **Description:** Freeze HTTP/event interfaces and generated types/mocks so teams can build independently.
- **Dependencies:** FND-02 · **Parallel:** No, then enables broad parallelism
- **Acceptance criteria:** All core endpoints/events have examples and error cases; compatibility check runs in CI.
- **Definition of Done:** Published package versioned; mock server consumed by web; owner review complete.

#### PLT-01 — Monorepo service scaffold
- **Epic:** Platform · **Priority:** P0 · **Complexity:** M · **Owner:** Dev 1
- **Description:** Shared commands, lint/type config, service template, migrations, health endpoints, config validation, testkit.
- **Dependencies:** FND-01 · **Parallel:** Yes
- **Acceptance criteria:** Each service builds/tests independently and emits structured request/correlation logs.
- **Definition of Done:** Documented commands work on clean clone; CODEOWNERS assigned.

#### PLT-02 — Docker Compose baseline
- **Epic:** Platform · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 4
- **Description:** Containerize web, gateway, services, isolated DBs, RabbitMQ, volumes, networks, and health checks.
- **Dependencies:** PLT-01 · **Parallel:** Yes
- **Acceptance criteria:** One command reaches healthy state in ≤90s after dependencies; restarts preserve data.
- **Definition of Done:** Clean-machine smoke test and teardown documented; images run non-root where feasible.

#### PLT-03 — Quality and security gates
- **Epic:** CI · **Priority:** P1 · **Complexity:** M · **Owner:** Dev 1
- **Description:** Add path-aware checks, test suites, contract compatibility, image builds, SBOM/dependency scanning.
- **Dependencies:** PLT-01, FND-03 · **Parallel:** Yes
- **Acceptance criteria:** PR cannot merge on failed required check or known critical dependency issue.
- **Definition of Done:** Protected-main settings documented; green pipeline badge/evidence captured.

#### PLT-04 — Logs, metrics, traces, dashboard
- **Epic:** Observability · **Priority:** P1 · **Complexity:** L · **Owner:** Dev 4
- **Description:** Establish correlation propagation and useful HTTP/broker/business telemetry early.
- **Dependencies:** PLT-01, PLT-02 · **Parallel:** Yes
- **Acceptance criteria:** One order is traceable end-to-end; dashboard shows latency, state counts, lag/retry/DLQ/pending age.
- **Definition of Done:** Alert test and screenshot captured; private fields absent from logs.

#### PLT-05 — Backup, restore, rollback
- **Epic:** Operations · **Priority:** P2 · **Complexity:** M · **Owner:** Dev 1
- **Description:** Document DB volume backup/restore, immutable image tags, and last-known-good deployment rollback.
- **Dependencies:** Stable schemas, PLT-02 · **Parallel:** Yes
- **Acceptance criteria:** Restore meets 24h RPO/60m RTO target in drill; previous image set starts.
- **Definition of Done:** Drill log attached; runbook reviewed by a non-owner.

### 4.2 Identity and supplier foundation

#### USR-01 — Schema, registration, activation
- **Epic:** User · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 1
- **Description:** User/profile/status tables, normalized allowlisted email, Argon2id password, one-time activation, one `UserActivated`.
- **Dependencies:** PLT-01, FND-03 · **Parallel:** Yes
- **Acceptance criteria:** Duplicate/off-domain rejected; activation is single-use/idempotent; secrets never logged.
- **Definition of Done:** Migrations, API, unit/integration tests, docs, telemetry merged.

#### USR-02 — Login, refresh rotation, logout
- **Epic:** User · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 1
- **Description:** 15-minute access token, hashed seven-day refresh sessions, rotation/reuse detection, logout revocation.
- **Dependencies:** USR-01 · **Parallel:** Yes
- **Acceptance criteria:** Valid login works; revoked/reused/expired refresh denied; logout invalidates within 10s.
- **Definition of Done:** Threat cases tested; cookies/storage and CSRF decision documented.

#### USR-03 — Profile, RBAC, status/introspection
- **Epic:** User · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 1
- **Description:** Student profile edits; admin role/status controls; authorization-state lookup and audit records.
- **Dependencies:** USR-01, USR-02 · **Parallel:** No
- **Acceptance criteria:** Actor matrix passes; suspension blocks new sessions/actions in ≤10s; last admin cannot be removed.
- **Definition of Done:** Audit data immutable; cross-service integration test passes.

#### USR-04 — Account screens and mode switch
- **Epic:** User UX · **Priority:** P1 · **Complexity:** L · **Owner:** Dev 5
- **Description:** Responsive registration, activation, login, profile, logout, protected routes, requester/courier navigation.
- **Dependencies:** FND-03, USR-01 · **Parallel:** Yes with mocks
- **Acceptance criteria:** Field errors preserved; 360/768/1440 widths pass; switch changes UX only.
- **Definition of Done:** Component tests, axe scan, keyboard path, responsive screenshots merged.

#### SUP-01 — Schema, admin CRUD, seed
- **Epic:** Supplier · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 2
- **Description:** Stable ID, validation/versioning, soft deactivation, idempotent ≥30-record/10-building seed.
- **Dependencies:** PLT-01, FND-03 · **Parallel:** Yes
- **Acceptance criteria:** Three seed runs preserve count/IDs/admin edits; only admin mutates; inactive remains resolvable.
- **Definition of Done:** Migrations, tests, seed source attribution, API docs merged.

#### SUP-02 — Search/filter/pagination
- **Epic:** Supplier · **Priority:** P0 · **Complexity:** M · **Owner:** Dev 2
- **Description:** Indexed active listing with name/address/instruction/tag search, type/building filters, stable order.
- **Dependencies:** SUP-01 · **Parallel:** Yes
- **Acceptance criteria:** Page size 1–100; stable ordering; 1,000-record p95 target demonstrated.
- **Definition of Done:** Query/integration/load tests and empty/error states merged.

#### SUP-03 — Responsive listing and selector
- **Epic:** Supplier UX · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 2 + Dev 5 review
- **Description:** Searchable browse page and reusable request-form selector backed by Supplier API.
- **Dependencies:** FND-03, SUP-02 · **Parallel:** Yes with mocks
- **Acceptance criteria:** Real API loads; mobile/desktop filters usable; unavailable supplier explained.
- **Definition of Done:** Component/E2E/accessibility tests; D2 demo scenario ready.

### 4.3 Order, credit, and event-driven core

#### EVT-01 — Broker topology and event library
- **Epic:** Messaging · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 4
- **Description:** Durable exchanges/queues, common envelope, schema validation, retry/DLQ conventions, correlation helpers.
- **Dependencies:** FND-03, PLT-02 · **Parallel:** Yes
- **Acceptance criteria:** Supported event validates; invalid major schema reaches DLQ; correlation survives publish/consume.
- **Definition of Done:** Library versioned; topology declared as code; integration tests green.

#### EVT-02 — Transactional inbox/outbox
- **Epic:** Messaging · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 4
- **Description:** Reusable local DB patterns and publishers/consumers for at-least-once delivery.
- **Dependencies:** EVT-01 · **Parallel:** No
- **Acceptance criteria:** Crash-after-commit publishes after restart; 100 duplicate deliveries cause one local effect.
- **Definition of Done:** Failure-injection tests pass in Order and Credit services; metrics emitted.

#### ORD-01 — Schema, state machine, authorization
- **Epic:** Order · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 3
- **Description:** Order aggregate, timestamps/version, public/private projections, status history, idempotent command records.
- **Dependencies:** FND-03, PLT-01 · **Parallel:** Yes
- **Acceptance criteria:** Every allowed/disallowed actor-state-command combination is tested; private fields never leak.
- **Definition of Done:** Migrations, generated transition suite, API/telemetry merged.

#### ORD-02 — Creation/reservation saga
- **Epic:** Order · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 3
- **Description:** Persist private `PENDING_CREDIT`, snapshot supplier, validate `paymentArranged`, publish reservation, handle success/rejection.
- **Dependencies:** ORD-01, EVT-02, CRD-01 · **Parallel:** No
- **Acceptance criteria:** Same key yields one order/reservation; only reserved order becomes `OPEN`; rejection preserves no active order.
- **Definition of Done:** Integration/failure/reconnect tests pass; UX state documented.

#### ORD-03 — Discovery and atomic acceptance
- **Epic:** Order · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 3
- **Description:** Indexed open list, privacy projection, deadline check, requester exclusion, one-winner conditional claim.
- **Dependencies:** ORD-01, USR-03 · **Parallel:** Yes
- **Acceptance criteria:** 100 simultaneous accepts yield one `ACCEPTED` and 99 conflicts; expired/self/suspended rejected.
- **Definition of Done:** Load/concurrency/auth tests and metrics merged.

#### ORD-04 — Fulfilment commands and receipt
- **Epic:** Order · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 3
- **Description:** Assigned courier pickup/deliver; requester confirm; completion saga; immutable completed receipt.
- **Dependencies:** ORD-03, CRD-03, EVT-02 · **Parallel:** No
- **Acceptance criteria:** Invalid actor/state does not mutate; completion remains pending until transfer result; receipt matches ledger transaction.
- **Definition of Done:** E2E happy path and replay tests green; API docs updated.

#### ORD-05 — Cancel, withdraw, expiry
- **Epic:** Order · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 3
- **Description:** Cancel before pickup, courier withdrawal/reopen, atomic expiry scheduler, release saga.
- **Dependencies:** ORD-02, CRD-04 · **Parallel:** Yes after saga contract
- **Acceptance criteria:** Deadline race has one outcome; release is exactly once; no direct cancel after pickup.
- **Definition of Done:** Clock-controlled tests, restart test, UI messages merged.

#### ORD-06 — Pending reconciliation
- **Epic:** Order · **Priority:** P1 · **Complexity:** M · **Owner:** Dev 4
- **Description:** Find old pending states, query credit transaction status, safely reissue or alert.
- **Dependencies:** ORD-02, ORD-04, ORD-05, CRD-05 · **Parallel:** Yes
- **Acceptance criteria:** Injected lost responses converge without second balance effect; unresolved mismatch alerts ≤5m.
- **Definition of Done:** Scheduled job, runbook, dashboard panel, fault test merged.

#### CRD-01 — Wallet issuance and balance API
- **Epic:** Credit · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 4
- **Description:** Create one active wallet with 10 credits from `UserActivated`; own-wallet/admin-read queries.
- **Dependencies:** EVT-02, USR-01 · **Parallel:** Yes
- **Acceptance criteria:** 100 duplicate activations yield one wallet/issuance; total = available + reserved; access matrix passes.
- **Definition of Done:** Migration, ledger/query APIs, tests, docs merged.

#### CRD-02 — Atomic reservation
- **Epic:** Credit · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 4
- **Description:** Validate wallet/amount/order and move available to reserved with ledger/outbox atomically.
- **Dependencies:** CRD-01 · **Parallel:** Yes
- **Acceptance criteria:** Insufficient/inactive/conflicting request has no mutation; duplicate has one effect; no negative balance.
- **Definition of Done:** Fault-injection and contract tests pass; event published after commit.

#### CRD-03 — Atomic completion transfer
- **Epic:** Credit · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 4
- **Description:** Consume matching reservation and atomically debit reserved/credit courier with linked ledger rows.
- **Dependencies:** CRD-02 · **Parallel:** Yes
- **Acceptance criteria:** 100 replays create one transfer; both wallets/ledgers visible together; conserved total.
- **Definition of Done:** Concurrent/fault/integration tests and event payload evidence merged.

#### CRD-04 — Reservation release
- **Epic:** Credit · **Priority:** P0 · **Complexity:** M · **Owner:** Dev 4
- **Description:** Release a matching live reservation once for cancellation/expiry/dispute outcome.
- **Dependencies:** CRD-02 · **Parallel:** Yes
- **Acceptance criteria:** Release after transfer/conflicting amount rejected without mutation; duplicate returns recorded result.
- **Definition of Done:** Unit/integration/replay tests; events/docs merged.

#### CRD-05 — Transaction status and reconciliation
- **Epic:** Credit · **Priority:** P1 · **Complexity:** M · **Owner:** Dev 4
- **Description:** Internal order-keyed status plus scheduled wallet-vs-ledger invariant check.
- **Dependencies:** CRD-03, CRD-04 · **Parallel:** Yes
- **Acceptance criteria:** Returns `NONE`/`RESERVED`/`RELEASED`/`TRANSFERRED`; injected mismatch raises alert and never auto-edits.
- **Definition of Done:** Reconciliation report, operator docs, test fixture merged.

#### WEB-01 — Request composer and resilient submission
- **Epic:** Requester UX · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 5
- **Description:** Supplier/items/delivery/reward/review flow, draft persistence, idempotency, pending/result states.
- **Dependencies:** FND-03, SUP-03, ORD-02 · **Parallel:** Yes with mocks
- **Acceptance criteria:** Balance projection, private/public copy, payment acknowledgement; reconnect creates zero duplicates.
- **Definition of Done:** Component, responsive, accessibility, E2E tests merged.

#### WEB-02 — Discovery and active fulfilment
- **Epic:** Courier UX · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 5
- **Description:** Filters/cards/details, privacy, atomic acceptance feedback, valid next actions, conflict refresh.
- **Dependencies:** FND-03, ORD-03, ORD-04 · **Parallel:** Yes with mocks
- **Acceptance criteria:** Own order disabled; exact details appear only after assignment; 409 replaces stale view.
- **Definition of Done:** Mobile/desktop/component/E2E/keyboard tests merged.

#### WEB-03 — Orders, receipts, wallet ledger
- **Epic:** Dashboard UX · **Priority:** P1 · **Complexity:** L · **Owner:** Dev 5
- **Description:** Active/past grouping, human status timeline, receipt, balances, paginated order-linked ledger.
- **Dependencies:** ORD-04, CRD-01 · **Parallel:** Yes with mocks
- **Acceptance criteria:** Pending states explained; receipt and matching credit rows navigable; unrelated data inaccessible.
- **Definition of Done:** Responsive/accessibility/E2E tests and empty/error states merged.

#### WEB-04 — SSE status stream with polling fallback
- **Epic:** Live updates · **Priority:** P1 · **Complexity:** M · **Owner:** Dev 5
- **Description:** Push authoritative order transitions and reconnect from last event; reduces async ambiguity.
- **Dependencies:** ORD-01, gateway · **Parallel:** Yes
- **Acceptance criteria:** Disconnect/reconnect converges within 10s; missed events recovered; polling fallback bounded.
- **Definition of Done:** Integration tests, connection limits, UI indicator, docs merged.

### 4.4 Integrated N2H, quality, and release

#### NTH-01 — Admin operations console
- **Epic:** Admin/support · **Priority:** P1 N2H · **Complexity:** L · **Owner:** Dev 1
- **Description:** Search users/orders, inspect audit/status/ledger/DLQ metadata, suspend/reactivate; no direct credit mutation.
- **Dependencies:** USR-03, WEB-03, PLT-04 · **Parallel:** Yes
- **Acceptance criteria:** Admin-only; every action reasoned/audited; student receives 403; sensitive values redacted.
- **Definition of Done:** E2E actor tests, operator guide, demo scenario merged.

#### NTH-02 — Reorder and saved delivery details
- **Epic:** History · **Priority:** P2 N2H · **Complexity:** M · **Owner:** Dev 2
- **Description:** Prefill a new draft from receipt/bookmark while revalidating supplier/balance and issuing a new key.
- **Dependencies:** WEB-01, WEB-03, SUP-02 · **Parallel:** Yes
- **Acceptance criteria:** No previous reservation/state reused; inactive supplier blocks submit with replacement flow; user edits before review.
- **Definition of Done:** Tests for changed supplier/balance; privacy/retention documented.

#### NTH-03 — Delivery dispute and auto-confirm
- **Epic:** Disputes · **Priority:** P1 N2H · **Complexity:** L · **Owner:** Dev 3
- **Description:** 24h auto-confirm; participant dispute reason/evidence reference; admin settle/release through normal saga.
- **Dependencies:** ORD-04, ORD-05, NTH-01 · **Parallel:** No
- **Acceptance criteria:** Timer suppressed by dispute; one audited decision; no wallet edit; repeated decision has one outcome.
- **Definition of Done:** State/API/UI/E2E/failure tests, policy copy, runbook merged.

#### NTH-04 — Credit conservation/concurrency evidence
- **Epic:** Reliability · **Priority:** P1 N2H · **Complexity:** L · **Owner:** Dev 4
- **Description:** Property-based random lifecycle test, accept race, broker replay, and fault matrix with report.
- **Dependencies:** ORD-05, CRD-05, EVT-02 · **Parallel:** Yes
- **Acceptance criteria:** Total credits conserved except issuance; no negative wallet; all mandated concurrency/replay targets pass.
- **Definition of Done:** CI job plus dated D4 evidence report and reproducible command merged.

#### NTH-05 — Participant chat and live notifications
- **Epic:** Communication · **Priority:** P1 N2H · **Complexity:** L · **Owner:** Dev 5
- **Description:** Order-scoped WebSocket chat from acceptance to terminal state plus status notifications; no voice/video/translation.
- **Dependencies:** ORD-03, USR-03, gateway · **Parallel:** Yes
- **Acceptance criteria:** Only participants/admin read; only participants send while active; reconnect paginates missed messages; terminal blocks send.
- **Definition of Done:** Auth/retention/rate-limit/E2E tests, UI, telemetry merged.

#### TST-01 — Contract and integration harness
- **Epic:** Test system · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 2
- **Description:** Ephemeral DB/broker fixtures, generated clients, provider/consumer contract checks.
- **Dependencies:** FND-03, PLT-02 · **Parallel:** Yes
- **Acceptance criteria:** Every service runs isolated integration tests; incompatible required-field change fails CI.
- **Definition of Done:** Testkit docs and sample fixtures used by all services.

#### TST-02 — Core and failure-path journeys
- **Epic:** E2E · **Priority:** P0 · **Complexity:** L · **Owner:** Dev 5
- **Description:** Playwright tests for join, create, accept race, fulfil, settle, cancel, expire, suspend, reconnect, dispute.
- **Dependencies:** Core APIs/UI · **Parallel:** Incrementally
- **Acceptance criteria:** Critical journeys pass twice from clean seed; deterministic clocks/data; traces/screenshots on failure.
- **Definition of Done:** CI smoke subset and full release suite documented/green.

#### TST-03 — Accessibility, load, security verification
- **Epic:** Non-functional · **Priority:** P1 · **Complexity:** L · **Owner:** Dev 1 coordinates; owners fix
- **Description:** Axe/keyboard, k6 targets, authorization matrix, rate limits, secret/log scan, dependency/image scan.
- **Dependencies:** Stable core · **Parallel:** Yes
- **Acceptance criteria:** D1 NFR numerical targets measured or exception recorded; zero critical axe/security issues.
- **Definition of Done:** Evidence report reviewed; defects linked and resolved/accepted.

#### REL-01 — Seed, smoke test, demo storyline
- **Epic:** Release · **Priority:** P0 · **Complexity:** M · **Owner:** Dev 2
- **Description:** Deterministic personas/suppliers/orders, health wait, smoke command, assessment narrative and failure fallback.
- **Dependencies:** Integrated stack · **Parallel:** Yes
- **Acceptance criteria:** Clean startup plus seed produces repeatable requester/courier/admin story; smoke fails loudly.
- **Definition of Done:** Two non-owner rehearsals pass; evidence/screenshots stored.

#### REL-02 — README, API/architecture/runbooks, traceability
- **Epic:** Documentation · **Priority:** P1 · **Complexity:** L · **Owner:** Dev 1 coordinates; all own docs
- **Description:** Setup, diagrams, ADR index, test matrix, operator recovery, contribution/N2H record, reuse attribution.
- **Dependencies:** Continuous · **Parallel:** Yes
- **Acceptance criteria:** A new teammate runs stack/demo from docs; every Must maps to code/test evidence.
- **Definition of Done:** Broken-link/checklist review complete; final commit references frozen docs.

#### REL-03 — Final hardening and tagged release
- **Epic:** Release · **Priority:** P0 · **Complexity:** M · **Owner:** Dev 1 release captain
- **Description:** Scope freeze, severity triage, rollback rehearsal, final images, backup demo, signed declaration/slides inputs.
- **Dependencies:** All launch P0/P1 · **Parallel:** No
- **Acceptance criteria:** No Sev-1/2 open; all launch gates green; exact final commit/images recorded before deadline.
- **Definition of Done:** `v1.0-d4` tag, release notes, demo assets, ownership statement complete.

#### CLD-01 — Optional cloud deployment
- **Epic:** DevOps · **Priority:** P3 · **Complexity:** L · **Owner:** Dev 1
- **Description:** Deploy immutable stack with managed secrets/config after local release is green; retain local fallback.
- **Dependencies:** All launch gates · **Parallel:** Yes only after gate
- **Acceptance criteria:** Same smoke test passes; rollback to prior version demonstrated; no secrets in repo.
- **Definition of Done:** Cost/operations documented; otherwise explicitly deferred without launch impact.

---

## 5. Dependency analysis

### 5.1 Dependency graph

```
FND-01 -> FND-02 -> FND-03 --------------------------+
 |          |                                      |
 v          v                                      v
 PLT-01 ---> PLT-02 -> EVT-01 -> EVT-02 --------> Order/Credit sagas
 |            |                    |              /      \
 |            +----> observability |         ORD-02      CRD-02
 |                                 |              \      /
 +-> User -------------------------+----------> full lifecycle
 +-> Supplier --------------------------------> creation snapshot
 +-> Web mocks/contracts ---------------------> integrated UI

 full lifecycle -> reconciliation + E2E -> N2H/disputes -> hardening -> D4
```

### 5.2 Critical path

1. Repository audit and architecture/state decisions.
2. HTTP/event contracts and mock generation.
3. Runnable platform plus broker and inbox/outbox pattern.
4. User activation → wallet issuance.
5. Order pending creation → credit reservation → open order.
6. Atomic acceptance → pickup → delivery → confirmation → credit transfer.
7. Cancellation/expiry → release and lost-message reconciliation.
8. Integrated E2E, concurrency, restart, accessibility, security, and demo proof.

The critical path belongs jointly to Dev 3 and Dev 4 after contracts freeze. To prevent either becoming a single point of failure, both review the saga ADR and cross-service integration tests; Dev 2 owns the test harness, while Dev 5 integrates against mocks before backends are ready.

### 5.3 Work that begins immediately

- **Dev 1:** repository audit and platform/service template.
- **Dev 2:** supplier schema/seed and D2 listing contract.
- **Dev 3:** order transition/creation saga ADR and OpenAPI/AsyncAPI leadership.
- **Dev 4:** wallet invariants, event envelope/topology, and Compose broker/database foundation.
- **Dev 5:** responsive app shell and contract-backed mocked requester/courier journeys.

### 5.4 High-risk integration points and mitigations

| Integration point | Risk | Mitigation |
|---|---|---|
| User activation → wallet issuance | Duplicate issue or user with no wallet | `userId` uniqueness, inbox, replay test, wallet-pending UI. |
| Order creation ↔ reservation | Orphan reservation/order or ambiguous client retry | Durable pending order, `orderId` business key, outbox/inbox, idempotent status query. |
| Acceptance ↔ expiry | Double outcome | One SQL conditional update on expected state/version/deadline. |
| Confirmation ↔ transfer | Completed UI before money commits | Explicit pending state; completion only on matching result. |
| Cancel/expire ↔ release | Transfer and release both attempted | Credit transaction state machine and unique `(orderId, transactionType)` constraints plus conflict audit. |
| Auth across services | Stale role/status or forged identity | Signed tokens, closed internal ports, service auth, mutation introspection/revocation cache. |
| Web vs evolving APIs | Late breakage | Generated client, mocks, compatibility gate, additive changes within schema major. |
| Shared migrations/config | Merge conflicts | Each owner edits only owned database migrations; shared package changes require designated reviewer. |

---

## 6. Five developer workstreams

Names can be mapped to Developer 1–5 at kickoff; the numerical ownership is stable even if the team later maps different people based on expertise.

#### Developer 1
- **Primary ownership:** Identity, security, release engineering
- **Secondary/N2H ownership:** Admin operations console; cloud only after gate
- **Components owned:** User Service, auth middleware, CI, release docs
- **Dependencies:** Contracts; broker for activation
- **Integration responsibilities:** Release captain; reviews auth in every service; maintains requirement/test traceability.

#### Developer 2
- **Primary ownership:** Supplier domain and test enablement
- **Secondary/N2H ownership:** Reorder/bookmarks
- **Components owned:** Supplier Service, seed data, contract/integration testkit, demo data
- **Dependencies:** User admin claims; Order create contract
- **Integration responsibilities:** Supplies stable mocks/fixtures; validates supplier snapshots and clean-clone demo.

#### Developer 3
- **Primary ownership:** Order aggregate and product policy
- **Secondary/N2H ownership:** Disputes and auto-confirm
- **Components owned:** Order Service, scheduler, order OpenAPI/state model
- **Dependencies:** User status, Supplier lookup, Credit events
- **Integration responsibilities:** Technical integration lead; owns transition matrix; pairs with Dev 4 on saga tests.

#### Developer 4
- **Primary ownership:** Credit economy and messaging reliability
- **Secondary/N2H ownership:** Reconciliation, chaos/concurrency evidence, observability
- **Components owned:** Credit Service, RabbitMQ topology, inbox/outbox library, dashboards
- **Dependencies:** User activation; Order commands/events
- **Integration responsibilities:** Owns economic invariants and failure drills; reviews all event consumers/producers.

#### Developer 5
- **Primary ownership:** Responsive product experience and E2E
- **Secondary/N2H ownership:** Participant chat and live status
- **Components owned:** React app, gateway streaming, Chat Service, Playwright
- **Dependencies:** Contracts/mocks; auth and Order APIs
- **Integration responsibilities:** UX/integration lead; maintains end-to-end suite and responsive/accessibility evidence.

Ownership does not mean exclusive authorship. Cross-owner changes require the component owner's review, and every critical component must have one backup reviewer: Dev 1 ↔ Dev 5 for auth/UI; Dev 2 ↔ Dev 3 for supplier/order; Dev 3 ↔ Dev 4 for sagas.

---

## 7. Sprint plan

### Sprint 0 — Contract-first foundation (10–17 September; D1 submission)

**Goal:** convert the D1 requirements into an agreed, executable design and unblock five parallel implementations.

| Developer | Sprint work | Deliverable |
|---|---|---|
| Dev 1 | FND-01; start PLT-01; auth/threat ADR; CI skeleton | Verified baseline and buildable service template. |
| Dev 2 | SUP-01 schema/seed design; TST-01 fixture design; improve supplier mock data | Supplier contract/seed ready for implementation. |
| Dev 3 | FND-02/FND-03 lead; state matrix; reconcile order creation contradiction | Approved order/API/event contracts and mock examples. |
| Dev 4 | Credit invariant model; EVT-01 topology; local DB/broker Compose | Broker and credit contracts runnable locally. |
| Dev 5 | Responsive app shell; mocked account/requester/courier flows; error-state inventory | Navigable prototype at 360/768/1440 against contract mocks. |

- **Entering dependencies:** access to the team repository/template and agreement on the Developer 1–5 name mapping.
- **Sprint-wide integration:** 60-minute contract workshop; freeze v1 core schemas; establish CODEOWNERS and PR template.
- **Testing:** contract validation and one clean-clone smoke.
- **Milestone:** submitted D1 backlog reflects selected N2Hs and resolved saga semantics.
- **Exit:** every P0 task has owner, dependency, acceptance test; services and web build; mock happy path works.
- **Risk:** spending the week rewriting prose rather than creating executable contracts.
- **Unblocks:** all service/UI work.

### Sprint 1 — Foundational vertical slice (18 September – 2 October; D2)

**Goal:** demonstrate registration/login, wallet issuance, supplier discovery, and a responsive supplier page in one containerized stack.

| Developer | Sprint work | Deliverable |
|---|---|---|
| Dev 1 | USR-01, USR-02, most of USR-03; PLT-03 | Registered/activated/authenticated user with secure session and CI gates. |
| Dev 2 | SUP-01, SUP-02, SUP-03; TST-01 baseline | Complete supplier service, seed, search, and page. |
| Dev 3 | ORD-01; Order skeleton/health; review supplier snapshot contract | Tested aggregate/state machine ready for saga. |
| Dev 4 | PLT-02, EVT-01/EVT-02 base, CRD-01 | `UserActivated` creates exactly one 10-credit wallet. |
| Dev 5 | USR-04; app shell integration; start WEB-01 with mocks | Responsive account and supplier journey using real services. |

- **Entering dependencies:** approved v1 contracts, service scaffold, broker/database Compose, and available template seed data.
- **Sprint-wide integration:** daily main integration window; D2 demo from clean Compose.
- **Testing:** auth matrix, seed idempotency, activation replay, responsive/axe checks, restart smoke.
- **Milestone:** D2-quality User/Supplier foundation with evidence of service integration and containerization.
- **Exit:** no mocked API remains in the D2 path; a new activated user sees wallet and suppliers.
- **Risks:** email provider unavailable — use a development mailbox adapter while preserving the production interface.
- **Unblocks:** end-to-end request creation.

### Sprint 2 — Core order-credit lifecycle (3–16 October; Weeks 8–9)

**Goal:** ship a complete requester-to-courier happy path plus cancellation/expiry using durable asynchronous coordination.

| Developer | Sprint work | Deliverable |
|---|---|---|
| Dev 1 | Finish USR-03; cross-service auth; start NTH-01 read-only console | Verified identity/status enforcement across mutations. |
| Dev 2 | Finish TST-01; supplier snapshot integration; demo fixtures; start NTH-02 backend support | Stable contract/integration harness and realistic data. |
| Dev 3 | ORD-02, ORD-03, ORD-04, start ORD-05 | Pending→open→accepted→picked-up→delivered→completed order path. |
| Dev 4 | Finish EVT-02; CRD-02, CRD-03, CRD-04; PLT-04 baseline | Exactly-once economic effect under at-least-once events. |
| Dev 5 | WEB-01, WEB-02, start WEB-03/WEB-04 | Full happy-path UI with pending/conflict/reconnect states. |

- **Entering dependencies:** working identity/status lookup, stable supplier lookup/snapshot, wallet issuance, event library, inbox/outbox base, and contract-backed UI mocks.
- **Sprint-wide integration:** Dev 3/4 pair on one saga scenario each day; feature flags hide unfinished N2Hs.
- **Testing:** duplicate/replay, 100-way acceptance, cancellation/expiry clock tests, one Playwright happy path.
- **Milestone:** D3 core feasibility is no longer a slide — one order transfers credits in Compose.
- **Exit:** happy path and pre-pickup cancel pass from clean seed; all messages carry correlation ID.
- **Risks:** saga bugs and contract drift; freeze event v1 at sprint start.
- **Unblocks:** failure recovery and N2H integration.

### Sprint 3 — Reliable integrated beta (17–30 October; Weeks 10–11, D3 checkpoint in Week 10)

**Goal:** demonstrate robust async behavior for D3, then complete the committed N2H vertical slices.

| Developer | Sprint work | Deliverable |
|---|---|---|
| Dev 1 | NTH-01; security/log-redaction checks; PLT-05 draft | Audited admin/support workflow. |
| Dev 2 | NTH-02; REL-01 seed/smoke; contract regression support | Reorder flow and deterministic demo dataset. |
| Dev 3 | Finish ORD-05; NTH-03 state/API/scheduler | Expiry, release, dispute, and auto-confirm behavior. |
| Dev 4 | ORD-06, CRD-05, PLT-04, start NTH-04 | Recoverable DLQ/pending flow and reconciliation dashboard. |
| Dev 5 | Finish WEB-03/WEB-04; NTH-05; expand TST-02 | Integrated history, live updates, chat, and N2H E2E. |

- **Entering dependencies:** complete core Order-Credit happy and pre-pickup terminal paths, baseline telemetry, stable v1 events, and a green core Playwright test.
- **Sprint-wide integration:** D3 demonstration deliberately injects one duplicate and one transient consumer failure, then shows recovery and telemetry.
- **Testing:** broker restart, service crash around commit, permission/privacy, SSE reconnect, chat authorization, dispute timer.
- **Milestone:** feature-complete beta.
- **Exit:** all launch P0 functions work; committed N2Hs are end-to-end, not isolated demos; no unresolved schema decision.
- **Risks:** N2H threatens core stability — cut NTH-02 first, then chat attachments/typing indicators (not chat authorization or basic messaging).
- **Unblocks:** final hardening.

### Sprint 4 — Release hardening and D4 (31 October – 11 November, 10:00 SGT)

**Goal:** produce a reproducible, explainable final system and a low-risk live demonstration.

| Developer | Sprint work | Deliverable |
|---|---|---|
| Dev 1 | TST-03 security lead; REL-02/REL-03; backup/rollback drill; presentation integration | Frozen secure release and complete engineering narrative. |
| Dev 2 | REL-01; supplier/load evidence; documentation review; demo operator | One-command seed/smoke and rehearsed story. |
| Dev 3 | State/concurrency bug fixes; dispute evidence; architecture diagram and decision rationale | Proven order correctness and clear architecture explanation. |
| Dev 4 | Finish NTH-04; load/fault/reconciliation report; dashboard/demo monitoring | Evidence that credits survive duplicates/failures. |
| Dev 5 | Finish TST-02; accessibility/performance fixes; demo UI polish; backup captures | Green E2E, responsive/accessibility proof, smooth demo. |

- **Entering dependencies:** feature-complete beta, frozen schemas, green core tests, deterministic seed, and all unresolved defects triaged.
- **Sprint-wide integration:** scope freeze 31 October; release-candidate builds at least twice; two timed team rehearsals; final commit/tag no later than an internal cutoff of 10 November 18:00 SGT, leaving recovery time before the official deadline.
- **Testing:** full regression, load, restart, backup/restore, security, accessibility, clean-machine demo.
- **Milestone:** D4 release.
- **Exit:** launch criteria below all green, slides/declaration/links accurate, local fallback verified.
- **Risk:** late feature work — only Sev-1/2 defects may change core behavior after first RC.
- **Unblocks:** submission and presentation.

---

## 8. Integration strategy

### 8.1 Contract governance

- OpenAPI and AsyncAPI live in `packages/contracts`; generated types are consumed by web/services.
- Contract changes require the producer owner, at least one consumer owner, and Dev 3 or Dev 4 review.
- Within v1, changes are additive. Removing/renaming/changing meaning requires a new major schema and a migration window.
- Each endpoint/event has positive, validation, authorization, conflict, duplicate, and dependency-failure examples.
- Mocks are generated from the same contract; handwritten mock payloads are prohibited in committed E2E fixtures.

### 8.2 Branching and PR practice

- Trunk-based development with short-lived branches (`feat/ID-description`); protected main; no long-lived per-service branches.
- Each PR references backlog IDs, requirements, tests, migration/contract impact, screenshots for UI, and rollback notes when applicable.
- Prefer PRs below ~400 changed logical lines; split schema/contract, domain logic, and UI integration where possible.
- At least one non-author approval; two approvals for auth, credit invariants, order transitions, shared contracts, or destructive migrations.
- Database migrations are forward-only and owned by the service owner. Shared package edits name all affected consumers.
- Merge main into active branches daily; integrate a complete slice to main at least every two working days.

### 8.3 Shared models and conflict prevention

- Share wire contracts, error envelope, IDs, time format, and generated clients — not persistence entities or business repositories.
- One owner at a time edits order state/event enums after contract freeze; proposed changes begin in an ADR/contract PR.
- Each service owns its Dockerfile, migrations, and data; the platform owner owns root Compose with service-owner review.
- UI features use feature flags until real APIs and E2E pass. Flags cannot bypass server authorization.
- Fixed integration slots: 30-minute cross-service check three times weekly; Dev 3/4 daily during Sprint 2.

### 8.4 Integration tests

- Provider contract tests validate each service response/event against schemas.
- Consumer tests replay recorded valid/duplicate/stale/invalid events.
- Compose integration tests cover activation→wallet, create→reserve, confirm→transfer, cancel/expire→release, and reconciliation.
- Playwright operates only through public gateway routes.
- Failure tests stop a consumer/broker/service at controlled boundaries, restart it, and assert final state plus credit conservation.

---

## 9. Testing strategy and ownership

| Type | Scope | When | Primary owner | Required evidence |
|---|---|---|---|---|
| **Unit/property** | State transitions, validation, reward range, deadline logic, ledger arithmetic, idempotency hashes | Every PR | Component owner | Fast green tests; property seed printed on failure. |
| **Component** | React forms, responsive navigation, state actions, error/empty/loading/pending views, accessibility | Every UI PR | Dev 5; feature owner assists | Testing Library plus axe; screenshots at 360/768/1440. |
| **Contract** | OpenAPI request/response and event schema compatibility | Every contract/producer/consumer PR | Dev 2 harness; Dev 3/4 approve | CI compatibility artifact; invalid schema rejection test. |
| **Integration** | Service + own DB; broker inbox/outbox; gateway auth | Every service PR | Service owner | Ephemeral fixtures; no shared developer DB dependency. |
| **E2E** | Join, request, claim, fulfil, settle, cancel, expire, suspend, reconnect, dispute/chat/reorder | Main/nightly and RC | Dev 5 | Playwright video/trace on failure; twice-green clean seed for RC. |
| **Concurrency** | 100 simultaneous claims; repeated commands/events; wallet row races | Sprint 2 onward | Dev 3/4 | Exactly one winner/economic effect; no negative balance. |
| **Failure/recovery** | Kill after DB commit/before publish, broker outage, consumer crash, DLQ, stale event, reconciliation | Sprint 3 onward | Dev 4 | Final convergence and one effect; dashboard/trace evidence. |
| **Load/performance** | D1 p95 targets for auth, supplier, orders, wallet; queue processing; web Lighthouse | Sprint 4, baseline earlier | Dev 1 coordinates; each owner fixes | Versioned k6/Lighthouse report with environment and dataset. |
| **Security/privacy** | Actor-resource matrix, injection validation, rate limiting, secret/image/dependency scan, log redaction, field visibility | Continuous + RC | Dev 1 | Zero unauthorized success, critical vulnerability, or secret/private-field leak. |
| **Accessibility/manual QA** | Keyboard full journey, focus, screen-reader labels, contrast, touch targets, mobile devices | Every sprint + RC | Dev 5, all participate | Zero critical axe issue; signed manual checklist. |
| **Production/demo validation** | Clean startup, health, seed, smoke, backup/restore, last-known-good rollback | Each milestone/RC | Dev 1/2 | Timestamped run log and exact commit/image tags. |

Testing is part of each task's Definition of Done. A feature is not "backend complete" or "frontend complete" when its contract, error states, telemetry, and relevant tests are missing.

---

## 10. Risk register

#### Async saga creates locked/orphan credits
- **Probability:** Medium · **Impact:** Critical
- **Affected components:** Order/Credit/events
- **Early warning signs:** Pending age grows; order/credit status mismatch
- **Mitigation:** Inbox/outbox, business keys, pending states, reconciliation, fault tests
- **Contingency:** Disable new creation; reconcile via idempotent commands; restore last green release
- **Owner:** Dev 4

#### Double courier assignment
- **Probability:** Medium · **Impact:** High
- **Affected components:** Order
- **Early warning signs:** Multiple 2xx claims or version jumps
- **Mitigation:** Conditional SQL update and 100-way race in CI
- **Contingency:** Close discovery endpoint until invariant fixed; repair affected seed/demo data only
- **Owner:** Dev 3

#### Contract drift blocks integration
- **Probability:** High · **Impact:** High
- **Affected components:** All
- **Early warning signs:** Handwritten payloads, compile failures, repeated UI/backend rework
- **Mitigation:** Contract-first package, mocks, compatibility gate, named reviewers
- **Contingency:** Freeze v1; adapter at gateway/consumer; defer nonessential field
- **Owner:** Dev 3

#### User/Supplier not ready for D2
- **Probability:** Medium · **Impact:** High
- **Affected components:** D2 milestone
- **Early warning signs:** Mock still used one week before demo
- **Mitigation:** Sprint 1 prioritizes only D2 slice; daily integration
- **Contingency:** Demo activation through dev mailbox; cut admin UI polish, not RBAC/API
- **Owner:** Dev 1

#### N2H breadth crowds out mandatory work
- **Probability:** High · **Impact:** High
- **Affected components:** Schedule/quality
- **Early warning signs:** P0 defects open while N2H PRs grow
- **Mitigation:** Hard launch gate; five integrated contributions; explicit deferrals
- **Contingency:** Cut reorder, then chat extras; retain core and reliability evidence
- **Owner:** Dev 1

#### SMTP/NUS verification unavailable
- **Probability:** High · **Impact:** Medium
- **Affected components:** Activation
- **Early warning signs:** No credentials/delivery in Sprint 1
- **Mitigation:** Adapter interface and development mailbox UI/log sink
- **Contingency:** Demonstrate token flow locally; document production SMTP config
- **Owner:** Dev 1

#### Sensitive delivery/chat/token data leaks
- **Probability:** Medium · **Impact:** Critical
- **Affected components:** Web/logs/admin
- **Early warning signs:** Private fields in open API or telemetry
- **Mitigation:** Separate serializers, redaction tests, least-data APIs, threat model
- **Contingency:** Disable affected view/log exporter; rotate secrets; purge demo logs
- **Owner:** Dev 1

#### Broker or container instability during demo
- **Probability:** Medium · **Impact:** High
- **Affected components:** Entire demo
- **Early warning signs:** Flaky health/recovery, manual startup
- **Mitigation:** Health waits, persistent volumes, pinned images, rehearsed Compose
- **Contingency:** Local last-known-good bundle, screenshots/video, restart runbook
- **Owner:** Dev 4

#### Team merge bottleneck around shared files
- **Probability:** High · **Impact:** Medium
- **Affected components:** Contracts/Compose/web
- **Early warning signs:** Large stale branches, repeated conflicts
- **Mitigation:** Small PRs, ownership, daily sync, contract freeze
- **Contingency:** Integration captain resolves; pair change with affected owner
- **Owner:** Dev 3

#### Performance targets fail late
- **Probability:** Medium · **Impact:** Medium
- **Affected components:** Search/order/wallet/web
- **Early warning signs:** Slow queries and growing queue lag in Sprint 3
- **Mitigation:** Baseline early; indexes; bounded pagination; dashboard
- **Contingency:** Document measured exception if non-user-visible; cut heavy N2H queries
- **Owner:** Component owner

#### Requester never confirms or disputes
- **Probability:** Medium · **Impact:** High
- **Affected components:** Order/Credit
- **Early warning signs:** Old `DELIVERED`, courier complaints
- **Mitigation:** Visible 24h policy, notifications, auto-confirm scheduler
- **Contingency:** Admin resolution path; temporarily shorten demo SLA by config
- **Owner:** Dev 3

#### Dispute/admin power enables arbitrary credits
- **Probability:** Low · **Impact:** Critical
- **Affected components:** Admin/Order/Credit
- **Early warning signs:** Direct balance endpoint or unaudited action
- **Mitigation:** Outcomes go through Order saga; no balance-edit API; two-review PR
- **Contingency:** Disable admin resolution; resolve only by replaying validated command
- **Owner:** Dev 3/4

#### Cloud work consumes schedule
- **Probability:** Medium · **Impact:** Medium
- **Affected components:** DevOps
- **Early warning signs:** Local release not green by Oct 31
- **Mitigation:** CLD-01 is P3 and gate-controlled
- **Contingency:** Deliver local Compose only, fully compliant
- **Owner:** Dev 1

#### Uneven visible contributions
- **Probability:** Medium · **Impact:** High
- **Affected components:** Assessment/team
- **Early warning signs:** One owner presents many areas; N2H work untracked
- **Mitigation:** Ownership map, PR IDs, per-member N2H slice, contribution log
- **Contingency:** Rebalance reviews/demo speaking segments by Sprint 3
- **Owner:** Dev 1

#### Final deadline/demo data error
- **Probability:** Medium · **Impact:** High
- **Affected components:** D4
- **Early warning signs:** Manual edits required; unrehearsed flow
- **Mitigation:** Internal cutoff, deterministic seed/smoke, two rehearsals
- **Contingency:** Use frozen RC and backup recording/screenshots
- **Owner:** Dev 2

---

## 11. Decision log

#### Order creation consistency
- **Alternatives considered:** Synchronous reserve before persist; distributed transaction; durable saga
- **Chosen approach and reasoning:** Durable private `PENDING_CREDIT` saga. It is recoverable, idempotent, and demonstrates M6 meaningfully.
- **Trade-offs:** A failed attempt leaves a short-lived support record and eventual rather than immediate result.

#### Technology stack
- **Alternatives considered:** Mixed languages; Java/Spring; TypeScript
- **Chosen approach and reasoning:** React + NestJS + TypeScript to share contract tooling and reduce context switching for five people.
- **Trade-offs:** Assumes team can work in TypeScript; revisit only at Sprint 0 before contracts freeze.

#### Datastores
- **Alternatives considered:** One shared schema; database per container; logical DBs on one server
- **Chosen approach and reasoning:** Logical PostgreSQL database/user per service locally. Preserves ownership with lower laptop overhead.
- **Trade-offs:** PostgreSQL remains shared failure domain locally; production can split instances.

#### Messaging
- **Alternatives considered:** Kafka; Redis Streams; RabbitMQ
- **Chosen approach and reasoning:** RabbitMQ for routing, acknowledgements, retries, and manageable course-project operations.
- **Trade-offs:** Less replay/stream analytics than Kafka; adequate for command/event workload.

#### Credit consistency
- **Alternatives considered:** Shared DB transaction; event sourcing; ledger + balances
- **Chosen approach and reasoning:** ACID Credit DB transaction with immutable ledger, derived/current balance, inbox/outbox.
- **Trade-offs:** Ledger is not the only source of truth; reconciliation must verify both.

#### Authentication propagation
- **Alternatives considered:** Gateway-only trust; introspection every request; self-contained JWT only
- **Chosen approach and reasoning:** Gateway and service JWT validation, plus short-cached authorization-state check for sensitive mutations.
- **Trade-offs:** Some User Service coupling; necessary for fast suspension semantics.

#### API edge
- **Alternatives considered:** Direct browser-to-services; full BFF; thin gateway
- **Chosen approach and reasoning:** Thin gateway for routing/auth/correlation/rate limits/streams.
- **Trade-offs:** Another container, but simplifies browser security and service exposure.

#### Live updates
- **Alternatives considered:** Polling only; WebSocket everywhere; SSE status + WS chat
- **Chosen approach and reasoning:** SSE for one-way order status with polling fallback; WebSocket only for bidirectional chat.
- **Trade-offs:** Two streaming mechanisms; each matches a clear use case.

#### Supplier history
- **Alternatives considered:** Live lookup only; full replicated supplier
- **Chosen approach and reasoning:** Store supplier ID plus immutable receipt/display snapshot at creation.
- **Trade-offs:** Duplicate display data, but historical receipts remain stable.

#### Requester non-confirmation
- **Alternatives considered:** Wait forever; immediate auto-complete; timed dispute window
- **Chosen approach and reasoning:** Auto-confirm after 24h unless disputed. Protects courier while giving requester recourse.
- **Trade-offs:** Requires scheduler and clear policy; threshold should be mentor-reviewed.

#### Post-pickup cancellation
- **Alternatives considered:** Allow requester cancellation; disallow all resolution; dispute
- **Chosen approach and reasoning:** No direct cancel after pickup; audited dispute/admin outcome.
- **Trade-offs:** Adds N2H workflow, prevents unilateral loss.

#### N2H scope
- **Alternatives considered:** Implement all D1 ideas; AI feature showcase; integrated reliability/product set
- **Chosen approach and reasoning:** Admin, reorder, dispute, chat/live updates, reliability evidence. These reinforce the core and give each member meaningful ownership.
- **Trade-offs:** Less novelty than broad AI/Kubernetes work, much higher completion probability.

#### Cloud/Kubernetes
- **Alternatives considered:** Mandatory cloud/K8s; no cloud ever; gated stretch
- **Chosen approach and reasoning:** Local Compose is release target; cloud P3 only after all gates; Kubernetes deferred.
- **Trade-offs:** Fewer DevOps novelty points, lower delivery risk.

#### Feature flags
- **Alternatives considered:** Long-lived divergent editions; no flags; temporary flags
- **Chosen approach and reasoning:** Temporary server/UI flags for unfinished N2H only; remove or document at release.
- **Trade-offs:** Requires flag hygiene; protects main integration.

#### Demo release
- **Alternatives considered:** Work until official deadline; internal freeze
- **Chosen approach and reasoning:** Internal final cutoff 10 Nov 18:00 SGT and tagged RCs.
- **Trade-offs:** One less evening for features, much more recovery time.

---

## 12. Scope control and Definition of Done

### Committed launch scope

All official M1–M7 behaviors; full happy/failure lifecycle; secure identity; supplier discovery/admin lifecycle; exact credit conservation; Docker Compose; automated core tests; observable async recovery; responsive and accessible core UI; one deterministic demo.

### Committed N2H scope

- Admin/support console with audited user status actions.
- Order history/receipts and a simple reorder flow.
- Delivery dispute plus 24-hour auto-confirm.
- Basic text participant chat and live status notifications.
- Concurrency, replay, fault, reconciliation, logging, metrics, and dashboard evidence.

### Deferred

Natural-language/voice composition, RAG, translation/moderation by third-party AI, route maps/navigation, grouped multi-errand runs, voice/video calls, Kubernetes, autoscaling, and cloud deployment before the release gate. These may be revisited only if all launch P0/P1 work is green by the end of Sprint 3.

### Global Definition of Done

A backlog item is done only when:

1. Acceptance criteria and mapped requirements pass.
2. Code is reviewed and merged to protected main.
3. Migrations/contracts are versioned and compatible.
4. Unit plus relevant integration/contract/E2E/failure tests pass.
5. Authorization, validation, privacy, error, and idempotency paths are covered.
6. Logs/metrics carry correlation context and exclude protected data.
7. Documentation and runbook are updated.
8. The containerized integration remains healthy.
9. No Sev-1/2 defect or critical dependency vulnerability is introduced.

---

## 13. Final delivery roadmap

### A. Project goal

Deliver a responsive, trustworthy campus errand platform that matches students and transfers closed-loop credits exactly once, while visibly demonstrating good microservice, event-driven, reliability, and product design decisions.

### B. Current state

Verified artifacts consist of the official brief, a detailed D1 FR/NFR backlog, and mockup captions. Code, architecture, deployments, tests, and operational evidence are unverified. The first action is an evidence-based repository audit.

### C. Major gaps

The highest-risk gaps are unresolved async creation semantics, missing contracts/state machine, absent implementation evidence, financial idempotency/recovery, cross-service authorization, frontend conflict recovery, and over-broad N2H scope.

### D. Target state

A monorepo containing a React UI, thin gateway, five containerized services with isolated data ownership, RabbitMQ messaging, transactional inbox/outbox, explicit Order/Credit sagas, end-to-end observability, and repeatable CI/demo tooling.

### E. Critical path

Contracts/state model → platform/broker → activation/wallet → create/reserve → accept/fulfil/transfer → cancel/expire/release → reconcile/failure tests → release rehearsal.

### F. Five-developer ownership map

- **Dev 1:** identity/security/release and admin support.
- **Dev 2:** suppliers/test fixtures/demo data and reorder.
- **Dev 3:** order lifecycle/integration and disputes.
- **Dev 4:** credit/messaging/observability and reliability evidence.
- **Dev 5:** responsive web/E2E/live updates and participant chat.

### G. Sprint roadmap

- **Sprint 0:** executable contracts and skeleton by D1 submission.
- **Sprint 1:** User/Supplier/containerized vertical slice for D2.
- **Sprint 2:** complete Order-Credit happy/cancel/expiry paths.
- **Sprint 3:** D3 async/recovery proof and integrated N2Hs.
- **Sprint 4:** scope-frozen hardening, evidence, and D4 release.

### H. Milestones

| Milestone | Product state |
|---|---|
| D1 – 17 Sep backlog submission | Agreed scope, target architecture, contracts, state model, responsive mocked flows, implementation backlog. |
| D2 – Week 7 | Real registration/auth, activation/wallet issue, Supplier CRUD/search/page, healthy Compose. |
| D3 – Week 10 | Integrated create/reserve/accept/fulfil/transfer and cancel/expire/release; broker retries/idempotency demonstrated. |
| Feature complete – 30 Oct | All launch P0 plus committed N2Hs integrated and observable. |
| Internal release – 10 Nov 18:00 | Tagged, rehearsed, fully tested release candidate. |
| D4 – 11 Nov 10:00 submission | Final commit/slides complete; local fallback and demo evidence ready. |

### I. Launch criteria

- All M1–M7 and launch P0/P1 acceptance criteria pass.
- One activated user receives exactly 10 initial credits; 100 duplicate activation events do not add credits.
- 100 concurrent valid claims produce exactly one courier.
- Reserve, release, and transfer replays produce one economic effect and never a negative wallet.
- Total platform credits change only through initial issuance; reconciliation is clean.
- Core requester/courier/admin journeys pass from a clean seed at 360, 768, and 1440 widths.
- No unauthorized access to exact delivery details, another wallet, admin actions, or participant chat.
- Crash/restart and broker interruption recover without lost committed state or duplicate economics.
- Zero known Sev-1/2 defects, critical accessibility violations, committed secrets, or unresolved critical dependency/image vulnerabilities.
- Clean Docker Compose startup, seed, smoke, backup/restore, and rollback are documented and rehearsed.
- Presentation, contribution/N2H allocation, repository/deployment links, reuse attribution, and signed declaration are complete.

### J. Post-launch work

Only after D4: evaluate cloud hosting, richer chat moderation/translation, route preview, AI-assisted composition/support, grouped errands, push notifications, and longer-term analytics. Validate real user demand and privacy/operational cost before building them.

### K. Top risks

The top five are credit inconsistency, order/credit contract drift, double acceptance, mandatory work displaced by N2Hs, and an unreproducible demo environment. Their controls are inbox/outbox plus reconciliation, contract gates, atomic conditional updates, hard scope gates, and clean-start rehearsals.

### L. Immediate next actions

- **Developer 1:** complete FND-01 today; publish the repository evidence matrix; scaffold one service with config validation, health endpoints, structured logging, migration/test commands; draft the auth/security ADR and CI checks.
- **Developer 2:** define the Supplier schema and OpenAPI examples; prepare the idempotent ≥30-record/10-building seed with source attribution; implement search fixture tests and the mock response used by the listing page.
- **Developer 3:** publish the authoritative order transition matrix and creation-saga ADR; lead the 60-minute contract workshop; create OpenAPI/AsyncAPI v1 for creation, acceptance, fulfilment, release, and completion including every error/idempotency case.
- **Developer 4:** define wallet/ledger/transaction invariants and constraints; stand up PostgreSQL/RabbitMQ in Compose; implement the common event envelope/topology and write the first duplicate `UserActivated` test.
- **Developer 5:** build the responsive app shell and navigation; implement mocked registration, supplier selection, requester review, courier discovery, and active-order screens from generated contract types; capture 360/768/1440 and keyboard/axe evidence.

**Team checkpoint within 48 hours:** map names to Developer 1–5, approve the ADRs/state matrix, select the contract owner/release captain, confirm N2Hs with the mentor, and agree that no deferred feature starts before the Sprint 3 launch gate.
