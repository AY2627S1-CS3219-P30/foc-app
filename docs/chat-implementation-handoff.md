# Participant chat implementation handoff — #161, #162, #163

Status: **preparation, not implemented or approved by the three feature owners**. Checked against
main `6ef37ca` on 28 October 2026. This document supports the live-chat dependency of #167; it does
not complete any chat ticket or claim that Isaac implemented another member’s graded feature.

Isaac explicitly selected **90 days after the errand ends** in this Codex thread. Messages on an
active errand are retained. His earlier description uses a separate chat service, WebSocket live
messages and HTTP history. These are his directions, not evidence that Patrick, Zhang Yuan and
Anselm recorded agreement. Merged #326 says implementation belongs to those owners; a scope
clarification is pending in this thread. The proposal in [nice-to-haves](nice-to-haves.md#n12-participant-chat)
remains proposed until its owners settle it.

## What exists and can be reused

| Existing code | Relevant behavior | Limit for chat |
| --- | --- | --- |
| `platform/src/events/catalogue.ts`, `orderStatusChangedPayload` | Status, occurrence time, optional order version; no private participant details | Older v1 events may omit the version; consumers cannot assume it exists |
| `order-service/src/orders/orders.repository.ts` | Writes transitions/history/outbox together; publishes status changes | No internal chat-authorization projection exists |
| `OrdersRepository.participants()` | Includes every former accepting courier, not just the current courier | Do not use this list as chat read/send authorization; #163 specifies the assigned courier |
| `projectOrder()` in `orders.service.ts` | Current requester/courier get private details; an admin must be the referred admin | #163 allows an administrator to read chat; the broader chat admin permission needs an explicit policy |
| `auth-client/src/authenticator.ts`, `createAuthenticator()` | Verifies the token and live session/account/roles | A WebSocket handshake alone does not keep a long-lived socket authorized |
| `auth-client/src/status-events.ts` | Invalidates cached identity after suspension, reactivation or role change | Bound socket revalidation and close/deny revoked sessions as well |
| `platform/src/events/consumer.ts`, `inbox.ts` | Trusted producer validation, bounded retries, deduplication | Add a durable chat subscription and transactional application; do not implement a second consumer protocol |
| `platform/src/bootstrap.ts`, `startService()` | Keeps `/internal/**` off the public listener in Compose | New internal routes must use service authentication and the private listener |
| `user-service/src/users/internal.controller.ts` | Service-key-protected identity endpoints | Current lookup used by Order returns existence/status, not the other participant’s display name |
| `web-app/src/app/(app)/request/[id]/OrderDetail.tsx` | Existing errand detail and participant history | Chat belongs here; a hidden button is never the authorization boundary |

## Dependency order and why

```text
Owner policy / contract decisions
  ├── Deployment + database + broker + private Order lookup
  │     └── #162 lifecycle and durable storage
  │           └── #163 read/send authorization, limits and retention
  │                 └── #161 panel, reconnect history, unread state
  │                       ├── Extend the #160 browser suite with chat
  │                       └── #167 live chat runbook segment
  └── All of the above + two actual non-owner rehearsals → #167 acceptance
```

The issue dependencies are explicit: #161 depends on #162/#163; #163 depends on #162 and USR-03;
#162 depends on ORD-04. The deployment/private-lookup edge is inferred from concrete missing code:
a fifth service needs a runnable container, its own database/role and a way to ask Order about
current participants. Frontend pagination and unread state depend on a stable message identity
and cursor contract; they cannot be implemented correctly from an issue title alone.
#160’s core suite is already merged in #325. Chat adds its own browser journey to that suite; it
does not make the existing core evidence disappear.

## Decisions to settle before production implementation

1. **Current participant and reassignment policy.** On withdrawal or suspension/reassignment the
   former courier immediately loses chat permission. The requester can retain access. Specify
   whether a replacement courier reads the earlier conversation or only their assignment segment.
   The tickets say one channel per errand; do not silently create multiple independent channels.
2. **Open versus writable.** List the exact statuses that permit sending, including `DISPUTED`,
   `COMPLETION_PENDING_CREDIT`, `RELEASE_PENDING_CREDIT`, and an errand reopened to `OPEN` after
   withdrawal. All terminal states reject sending server-side. Keep retained history readable to
   authorized readers after terminal closure until its retention deadline.
3. **Terminal/send race.** A remote Order lookup followed by a Chat database insert is not atomic
   with Order committing a terminal transition. Define the admission boundary and prove it with a
   race test. Do not claim that a cached event projection or a read-before-write check alone proves
   “no sends after terminal.” Any stronger coordination must preserve separate service databases.
4. **Event recovery.** Apply versions monotonically, deduplicate transactionally, and reconcile
   missing-version events against authoritative Order state. A late ACCEPTED event must not reopen
   a terminal channel. Decide how already-accepted errands gain a channel when chat is first deployed;
   historical status events were not previously required to reach a consumer.
5. **Retention boundary.** Use the authoritative terminal occurrence time, not event receipt time.
   The chosen period is 90 days after that point. Keep a tombstone/version fence after deleting
   message content so replay cannot recreate expired history. State cleanup frequency, backup
   retention implications and restart behavior; do not promise instantaneous physical erasure.
6. **Limits and transport.** Record the per-participant rate/window, bounded text/frame size, paging
   limit, reconnect behavior and error codes. These numeric limits remain **UNRESOLVED**; the issue
   requires an enforced/tested rate limit, not a particular number. Escape message text in the UI.
7. **Socket credentials.** Keep tokens out of URLs and logs. Specify the browser-compatible auth
   exchange, origin checks, handshake deadline, session revalidation and expiry handling. The existing
   refresh cookie belongs to `/api/user/auth`; a chat socket does not automatically receive it.
8. **Names and admin access.** Obtain display names from an authorized server projection, not a new
   unrestricted user directory. Choose where an administrator opens history and how that read is
   audited. An administrator who is not a participant may read but may not send (#163).

## Work by ticket

| Ticket / owner | Concrete deliverable | Evidence needed before closure |
| --- | --- | --- |
| #162 / Zhang Yuan | One errand-bound channel, durable message storage/lifecycle, private authoritative Order projection, version-safe event application and terminal retention metadata | Duplicate/reordered/missing-version events, initial deployment catch-up, terminal non-reopening, withdrawal/reassignment, service restart and no Order state changes from chat |
| #163 / Anselm | Reuse verified identity and authoritative current-participant policy for HTTP and sockets; active-only sends, admin read-only access, rate limits and 90-day retention | Outsider read/send 403, former courier refusal, admin send refusal, suspension/logout/expiry on an established socket, terminal/send race, persisted limits across the chosen deployment model, cleanup boundary and no replay resurrection |
| #161 / Patrick | Panel with both names, live messages, paged history on reconnect, stable message IDs, unread state, closed-channel UX at 360/768/1440 | Reconnect after missed messages, multiple history pages without duplicates/gaps, repeated client-send handling, terminal refusal, accessible responsive controls and a real container-backed browser journey |

Agree the message ordering/cursor and client idempotency contract together. Pagination must remain
stable when a new message arrives while older history is loading. If a socket disconnects after the
server commits a message but before its acknowledgement reaches the client, resending must not
silently duplicate the message. A send failure must not be displayed as successful delivery.

## Integration checklist for a fifth service

- **Build/runtime:** workspace/package/lockfile, service Dockerfile and migrate command, Compose
  service/migrate entries, its own database/role in `postgres-init.sh`, generated credentials in
  `scripts-init-env.sh`/`.env.example`, service-key registration, broker identity/permissions in
  `rabbitmq-init.sh`, private/public network separation and edge WebSocket forwarding.
- **Events:** register the durable queue and trusted Order producer. Review
  `REQUIRES_CONSUMER` in `platform/src/events/catalogue.ts`: it currently excludes
  `order.status-changed` because there is no durable reader. Changing it affects startup behavior
  when a producer runs before the first consumer has declared its queue; test that deliberately.
- **CI/images:** `scripts-ci-detect.sh` enumerates four services; the browser Bake target lists and
  `.github/workflows/ci.yml` publication `APPLICATIONS` enumerate five app images. Add Chat to the
  appropriate builds, tests, scans, publication and `compose.images.yaml` before declaring it deployed.
- **Operations:** update readiness, metrics, queue/dead-letter visibility, restart and failure tests.
  A chat outage must not break the economic workflow; it must be visible as unavailable chat.
- **Recovery:** `scripts-recovery.py` lists exactly four databases, and `scripts-backup.sh` stops four
  writers and dumps those four databases. Extend bundle/version validation, quiescence, fingerprints,
  restore and drill coverage for Chat. Explicitly handle old four-database backups and releases that
  have no chat image; do not claim complete rollback using a tag with no matching new image.
- **Demo/tests:** extend the named seed/runbook as required, provide all participant/admin chat tabs,
  and extend the release suite. The test-only clock override currently advances four backends; if
  Chat depends on their timestamps, add it coherently and test retention on the disposable stack.

## Completion evidence and ownership

Merge only after the chosen contract, service tests, real PostgreSQL/RabbitMQ tests, responsive
browser journey and complete required CI pass. Cite the final commit/run and actual behavior in
#161–#163 and #167. Attribute implementation and review honestly. Agent checks and CI runs are not
owner agreement, a teammate review, or either of the two non-owner rehearsals required by #167.
