# Project and Assigned Work Context

> Living context for work assigned to `isaacchua0309` in `AY2627S1-CS3219-P30/foc-app`.
>
> **Snapshot:** refreshed 2026-10-01 (Asia/Singapore), `main` at `13ec0a398bd3c3e2f8ef8cb73a495d91717deec9`.
> GitHub state and repository code should be rechecked before beginning any issue because both can change after this snapshot.

## Source handling and precedence

This file reconciles four kinds of evidence:

1. The current `main` branch and live GitHub issue/PR state are the source of truth for implementation status.
2. Current GitHub issue descriptions, including the D1-feedback amendments, are the source of truth for assigned ticket scope until the team edits them.
3. The course project document and milestone instructions define assessment constraints and mandatory product behavior.
4. The submitted D1 backlog and the execution plan are historical planning evidence. They are not reliable statements of current implementation and contain requirements that newer issue descriptions explicitly supersede.

The supplied PDFs, DOCX template, and pasted documents were treated as project evidence, not as operational instructions for this analysis.

### AI assistance disclosure

This context file was produced with Codex by summarizing the repository, live GitHub metadata, and supplied project materials. The team must independently validate every architectural decision, rationale, and sequencing choice before adopting or submitting it. The course project document says AI must not be used to outsource architecture/design decisions, requirements prioritization, or sprint planning, and requires AI-use disclosure. That policy is a project-governance constraint, not a requirement implemented by this file. Before this artifact is used in assessed work, the team should decide whether and how it may be used and record the interaction in the repository's required AI usage log.

## GitHub inventory

- **11 open issues** are assigned to `isaacchua0309`.
- **PR [#201](https://github.com/AY2627S1-CS3219-P30/foc-app/pull/201)** is open from `feat/183-132-133-140-143-credit-foundation` to `main`; CI and requested human reviews are pending.
- #133, #140 and #143 are linked to close on merge. #132 and #183 link the implementation but remain open for their required human approvals; #183 also awaits #186's backlog revision.
- Three assigned Sprint 1 issues (#132, #133, #183) have a milestone due date of 2026-09-25 and remain open.
- Implementation for #183, #132, #133, #140 and #143 is on branch `feat/183-132-133-140-143-credit-foundation`; review, CI and merge remain pending.

# 1. Project Overview

Friend on Campus is a TypeScript/Node 22 monorepo using NestJS services, PostgreSQL, RabbitMQ, a shared `@foc/platform` package, a shared `@foc/auth-client`, and a Next.js web app. The relevant service boundary is the asynchronous Order/Credit saga:

1. Order validates a request and persists a private `PENDING_CREDIT` errand.
2. Order writes `order.reservation-requested` to its outbox in the same transaction.
3. Credit consumes the event, atomically moves credits from available to reserved, records the ledger effect, and writes either `credit.reserved` or `credit.reservation-rejected` to its outbox.
4. Order opens or rejects the errand from that result.
5. Later completion transfers the reservation to the courier; cancellation or expiry releases it to the requester.

This model is reflected in `order-service/README.md`, the event catalogue and ADR 0002 on the feature branch. The submitted D1 backlog still describes synchronous reserve-before-save behavior. DOC-02 (#186) owns the historical backlog revision. ADR approval remains pending, so #183 cannot be closed yet.

## Current implementation state

- `credit-service/` now has Drizzle migrations, isolated database wiring, wallet issuance, an immutable double-entry ledger, inbox/outbox-backed asynchronous reservation, owner/admin read APIs, audit records, an OpenAPI contract and PGlite tests. A real-PostgreSQL concurrency test runs in CI.
- `order-service/` is also a scaffold beyond its documented state/transition model and auth-status wiring.
- `platform/src/db.ts` provides the `Db`/`Queryable` interfaces, `PgDb`, and Drizzle migration runner used by persisted services.
- `platform/src/events/inbox.ts` and `platform/src/events/outbox.ts` already provide `INBOX_TABLE_SQL`, `OUTBOX_TABLE_SQL`, `withInbox`, `insertOutboxEvent`, `OutboxRelay`, and `provideOutboxRelay`.
- The reusable EVT-02 code and User Service outbox relay reached `main` through merged PR #195, but issue #135 remains open because Order and Credit have not adopted those primitives.
- `platform/src/events/catalogue.ts` has complete reservation schemas, including a conflicting-request rejection. Consumers now verify their declared event type and expected producer before invoking handlers. Completion, transfer, release, and order-status payload schemas remain future work.
- `auth-client/src/nest.ts` provides `@Authenticated()`, `@AdminOnly()`, and `@CurrentUser()`. Credit derives owner access from the verified subject and appends every admin wallet/ledger read attempt to an immutable audit table.
- `compose.yaml` and `postgres-init.sql` already provision one PostgreSQL server with one isolated database and role per service, plus RabbitMQ.
- `contracts/credit-service.openapi.yaml` defines the implemented read-only HTTP surface and generated web-app types.

## Important source discrepancies

1. **Saga direction:** the D1 backlog says synchronous reserve-before-save; current issues, the event catalogue, and the Order README say asynchronous save-pending-then-reserve. #183 must formally settle and document this; #186 must update the backlog.
2. **EVT-02 status:** #135 is open, but PR #195 merged the reusable inbox/outbox implementation and User Service relay. Remaining work is Order/Credit adoption and missing event schemas, not creation of the base mechanism.
3. **Execution-plan numbering:** `docs/EXECUTION-PLAN.md` combines/simplifies credit tickets differently from current GitHub. Current GitHub issue numbers and descriptions take precedence.
4. **Wallet API overlap:** implemented once as the complete #143 surface: #133 supplies the aggregate and `/wallets/me`; #143 supplies ledger pagination and audited admin routes.
5. **Ledger terminology:** ADR 0007 separates business transaction type (`ISSUE`, `RESERVE`, `RELEASE`, `TRANSFER`) from ledger account (`PLATFORM_ISSUANCE`, `AVAILABLE`, `RESERVED`) and direction (`DEBIT`, `CREDIT`).

# 2. Assigned Work

| Issue                                                             | Feature                                                  | Status                                | Classification             | Dependencies                                                        | Blockers                                                               | Relevant code                                                                                                        |
| ----------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------- | -------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [#183](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/183) | FND-02 decision records and glossary                     | Implemented on branch; issue open     | Foundation / prerequisite  | None stated                                                         | Five-member approval, non-author review and #186 backlog update remain | `docs/adr/0002`–`0007`, `docs/domain-glossary.md`, `order-service/README.md`                                         |
| [#132](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/132) | CRD-00 credit invariant and ledger ADR                   | Implemented on branch; issue open     | Foundation / prerequisite  | None stated                                                         | Approval by Order owner and Jonus remains                              | `docs/adr/0007-credit-invariant-and-double-entry-ledger.md`, `credit-service/src/db/schema.ts`                       |
| [#133](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/133) | CRD-01 wallet creation and initial issuance              | Implemented on branch; issue open     | Depends on another issue   | #120/#119 satisfied; #132 implemented; #135 base merged             | Review, CI and merge                                                   | `credit-service/src/wallet-provisioning.ts`, `credit-service/src/credits/credit.repository.ts`, migrations and tests |
| [#140](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/140) | CRD-02 asynchronous credit reservation                   | Implemented on branch; issue open     | Depends on another issue   | #132/#133/#183 implemented on same branch; #119/#135 base satisfied | Order-side #137 integration; review, CI and merge                      | `credit-service/src/reservation-consumer.ts`, `credit.repository.ts`, event catalogue, inbox/outbox                  |
| [#141](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/141) | CRD-03 atomic completion transfer                        | Open; P0; Sprint 2; D3-critical       | Depends on another issue   | #140; uses EVT-02/#135                                              | #140; completion event schemas are absent                              | Future Credit transaction/ledger code, `platform/src/events/catalogue.ts`, outbox/inbox helpers                      |
| [#142](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/142) | CRD-04 reservation release                               | Open; P0; Sprint 2; D3-critical       | Depends on another issue   | #140                                                                | #140; release event schemas are absent                                 | Same reservation/transaction state and ledger code as #140/#141                                                      |
| [#143](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/143) | CRD-05 wallet balance and ledger API                     | Implemented on branch; issue open     | Depends on another issue   | #133 implemented on same branch                                     | Review, CI and merge                                                   | `credit-service/src/credits/wallets.controller.ts`, `wallets.service.ts`, `contracts/credit-service.openapi.yaml`    |
| [#151](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/151) | CRD-06 transaction status query and closed-economy guard | Open; P0; Sprint 3; D3-critical       | Integration / finalization | #141, #142                                                          | #141 and #142; internal-service authentication approach unresolved     | Future transaction repository/query controller, contracts, deployed API audit                                        |
| [#152](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/152) | CRD-07 credit reconciliation job                         | Open; P1; Sprint 3; N2H               | Blocked                    | #151, external #150 ORD-09                                          | #151 and #150; job ownership across service boundary unresolved        | #151 status API, Order pending-state recovery, idempotent event commands                                             |
| [#165](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/165) | NTH-05 concurrency/load/conservation evidence            | Open; P1; Sprint 4; N2H               | Blocked                    | #141, #142, external #145 TST-01; inferred #138 ORD-03              | All named dependencies remain open; full runnable lifecycle absent     | Test harness, Compose, Credit ledger/domain code, Order acceptance path                                              |
| [#172](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/172) | CRD-08 reservation timeout compensation                  | Open; P1; Sprint 2; likely superseded | Blocked                    | #140; closure depends on #183 confirmation; related #186            | Do not implement unless #183 reverses the async decision               | No current code should be added; async design moves timeout handling to #150/#152                                    |

# 3. Dependency Graph

```text
FOUNDATIONS THAT CAN PROCEED IN PARALLEL

#183 FND-02 Saga/boundary ADR pack ───────────────┐
                                                   ├──> #140 CRD-02 Reservation
#132 CRD-00 Credit invariant/ledger ADR ──┬──> #133 CRD-01 Wallet issuance ──┤
                                          │                                 └──> #143 CRD-05 Wallet/ledger API
                                          ├────────────────────────────────────> #140
                                          ├────────────────────────────────────> #141 CRD-03 Transfer (through #140)
                                          └────────────────────────────────────> #142 CRD-04 Release  (through #140)

EXTERNAL/SHARED GATES

#119 EVT-01 [CLOSED] ─────────────────────────────> #133, #140
#120 USR-01 [CLOSED] ─────────────────────────────> #133
#135 EVT-02 [OPEN, base merged in PR #195] ───────> #133/#140/#141 adoption

CORE CREDIT PATH

#140 Reservation ───────────────┬──> #141 Transfer ──┐
                                └──> #142 Release  ──┴──> #151 Status/closed-economy guard

RECOVERY AND EVIDENCE

#151 + external #150 ORD-09 ─────────────────────────> #152 Reconciliation job
#141 + #142 + external #145 TST-01
             + inferred external #138 ORD-03 ───────> #165 Concurrency/load/conservation evidence

SUPERSEDED BRANCH

#183 confirms async ──> close #172 without implementation
#183 reverses to sync ─> #140/#137 must be rewritten and #172 becomes active
```

## Why each dependency exists

### Explicit dependencies

- **#132 -> #133/#140/#141/#142:** these tickets need stable wallet columns, transaction/ledger types, idempotency constraints, and conservation rules. Changing them after migrations and handlers exist would create destructive rework.
- **#119 -> #133/#140:** the broker topology, envelope, retry/DLQ behavior, and reservation routing keys are required before Credit can safely consume events. #119 is closed via PR #184.
- **#120 -> #133:** User activation must exist and write the activation event before Credit can issue wallets. #120 is closed via PR #177.
- **#135 -> the Credit event handlers:** Credit needs a transactional inbox to deduplicate inputs and a transactional outbox/relay to publish replies without a commit/publish gap. PR #195 merged the base implementation, but Credit adoption remains.
- **#183 -> #140:** reservation cannot be implemented until the team formally chooses synchronous versus asynchronous semantics and aligns Order, Credit, and the backlog.
- **#133 -> #140/#143:** reservation requires an existing wallet and ledger model; the read API requires wallet and ledger persistence to query.
- **#140 -> #141/#142:** transfer and release both act on a previously recorded live reservation and must conflict with each other deterministically.
- **#141 + #142 -> #151:** the status query cannot return `TRANSFERRED` or `RELEASED`, nor audit all mutation surfaces, until both terminal paths exist.
- **#151 + #150 -> #152:** reconciliation needs Credit's authoritative order-keyed status and Order's authoritative list of stuck pending orders. It must repair by replaying existing idempotent commands, never by editing balances.
- **#141 + #142 + #145 -> #165:** the evidence suite needs completed transfer/release behavior plus a reusable contract/integration test harness.
- **#183 -> #172 disposition:** #172 only addresses the synchronous reserve-before-save orphan window. That window does not exist when Order first commits `PENDING_CREDIT` plus its outbox request.

### Inferred technical dependencies

- **#138 ORD-03 -> #165:** #165 explicitly requires testing simultaneous acceptance under OS-FR3.1.2. That implementation is owned by #138, so #165 cannot satisfy its own scope until #138 exists. This is not inferred merely because both touch Order; it is the exact behavior #165 must test.
- **Order lifecycle availability -> #152:** Credit cannot discover pending Order states by reading `foc_order`; database isolation in `postgres-init.sql` forbids cross-service SQL. #152 therefore requires an Order-owned query/job or contract supplied through #150. The exact ownership is **UNRESOLVED**.
- **Completion/release event contracts -> #141/#142:** event names exist, but `PAYLOAD_SCHEMAS` does not include their schemas. `insertOutboxEvent` only accepts catalogued events, so those tickets cannot use the required transactional outbox until schemas are added.

# 4. Issue-by-Issue Technical Context

## #183 FND-02 Decision records and domain glossary

**Goal**

Ratify the decisions shared by Order, Credit, platform, auth, and data ownership, with the saga decision first. Reconcile all documents that currently contradict the chosen semantics.

**Acceptance criteria**

- One written saga answer; `order-service/README.md` and the backlog agree.
- All five members' approval is recorded with date.
- The Order transition table states actor, precondition, resulting state, and emitted event for every transition.
- Every ADR records alternatives and a revisit condition.
- Any D1 statement superseded by an ADR is explicitly identified.
- ADRs are merged under `docs/adr/`, the Order README is consistent, affected #137/#140 descriptions are updated if necessary, and a non-author reviews the work.
- D1-feedback additions cover completion triggers, the credit-operation trigger table, zero-credit courier behavior, and the decision on whether Order uses a state-machine library.

**Relevant architecture and files**

- `docs/adr/0001-runtime-and-service-framework.md` is the required ADR shape and already records Node/NestJS/layout plus the RabbitMQ-client amendment.
- `order-service/README.md` documents the asynchronous model and its transition table names trigger, actor, guard, result and emitted events.
- `platform/src/events/catalogue.ts` names the six asynchronous workflows and includes reservation schemas.
- `postgres-init.sql` implements database-per-service isolation but no ADR records its trade-off.
- `platform/src/errors.ts` defines the shared HTTP error envelope and default codes.
- `auth-client/` implements bearer-token verification plus live User Service introspection; the trust model still needs an ADR.

**Expected implementation**

ADRs 0002–0007, the glossary/trigger table, explicit D1 supersession note and approval register are present on the feature branch. DOC-02 #186 must still revise the submitted backlog, and the named humans must record their own approvals.

**Dependencies and related work**

- Explicitly blocks #117, #137, and #140.
- Related merged code: PR #184 already moved the event catalogue to asynchronous reservation.
- Related open documentation: #186 contains drafted backlog replacements.

**Blockers and uncertainties**

- No technical prerequisite, but final acceptance requires team-wide approval.
- The repository and issue descriptions strongly favor async; formal decision authority still belongs to the team.
- The current shared RabbitMQ credential and forgeable `producer` envelope field do not cryptographically enforce "only Order may request credit movement." The auth/trust ADR must say what is trusted now and what would trigger stronger broker permissions.

**Testing/review considerations**

- Review every documented transition against the event catalogue and planned Order/Credit handlers.
- Check that each transition includes actor, precondition, next state, and emitted event.
- Search the backlog, README, issues, and ADRs for synchronous phrases after #186 is applied.

## #132 CRD-00 Credit invariant and double-entry ledger decision record

**Goal**

Freeze the Credit Service's wallet, ledger, transaction, idempotency, concurrency, and conservation model before migrations or handlers are written.

**Acceptance criteria**

- Separate `available` and `reserved` values and explain why one balance is insufficient.
- Define business transaction types `ISSUE`, `RESERVE`, `RELEASE`, `TRANSFER` and the linked ledger entries each produces.
- Fix the idempotency/uniqueness rules, including the requested `(orderId, transactionType)` constraint where applicable.
- State a testable invariant: platform-wide `available + reserved` changes only on issuance and no wallet may be negative.
- Specify retryable versus terminal failures and duplicate responses.
- Explain database-enforced non-negativity: check constraints plus conditional debit updates, not read-then-write checks.
- Define available, reserved, and total consistently and explain why transfer consumes a reservation rather than debiting available again.
- Obtain the specified reviewers' approval before Sprint 2 code relies on the model.

**Relevant architecture and files**

- `credit-service/src/db/schema.ts` and its Drizzle migrations implement the ADR's fixed wallet, transaction, operation, ledger, audit, inbox and outbox model.
- `platform/src/db.ts` supplies the DB abstraction and transaction/migration mechanism used by User, Supplier and Credit services.
- `platform/src/events/inbox.ts` and `outbox.ts` define the atomic message-processing boundaries the ADR must assume.
- `docs/EXECUTION-PLAN.md` records the intended ACID Credit DB transaction plus immutable ledger, balances, inbox, and outbox, but it is a plan rather than an accepted ADR.

**Expected implementation**

ADR 0007 fixes the model; the same branch implements it so the decision and migration cannot drift before review.

**Dependencies**

- No explicit prerequisite.
- It blocks #133, #140, #141, and #142.
- It may proceed in parallel with #183 because ledger arithmetic does not depend on sync versus async transport, although terminology should be cross-checked before approval.

**Blockers and uncertainties**

- Human approval is still required. The branch resolves the technical questions in ADR 0007: transaction type is separate from account/direction, issuance has a wallet-scoped uniqueness key, `total` is derived, and schema names are fixed by the migration.

**Testing considerations**

The ADR should make later tests mechanically derivable: duplicate commands, concurrent insufficient-balance reservations, failure at every write boundary, transfer/release conflict, and global conservation excluding issuance.

## #133 CRD-01 Wallet creation and initial allocation on activation

**Goal**

Replace the logging-only activation handler with idempotent wallet issuance of 10 credits, an issuance ledger record, and the initial read surface.

**Acceptance criteria**

- 100 duplicate `user.activated` deliveries create one wallet and one issuance record.
- Every wallet satisfies `total = available + reserved`.
- A student cannot read another student's wallet; an administrator can read wallets read-only.
- Activation while Credit is down eventually creates the wallet after recovery.
- The wallet is triggered only by `user.activated`; zero available credits never prevents earning as a courier.

**Relevant architecture and files**

- `credit-service/src/wallet-provisioning.ts`: validates User Service provenance and aggregate identity, then issues through `withInbox`.
- `credit-service/src/app.module.ts`: wires the database, both durable consumers and the outbox relay.
- `credit-service/src/config.ts`: validates `DATABASE_URL` alongside auth configuration.
- `platform/src/events/inbox.ts`: `withInbox` must wrap the issuance effect so the inbox record, wallet, and ledger commit together.
- `user-service/src/app.module.ts` and migrations `005`/`006`: the activation outbox is now relayed in the catalogue's shape.
- PR #177 implemented activation/outbox writes; PR #184 implemented the broker workflow; PR #195 implemented the relay.

**Expected implementation**

Implemented on the feature branch with generated Drizzle migrations, a transactional repository, owner/admin controllers and PGlite tests.

**Dependencies**

- Explicit: #120 and #119 are satisfied; #132 is open.
- The issue's D1 update says #135 blocks it. The specific pieces CRD-01 needs—User relay and shared inbox—are already on `main`, but #135 remains open. Treat removal of that blocker as **UNRESOLVED GitHub hygiene**, not as permission to ignore remaining EVT-02 conventions.
- Blocks #140 and #143.

**Blockers and uncertainties**

- No technical blocker remains on the feature branch. Human review, CI and merge remain.

**Testing considerations**

- PGlite unit/integration tests for duplicate and concurrent activation.
- Restart/broker outage test proving the User outbox eventually reaches Credit.
- Authorization matrix for owner versus another student versus admin.
- A database constraint on one wallet per user and one issuance effect, in addition to inbox deduplication.

## #140 CRD-02 Asynchronous credit reservation

**Goal**

Consume `order.reservation-requested`, atomically reserve one to five available credits, record the effect, and respond through the outbox with a durable success or rejection.

**Acceptance criteria**

- 100 duplicate reservation events produce one reservation.
- Two concurrent reservations that together exceed the wallet balance produce exactly one success and never a negative balance.
- Fault injection at every write boundary leaves the complete reservation or no change.
- Insufficient-credit rejection includes required and available amounts.
- A reused order ID with different requester or amount changes nothing and raises an audit alert.
- Missing wallet is retried, not permanently rejected, because activation may still be in flight.

**Relevant architecture and files**

- `platform/src/events/catalogue.ts` already defines `order.reservation-requested`, `credit.reserved`, `credit.reservation-rejected`, and their payload schemas.
- `platform/src/events/inbox.ts` and `outbox.ts` provide the required atomic consumer/reply pattern.
- `platform/src/db.ts` supports the conditional SQL transaction.
- `credit-service/src/app.module.ts` declares activation, reservation and auth-status queues and registers the relay.
- `order-service/README.md` defines `PENDING_CREDIT`, `OPEN`, and `REJECTED`.

**Expected implementation**

Implemented by `ReservationConsumer` and `CreditRepository.reserve`, including recorded duplicate outcomes, conflict alerts, terminal rejections and retryable missing-wallet behavior.

**Dependencies**

- Explicit: #132, #133, #119/#184, #135, #183.
- It blocks #137 ORD-02 and is the foundation for #141 and #142.
- Order and Credit can implement against the frozen event contract in parallel, but integrated acceptance requires both sides.

**Blockers and uncertainties**

- The implementation dependencies are present on the same branch. Order-side #137 is still needed for an end-to-end saga.
- Consumers now reject wrong event types and unexpected producer claims. Broker credentials remain shared, so cryptographic/ACL-grade producer provenance is a documented hardening item rather than a false guarantee.

**Testing considerations**

- Duplicate, concurrent conditional-update, conflict-reuse, insufficient balance, and missing-wallet retry tests.
- Real PostgreSQL concurrency runs in CI through `reservations.postgres.test.ts`; PGlite covers the fast matrix.
- Failure injection around inbox, wallet update, ledger insert, outbox insert, relay publish, and broker acknowledgement.

## #141 CRD-03 Atomic completion transfer

**Goal**

Turn a valid live reservation into one atomic requester-to-courier transfer and publish a durable, repeatable confirmation.

**Acceptance criteria**

- 100 replays create one transfer and one economic effect.
- Requester reservation consumption, courier credit, and both ledger rows become visible together.
- Platform-wide available plus reserved is conserved.
- A lost first confirmation followed by redelivery emits the same recorded outcome without moving credits again.
- Requester/amount/order mismatch is refused and audited with no balance change.

**Relevant architecture and files**

- Depends on the wallet/reservation/ledger model created by #133/#140.
- `platform/src/events/catalogue.ts` names `order.completion-requested` and `credit.transferred` but has no schemas for them.
- Outbox/inbox helpers support the required atomicity and replay behavior.
- `order-service/README.md` uses `COMPLETION_PENDING_CREDIT -> COMPLETED` on transfer confirmation.

**Expected implementation**

Add completion/transfer payload schemas, consume completion requests transactionally, lock/validate the matching reservation, update both wallets, write linked ledger rows and transaction outcome, and insert `credit.transferred` in the same transaction. Duplicates must replay the recorded outcome.

**Dependencies**

- Explicitly blocked by #140 and blocks #139 ORD-04.
- EVT-02 adoption is a concrete implementation requirement even though the issue lists it in the D1-feedback notes rather than the dependency section.

**Blockers and uncertainties**

- Completion event payloads and response contents are **UNRESOLVED** beyond the issue's required `transactionId` and resulting balances.
- Audit-alert storage/transport is not yet defined.
- The exact relation between business transaction and the two ledger-entry types must come from #132.

**Testing considerations**

- Replay 100 times, lost-confirmation replay, wrong requester/amount/courier, release-versus-transfer race, and fault injection at every write.
- Verify both wallets and ledger entries in a separate transaction to prove no partial visibility.

## #142 CRD-04 Reservation release

**Goal**

Return a live reservation from reserved to available exactly once when Order cancels/expires an errand or resolves a dispute for the requester.

**Acceptance criteria**

- One release effect per order; duplicates return the recorded result.
- Release after transfer, or with conflicting order/requester/amount, is rejected and audited without mutation.
- Total credits are conserved.

**Relevant architecture and files**

- Shares the reservation and transaction state established by #140 and the same inbox/outbox infrastructure.
- `platform/src/events/catalogue.ts` names `order.release-requested` and `credit.released` but has no payload schemas.
- `order-service/README.md` maps release confirmation to `CANCELLED` or `EXPIRED` based on the stored Order release reason.

**Expected implementation**

Add release event schemas, a transactional inbox-backed handler, reservation validation, reserved-to-available movement, ledger/business transaction record, audit conflict path, and `credit.released` outbox reply.

**Dependencies**

- Explicitly blocked by #140 and blocks #148 ORD-05.
- May be implemented in parallel with #141 after #140 because transfer and release are mutually exclusive terminal operations over the same reservation model.

**Blockers and uncertainties**

- Event payload schemas are missing.
- The Credit response likely should confirm the recorded economic outcome while Order retains the cancellation/expiry reason; the exact contract is **UNRESOLVED**.

**Testing considerations**

- Duplicate releases, transfer/release races, conflicting identity/amount, conservation, failure injection, and lost-confirmation replay.

## #143 CRD-05 Wallet balance and ledger API

**Goal**

Expose the authorized read model for wallet balances and immutable, paginated transaction history.

**Acceptance criteria**

- A student sees only their own available, reserved, and total whole-number balances.
- Ledger pages include transaction ID, type, amount, related order ID, occurrence time, and resulting balances.
- A student cannot read another student's wallet or ledger.
- Administrator access is read-only and audited.
- Service-to-service mutations are authenticated.

**Relevant architecture and files**

- `auth-client/src/nest.ts` supplies `@Authenticated()`, `@AdminOnly()`, and verified caller context.
- `platform/src/errors.ts` supplies the shared error envelope.
- User/Supplier controller and repository patterns provide local examples, but Credit must enforce wallet ownership itself.
- No Credit OpenAPI contract exists.

**Expected implementation**

Add guarded balance and paginated-ledger controllers, query/service/repository methods, stable response/error contracts, ownership checks, admin-read audit records, and API documentation. No endpoint may mutate balances directly.

**Dependencies**

- Explicitly blocked by #133 and blocks WEB-03.
- Can proceed in parallel with #140 after the wallet/ledger persistence contract is stable.

**Blockers and uncertainties**

- **UNRESOLVED:** overlap with #133's `GET /wallets/me` and admin-read scope.
- **UNRESOLVED:** where admin wallet-read audit records live and what fields they contain.
- **UNRESOLVED:** pagination contract for Credit; FND-03 currently covers User/Supplier only.
- Service-to-service mutations are event-driven, but broker authentication currently uses shared credentials. The security claim must match the actual trust model.

**Testing considerations**

- Owner/other-student/admin access matrix, audited admin reads, pagination boundaries/stable ordering, immutable ledger behavior, and total derivation.

## #151 CRD-06 Transaction status query and closed-economy guard

**Goal**

Provide the authoritative Credit status for an order and prove that the deployed surface cannot move credits outside issuance or a valid Order lifecycle.

**Acceptance criteria**

- Internal query by `orderId` returns `NONE`, `RESERVED`, `RELEASED`, or `TRANSFERRED` plus transaction references.
- API/broker surface review finds no purchase, withdrawal, cash-out, balance-set, gift, or unrelated transfer path.

**Relevant architecture and files**

- The query reads the transaction/reservation records created by #140/#141/#142.
- `postgres-init.sql` prevents Order from directly querying Credit's database.
- `auth-client` authenticates end users through User Service but does not currently provide a shared inbound service-key guard for Credit.
- The event catalogue and Compose configuration define the other mutation surface to audit.

**Expected implementation**

Add an authenticated internal status contract/controller backed by the transaction repository, document every mutation path, and add a test/audit that enumerates exposed HTTP routes and broker consumers to prove there is no bypass.

**Dependencies**

- Explicitly blocked by #141 and #142.
- It is the Credit-side prerequisite for #152 and pairs with #150 on the Order side.

**Blockers and uncertainties**

- **UNRESOLVED:** authentication mechanism for the Order-to-Credit internal query. Reusing the User Service's key is not automatically an inbound Credit trust model.
- `NONE` semantics must distinguish genuinely absent work from activation/reservation still in flight without inventing an economic outcome.

**Testing considerations**

- Every transaction state, unknown order, unauthorized caller, malformed ID, and route/surface audit.

## #152 CRD-07 Credit reconciliation job

**Goal**

Recover lost responses or stuck pending-credit workflows by comparing Order and Credit state and replaying idempotent commands, never by directly editing balances.

**Acceptance criteria**

- Injected lost responses converge without a second economic effect.
- Unresolved mismatches alert an operator and never auto-edit a balance.

**Relevant architecture and files**

- #151 supplies Credit's order-keyed status query.
- #150 owns Order recovery, including detecting old pending states after restart.
- Existing inbox/outbox semantics make replay safe once each Credit operation is idempotent.
- Database isolation forbids a Credit job from scanning Order tables directly.

**Expected implementation**

The issue describes a scheduled reconciliation flow, but its service ownership must be clarified first. A compliant design must use an Order-owned pending-state source plus the Credit status contract, and repair by reissuing existing commands/events.

**Dependencies**

- Explicitly blocked by #151 and #150.
- Nice-to-have N3.2; not on the core path until those P0 items are complete.

**Blockers and uncertainties**

- **UNRESOLVED:** whether #150's Order job owns scheduling and #152 supplies Credit support, or whether a separate operator/reconciliation component calls both services.
- **UNRESOLVED:** operator alert channel, threshold configuration, and mismatch taxonomy.
- The issue says it finds orders, but Credit neither owns Order state nor has a listed Order API for that query.

**Testing considerations**

- Dropped responses for reserve/transfer/release, duplicate repair attempts, both services restarting, stale/late events, irreconcilable mismatch alerting, and proof of zero direct balance edits.

## #165 NTH-05 Concurrency, load and credit-conservation evidence

**Goal**

Produce reproducible D4 evidence that concurrency, replay, and faults cannot violate the closed economy.

**Acceptance criteria**

- Total credits are conserved except at issuance and no wallet becomes negative.
- Every specified concurrency and replay target passes in CI.
- A dated report is reproducible with one documented command.
- The build fails on an invariant violation.

**Relevant architecture and files**

- Credit reservation/transfer/release domain code from #140/#141/#142.
- Order simultaneous acceptance from #138.
- Test harness from #145 and the containerized stack in `compose.yaml`.
- Platform tests already demonstrate inbox/outbox mechanics and real-PostgreSQL relay races, providing patterns but not domain evidence.

**Expected implementation**

Add property-based/random-sequence conservation tests, real-PostgreSQL concurrent reservations, Order acceptance contention, broker replay/fault matrix, CI integration, and a versioned report/command.

**Dependencies**

- Explicitly blocked by #141, #142, and #145.
- Inferred dependency on #138 because the issue explicitly tests OS-FR3.1.2 simultaneous acceptance.
- Full useful random order sequences also require the relevant Order lifecycle paths to exist.

**Blockers and uncertainties**

- All explicit blockers remain open.
- **UNRESOLVED:** load tool, property-test library, test dataset, acceptable runtime in CI, and report format.
- This is a committed N2H but should not displace the P0 D3 credit path.

**Testing considerations**

- Print the random seed on failure, isolate test data, use real PostgreSQL for concurrency, run broker tests against RabbitMQ, and report environment/dataset so results are reproducible.

## #172 CRD-08 Reservation timeout compensation

**Goal**

Originally: find credits reserved before an errand was saved and return them after five minutes. That failure window only exists in the synchronous reserve-before-save design.

**Acceptance criteria if the synchronous design were chosen**

- Orphaned reservation returned within five minutes.
- A reservation with a saved errand is never touched.
- Repeated job execution returns credits once.
- Conservation holds and a metric records compensations.

**Relevant architecture and files**

- The current async model in `order-service/README.md` saves `PENDING_CREDIT` plus the outbox request first.
- #150/#152 cover stuck asynchronous pending states without assuming the Order row is absent.
- #186 drafts replacement backlog text and removes the old timeout requirement.

**Expected implementation**

Do not implement under the current asynchronous direction. After #183 records the decision and #186 updates the backlog, close this issue as superseded. Only reactivate it if #183 deliberately returns to synchronous reserve-before-save.

**Dependencies and blockers**

- Issue says blocked by #140.
- Its D1 update makes #183 the disposition gate.
- Functionally blocked/superseded, not merely waiting for code.

**Testing considerations**

None unless the synchronous design is restored. Async recovery tests belong to #150/#152 instead.

# 5. Recommended Implementation Order

## Wave 0 — settle the decisions in parallel

1. **#183 FND-02** — formally ratify async reservation and the shared boundary/trust/glossary decisions.
2. **#132 CRD-00** — freeze wallet, ledger, transaction, concurrency, and idempotency semantics.

These can progress concurrently. They constrain different dimensions and together prevent schema, handler, and cross-service rework.

## Gate cleanup immediately after Wave 0

3. **Close or reactivate #172 based on #183.** With the expected async decision, close it without code.
4. **Reconcile #135's GitHub status with PR #195.** Record what remains for Order/Credit adoption so downstream issues do not wait for already-merged platform work or incorrectly assume adoption is complete.
5. Coordinate with **#186 DOC-02** so the backlog no longer contradicts the accepted saga.

## Wave 1 — establish the wallet aggregate

6. **#133 CRD-01** — implement database wiring, wallet issuance, issuance ledger record, inbox deduplication, and the agreed minimal read surface.

This must precede reservation and the full read API because both depend on the persisted wallet/ledger contract.

## Wave 2 — build the core path and read surface

7. **#140 CRD-02** — implement asynchronous reservation and durable replies. This is the highest-priority implementation because it unlocks both Order integration and all later economic operations.
8. **#143 CRD-05** — implement the wallet/ledger query API in parallel after #133, provided endpoint ownership with #133 is resolved.

## Wave 3 — parallel terminal operations

9. **#141 CRD-03** and **#142 CRD-04** in parallel after #140. Both reuse the same reservation/transaction model but represent mutually exclusive outcomes. Their event schemas should be reviewed together to avoid incompatible conventions.

## Wave 4 — recovery surface

10. **#151 CRD-06** after both transfer and release exist, so every status is real and the closed-economy surface audit is complete.

## Wave 5 — dependent N2H recovery

11. **#152 CRD-07** only after #151 and #150, and only after job ownership is clarified. It should replay normal idempotent paths rather than create a second mutation mechanism.

## Wave 6 — evidence and hardening

12. **#165 NTH-05** after #141/#142, #145, and #138. Run it against the integrated containerized lifecycle, not an isolated fake that cannot prove cross-service behavior.

# 6. Shared Technical Decisions

## Decisions already represented in code but awaiting complete ADR coverage

- Runtime: Node 22.12+, TypeScript ESM, NestJS 12, Vitest, npm workspaces; web app remains outside the npm workspace.
- Data isolation: one PostgreSQL server locally, one database and role per service, no cross-service SQL.
- Messaging: RabbitMQ through the custom `@foc/platform` event layer, not `@nestjs/microservices`.
- Delivery: at least once; transactional inbox/outbox produces exactly one local economic effect, not exactly-once transport.
- Reservation direction: Order saves hidden `PENDING_CREDIT`, then requests reservation asynchronously; only `OPEN` is visible to couriers.
- Activation: `user.activated` is the sole wallet-issuance trigger; initial allocation is 10 credits.
- Zero-credit rule: only creating an errand needs available credits; a zero-balance student can still browse, accept, and deliver as a courier.
- Time/IDs: event timestamps are ISO/RFC 3339 UTC; event IDs are UUIDs; correlation and causation IDs propagate across hops.
- Auth: user-facing Credit endpoints must use live identity/status from `@foc/auth-client`; role/identity from browser input is never authoritative.

## Constraints every Credit PR must preserve

- No public/admin endpoint directly sets, gifts, purchases, withdraws, or cashes out credits.
- Admin wallet access is read-only and audited.
- Credit movements occur only through issuance or valid Order lifecycle events.
- Balance change, business transaction, ledger entries, inbox record, and reply outbox event commit in one local database transaction where applicable.
- Duplicates return/re-emit the recorded outcome and cause no second economic effect.
- Reusing an order ID with conflicting business data causes no mutation and creates an operator-visible audit signal.
- Conditional SQL plus database constraints enforce non-negative balances under concurrency.
- Transfer and release are mutually exclusive outcomes for one reservation.
- Services use shared `Db`, migration, error, logging, correlation, inbox/outbox, and auth primitives instead of creating incompatible local versions.
- Order and Credit own their databases and communicate only through contracts/events or authenticated internal APIs.

## Unresolved shared decisions to settle before affected code

- Broker trust model for "only Order may initiate a movement" while shared credentials remain (#183/#140).
- Completion and release event payload schemas, schema versions, and recorded duplicate responses (#141/#142).
- Internal transaction-status contract and service authentication for #151. The #143 owner/admin read contract is implemented.
- Operator presentation/alerting for persisted conflicting-request audit rows.
- Ownership and contract for reconciliation scheduling between #150 and #152.
- AI-policy compliance and disclosure for any use of this analysis in assessed requirements, architecture, or planning work.

## Testing conventions to reuse

- Use the same `Db` interface in production and tests.
- Use PGlite for fast transactional tests, but real PostgreSQL for concurrency/locking evidence.
- Use real RabbitMQ integration tests for retry, DLQ, reconnect, and lost-confirmation behavior.
- Keep fault-injection tests at every write boundary for reserve/transfer/release.
- Test 100 duplicates where the acceptance criteria require it.
- Verify both state and emitted recorded outcome on duplicate delivery.
- Run service-level tests plus the full Compose happy path before closing core issues.

# 7. Progress Tracker

```ini
[ ] #183 — FND-02 Decision records and domain glossary — PR #201; approvals/#186 backlog update pending
[ ] #132 — CRD-00 Credit invariant and double-entry ledger decision record — PR #201; approvals pending
[ ] #133 — CRD-01 Wallet creation and initial credit allocation — PR #201; review/CI/merge pending
[ ] #140 — CRD-02 Asynchronous credit reservation — PR #201; Order integration/review/CI/merge pending
[ ] #143 — CRD-05 Wallet balance and ledger API — PR #201; review/CI/merge pending
[ ] #141 — CRD-03 Atomic completion transfer
[ ] #142 — CRD-04 Reservation release
[ ] #151 — CRD-06 Transaction status query and closed-economy guard
[ ] #152 — CRD-07 Credit reconciliation job
[ ] #165 — NTH-05 Concurrency, load and credit-conservation evidence
[ ] #172 — CRD-08 Reservation timeout compensation (expected closure as superseded)
```

## Update protocol for future sessions

Before starting another assigned issue:

1. Pull `main` and record the new commit.
2. Re-read this file and the full live GitHub issue, comments, linked PRs, and dependency states.
3. Update discrepancies, blockers, event/API contracts, shared decisions, and the dependency graph before implementation.
4. When an issue is completed, mark its tracker entry, record the PR/merge commit and meaningful implementation decisions, then reassess every dependent issue.
5. Mark uncertainty as **UNRESOLVED** until a team decision or merged code resolves it.
