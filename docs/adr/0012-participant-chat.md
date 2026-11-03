# ADR 0012 — Participant chat: a fifth service that asks the Order Service

- **Status:** Proposed; implementation basis
- **Date:** 2026-10-29
- **Deciders:** Patrick, Zhang Yuan and Anselm, the N1.2 owners; approvals tracked in
  [the ADR index](README.md)
- **Ticket:** N1.2 [#344](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/344)
- **Built by:** [#345](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/345) (the service),
  [#162](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/162) (messages and the Order
  lookup), [#163](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/163) (access, limits and
  retention), [#161](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/161) (the web app),
  later [#346](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/346) (the WebSocket)
- **Contract:** [`contracts/chat-service.openapi.yaml`](../../contracts/chat-service.openapi.yaml)

## Context

Once a courier accepts an errand, its requester and courier have no way to talk inside the
application. They swap phone numbers, and a later dispute has no record of what they agreed.

Who an errand's participants are, and whether it is still running, is the Order Service's rule
(OS-FR2.1.2). Both change while a conversation is under way: a courier can withdraw, time out or be
suspended, and another courier can then accept. Chat must follow those changes without becoming a
second copy of the errand.

## Decision

### 1. A fifth service that asks the Order Service on every request

`chat-service` is its own service and container, with its own database and login (`foc_chat`),
broker account and internal key, like the other four (ADR 0003). It holds the conversation:
channels, messages and each participant's read position. It holds nothing about the errand.

Every request asks the Order Service, through `GET /internal/orders/{orderId}/chat`
(`X-Service-Key`), for `{status, version, requesterId, courierId, endedAt}`, and decides from that
answer alone. This route is specified but not implemented; #162 must add it and its provider test. So access follows a withdrawal, a new courier or a final status from the next request,
with no event to consume and no copy to fall behind. If the Order Service does not answer, chat
answers `503 UNAVAILABLE`: it fails closed. Chat publishes nothing, so the errand and credit
workflows run unchanged when it is down, and no chat action can change an errand.

### 2. Who may do what

| Caller | Read | Send | Mark read |
| --- | --- | --- | --- |
| The requester | Yes | While open | Yes |
| The current courier | Yes | While open | Yes |
| An administrator | Yes, from the console | No | No |
| Anyone else, a former courier included | `403 NOT_PARTICIPANT` | `403` | `403` |

- A channel is **open** while the errand has a courier and has not reached a final status
  (`courierId` set, `endedAt` null). Sending to a closed channel is `409 CHANNEL_CLOSED`.
- A channel exists from the first authorized request made while the errand has a courier.
  Acceptance alone does not create one: if the courier withdraws before anyone opens chat, no
  channel exists and the routes answer `404` until a later assigned courier allows it to open.
  Unknown errands and expired retention also answer `404`.
- The `404`/`403` distinction deliberately exposes channel availability to an authenticated caller,
  in addition to the errand status already visible in the feed. It must not expose message contents
  or participant display names to a non-participant. This metadata tradeoff is part of the contract
  the owners review, not a claim that the two refusals are indistinguishable.
- A **replacement courier** sees the whole conversation, the former courier's messages included,
  and the former courier loses access at once: they are no longer `courierId`.
- **Administrators** read any channel, to review a dispute, and cannot send or mark read. A user who
  is both an administrator and a participant is treated as the participant.
- The caller is identified as on every other service, by asking the User Service (ADR 0004). The
  two display names come from the same User Service lookup.

### 3. Polling first; reads always go through `GET /messages`

Messages are numbered per channel (`seq` 1, 2, 3…) in chat's database. The web app reads
`GET /channels/{orderId}/messages?after=<latest seq>` every 2 seconds while the channel is open,
paging until `hasMore` is false, which is also how it catches up after being offline. `before=`
pages back through older messages.

A notify-only WebSocket comes later (#346). It sends "new messages up to `seq` N" and never a
message, as in ADR 0011: the page still reads through `GET /messages`, where the live Order lookup
decides access. Sends stay `POST` either way.

### 4. A send is stored once

`POST /channels/{orderId}/messages {clientId, body}` carries a `clientId` the browser makes up. A
retry with the same `clientId` from the same sender answers `200` with the message already stored,
even if the channel has since closed or the sender has since reached the limit; a new message
answers `201`. The same `clientId` with a different body is `422 IDEMPOTENCY_KEY_REUSED`.

### 5. Limits

- **Length:** 1 to 280 characters, counted as Unicode code points (`[...body].length`), the same
  in the browser and the service; a body of only whitespace is refused. Both are
  `422 VALIDATION_FAILED`.
- **Rate:** 20 new messages a minute per sender, across all their channels, counted from chat's own
  database over the last 60 seconds. Over it is `429 RATE_LIMITED` with `Retry-After`, the seconds
  until the oldest of those messages leaves the window. A repeated send does not count.

### 6. Kept 90 days after the errand ends

A conversation is kept for 90 days after its errand reaches a final status, so it is there for a
dispute and for questions about it afterwards. From then every route answers `404`, and a daily job
deletes the channel with its messages and read positions, asking the Order Service when each errand
ended.

## Alternatives considered

- **A module of the Order Service**, as live updates are (ADR 0011). It would need no lookup, but
  chat would then share Order's database and container with the errand and credit workflow, and a
  burst of messages would load the service that settles credits.
- **Following `order.status-changed`** to keep chat's own copy of each errand's participants and
  status. It saves a call per request, but the copy is behind for as long as the event takes, so a
  courier who just withdrew could still read, and a missed event leaves it wrong until the next.
  The event would also gain its first durable consumer.
- **A WebSocket first.** Nothing in the stack supports one yet: no service has a WebSocket library,
  and the edge clears `Connection` on every route. Polling ships by 3 November; the socket follows as
  a nudge (#346).
- **Administrators sending.** A third voice in the conversation would be part of the evidence it is
  read as. An administrator decides a dispute through the console instead.
- **A rate limit in memory, or at the edge.** Memory is per instance and lost on restart; the edge
  cannot tell a sender from their address. Counting stored messages is exact and needs no new store.

## Consequences

- Each request costs one call to the Order Service and one to the User Service, and polling makes
  one request every 2 seconds per open panel. At campus scale both are small.
- Chat is down whenever the Order Service is; nothing else is affected when chat is.
- The Order Service gains its first internal route for another service, and accepts chat's internal
  key.
- The stack goes from four services to five: Compose, a database and login, CI, the edge, backup
  and recovery (#345).
- Administrators' channel reads are not yet counted towards the unusual-activity alert of ADR 0008.

## Revisit if

- Polling load matters: the WebSocket (#346) replaces the timer, and the lookups can be cached for a
  few seconds, as caller identity already is.
- The daily cleanup has too many channels to ask about: chat can store each channel's deletion date
  once its errand has ended, since a final status never changes.
- Students need to send anything but text, or an administrator needs to take part.
