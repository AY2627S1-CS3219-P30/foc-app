# ADR 0011 — Live updates: a nudge, not the data

- **Status:** Proposed; implementation basis
- **Date:** 2026-10-28
- **Deciders:** Group 30; approvals tracked in [the ADR index](README.md)
- **Ticket:** N1.4 [#329](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/329)
- **Built by:** [#329](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/329) (the Order
  Service), [#330](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/330) (the edge),
  [#331](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/331) (the web app)

## Context

The execution plan chose Server-Sent Events for one-way errand status, with polling as the fallback
(WEB-04, "Live updates"). What was built is polling only (`web-app/src/lib/use-poll.ts`): an errand
page reads again every 30 seconds once its errand is settled, and stops after ten minutes without a
change. So a requester sees *Accepted* up to half a minute after a courier accepted, and a courier's
board can show an errand someone else took seconds ago. The asynchronous workflow is correct but
looks slow.

The Order Service already publishes `order.status-changed` from its outbox after every transition,
with the errand's version (EI-NFR2.1.1). Nothing reads it.

## Decision

### 1. One stream per tab, one way, over Server-Sent Events

`GET /live` on the Order Service (`/api/order/live` through the edge) answers `text/event-stream`.
Updates go one way, from the service to the page, so a WebSocket's second direction would be
unused; SSE is plain HTTP, which the edge already routes and limits.

### 2. A nudge, not the data

A stream never carries an errand. It sends:

| Event | To | Data |
| --- | --- | --- |
| `ready` | the new stream, once | `{}`: read everything shown, to catch up |
| `errand` | the errand's requester and courier | `{"orderId", "version"}` |
| `board` | every stream, at most once a second | `{}`: an errand joined or left the open list |
| `: keep-alive` | every stream, every 20 s | a comment |

On a nudge the page reads again through the ordinary endpoints, which apply their ordinary rules.
So the stream cannot show anything the API would not; a lost nudge costs a delay until the next
poll, and a repeated or reordered one costs at most one read. Nothing needs replaying after a
reconnect: `ready` makes the page read everything once. `errand` goes to the participants the API
already recognises (OS-FR2.1.2), read from the errand's row after the change. `board` tells nobody
anything new: every student can see the open list.

### 3. On the Order Service, fed by its own event

The stream is a module of the Order Service (`order-service/src/orders/live/`), not a service of its
own: the rule for who an errand concerns, and the broker account, are already there. Each instance
consumes `order.status-changed` through a queue of its own, as every service does for identity
changes (`authStatusEvents`): exclusive and auto-deleted, a 30-second message TTL, at most 1,000
messages. Every instance sees every change, because each holds its own streams. The queue holds
nothing durable, so the event still has no durable consumer, stays out of `REQUIRES_CONSUMER`, and
is delivered exactly as before. A message the handler fails on is dropped, as on any per-instance
queue; polling covers it.

### 4. Authenticated once, and never for long

The caller is authenticated like on every other route, when the stream opens. The stream ends
itself after `LIVE_STREAM_MAX_MS` (5 minutes), and the page reconnects with its current token, so a
revoked session or a suspended account loses its stream within 5 minutes; until then it receives
nudges only, and every read one causes is refused. Limits: 5 streams per user and 1,000 per
instance, answered `429 TOO_MANY_STREAMS` and `503 LIVE_UNAVAILABLE` with `Retry-After: 60`.
`LIVE_UPDATES_ENABLED=false` refuses every stream: one restart, and every page polls as it did.

### 5. Polling stays

Live updates only add reads. Every page keeps its polling, at the same intervals, so a page without
a stream, refused, offline or behind a proxy that buffers, behaves exactly as before.

### 6. A stream is not a request

A stream stays open for minutes and the client ends it. The platform's request logger therefore
does not time a `text/event-stream` response into `http_request_duration_seconds`, where it would
put minutes into the latency percentiles, and logs it once as `stream ended`. The stream has its own
metrics: `foc_live_streams`, `foc_live_nudges_total{kind}`, `foc_live_refused_total{reason}`.

## Alternatives considered

- **Polling only**, as built. Correct, and kept as the fallback; but half a minute behind, which is
  what this record changes.
- **Push the errand itself** in the stream. It would save a read, but the stream would then need its
  own copy of every rule about who may see which field of an errand, and a lost or reordered message
  would leave a page wrong rather than late.
- **A WebSocket.** Two-way, which updates do not need, and a second protocol for the edge to pass
  through. Chat (N1.2) chooses its own transport.
- **A separate live-update service.** Better isolated, but it would need its own container, broker
  account, internal endpoint for an errand's participants, CI and image: about two more days, past
  the scope freeze. The module is self-contained, so it can move out if it needs to.
- **`EventSource` with the token in the URL or a cookie.** `EventSource` cannot send an
  `Authorization` header; the access token is held in memory, and in a URL it would be written to
  the edge's access log. The web app reads the stream with `fetch` instead.
- **Replaying missed events (`Last-Event-ID`).** A nudge carries nothing to replay; reading again on
  `ready` recovers the same.

## Consequences

- A change reaches the pages it concerns within about a second, through the outbox relay and the
  broker, instead of at the next poll.
- The Order Service holds long-lived connections. They are capped, end themselves, and are ended
  when the service stops, after which no new one opens, so a shutdown does not wait on them. A
  stream is released when its connection closes, including one whose browser left before it was
  authenticated. Each stream also holds two of the edge's connections (#330).
- A courier who loses an errand, by withdrawing or by not picking it up in time, is no longer its
  courier, so gets no `errand` nudge for it. The errand goes back on the board, so they get `board`;
  their page learns the rest at its next poll unless it reads again on `board` (#331).
- Administrators' pages get nothing; the console keeps polling.

## Revisit if

- The Order Service runs several instances behind a balancer: the limits are per instance, and
  nothing else changes, since every instance sees every change.
- Chat or the console needs pushes: they can reuse the stream, as more kinds of nudge.
- Many more students than a campus: a nudge to every stream on `board` is the part that grows with
  them.
