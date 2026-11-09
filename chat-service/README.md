# Chat Service (N1.2)

Owned by **Patrick, Zhang Yuan and Anselm**, the N1.2 owners. Messages between an errand's
requester and its current courier, so they can agree details inside the application and a later
dispute has a record of it. The design is [ADR 0012](../docs/adr/0012-participant-chat.md); the
API is [`contracts/chat-service.openapi.yaml`](../contracts/chat-service.openapi.yaml).

The fifth service's wiring came with #345, its channels and messages with
[#162](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/162), and read-only access for
administrators, the 280-character and 20-a-minute limits and the 90-day retention with
[#163](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/163). The socket that says when to
read again came with #362 and #391 on the service side, and with #399 in the web app's chat panel
([#346](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/346)).

Built on the shared runtime: `@foc/platform` (config, logging, correlation, health, the error
envelope) and `@foc/auth-client` (verifies a caller's token and resolves their live identity from
the User Service).

## Where it sits

- **Its own database and login**, `foc_chat` and `chat_service`, which no other service can open
  (`postgres-init.sh`). Migrated by the one-shot `chat-service-migrate` container.
- **Its own broker account**, `chat-service`, which may publish nothing (`rabbitmq-init.sh`). It
  reads only identity-change events, on two queues of its own per instance: one drops a suspended
  user's cached identity at once, the other closes their sockets.
- **Its own internal key**, `CHAT_INTERNAL_KEY`, accepted by the User Service (who is calling, and
  the participants' names) and the Order Service (`GET /internal/orders/{id}/chat`).
  Chat serves no `/internal/**` route, and with `INTERNAL_PORT` set the public port hides any.
- **Behind the edge** at `/api/chat/`, and the socket at `/api/chat/socket`. The edge reports the
  stack ready only while chat answers `/health`.

Chat publishes no event, so the errand and credit workflows run unchanged when it is down.

## API

All four routes need a signed-in caller, and are reached at `/api/chat/` through the edge.

| Method | Path                          | What it does                                                                                                                   |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/channels/:orderId`          | The channel: `open`, the caller's role, both participants' names, read and latest `seq`                                        |
| `GET`  | `/channels/:orderId/messages` | `{items, hasMore}`, ascending: `?after=` newer, `?before=` older, neither the latest, both `422`; `limit` 1-100, 20 by default |
| `POST` | `/channels/:orderId/messages` | `{clientId, body}`: `201` stored, `200` when this `clientId` already stored it                                                 |
| `PUT`  | `/channels/:orderId/read`     | `{seq}`: moves the caller's read position forward, never back; a `seq` above the latest is `422`                               |

An `orderId` that is not a UUID is `400 INVALID_ORDER_ID`, and `clientId` must be a UUID.

### Who may do what

Every request asks the Order Service who the errand's requester and current courier are, and
whether it has ended, and decides from that alone. Chat keeps no copy of the errand.

| Caller                                 | Read                    | Send       | Mark read |
| -------------------------------------- | ----------------------- | ---------- | --------- |
| The requester                          | Yes                     | While open | Yes       |
| The current courier                    | Yes                     | While open | Yes       |
| An administrator                       | Yes, and it is recorded | `403`      | `403`     |
| Anyone else, a former courier included | `403 NOT_PARTICIPANT`   | `403`      | `403`     |

- **Administrators** read any channel and its messages, to review a dispute. They see
  `myRole: ADMIN` and `lastReadSeq: 0`, since they have no read position. Sending and marking read
  are `403 NOT_PARTICIPANT`. A user who is both an administrator and a participant is treated as
  the participant, and those reads are not recorded. Reads are recorded one row per admin,
  errand, resource and hour, with a count, the first read's correlation ID and the last read's
  time. The admin view (#161) reads once and refreshes on request, rather than polling as the
  participant panel does, since a disputed errand stays open until it is decided.
- **A channel opens** on the first participant request while the errand has a courier and has not
  reached a final status. An administrator's read never opens one. Before that, for an errand that
  ended without one, or for an unknown errand, every route answers `404`.
- **Sending is open** while the errand has a courier and no final status. Otherwise a new message
  is `409 CHANNEL_CLOSED`. Reading and marking read still work, so a requester whose courier
  withdrew can still read the conversation, and a replacement courier sees all of it.
- **A retried send** with the same `clientId` from the same sender answers the stored message
  (`200`), even after the channel closes. With a different body it is `422 IDEMPOTENCY_KEY_REUSED`.
- **If the Order or User Service does not answer**, the request is `503` and nothing is read or
  stored: `IDENTITY_UNAVAILABLE` when the caller's own sign-in cannot be checked, `UNAVAILABLE` when
  the errand or a participant's name cannot be.

### Limits

- **Length:** 1 to 280 characters, counted as Unicode code points (`[...body].length`, so an emoji
  is one), and not only whitespace. Otherwise it is `422 VALIDATION_FAILED` with a `body` field
  error. A NUL is refused the same way.
- **Rate:** 20 new messages per sender in any 60 seconds, across all their channels, counted from
  `messages` on the database clock. The 21st is `429 RATE_LIMITED` with `Retry-After`, the whole
  seconds (at least 1) until the oldest of those 20 is 60 seconds old. A retried `clientId` answers
  `200` and is neither refused nor counted. A send takes the sender's advisory lock before the
  channel's row lock, so a burst of parallel sends from one sender stores exactly 20, and a sender
  waiting for their own lock holds no channel. It waits at most 2 s for either lock, because a
  waiting send still holds a database connection, then answers `503 UNAVAILABLE`. Nothing is stored,
  so the same `clientId` can be sent again.
- **Paging:** `after` and `before` above 2147483647, the largest `seq`, are `422`.

### Retention, for dispute review

A conversation is kept for 90 days after its errand reaches a final status (`CHAT_RETENTION_DAYS`),
long enough for a dispute and for questions about it afterwards. From then every route answers
`404`, to participants and administrators alike.

`RetentionCleanup` runs once the service listens and then daily (`CHAT_CLEANUP_INTERVAL_MS`).
`main.ts` starts it, so an app built in a test never sweeps. It asks the Order Service about each
channel opened more than 90 days ago (a channel opens only before its errand ends, so a younger one
cannot be due) and deletes those whose errand ended more than 90 days ago, with their messages and
read positions. Only a clear answer deletes anything:

- the Order Service does not answer: the channel is skipped, and the run is tried once more five
  minutes later (`CHAT_CLEANUP_RETRY_MS`), since on a stack restart chat can be up before the Order
  Service; if that also skips, the channel waits for the next daily run;
- the Order Service knows no such errand: it is kept and a warning is logged, since errands are
  never deleted and evidence should not be destroyed on a fault;
- either way the routes already answer `404` once retention ends, so nothing is shown meanwhile.

A run reads 100 channels at a time and asks about five at once, so it holds a small, fixed number of
IDs however many channels there are, and the Order Service never sees more than five of its lookups
together.

Administrators' read records are not deleted with the channel: they are the audit trail.

Chat only ever reads the errand: no route can change it. A message sent in the moment the errand
reaches a final status can still be stored, a few milliseconds after it ended. That window is
accepted: the message keeps its server time, and chat cannot change the errand either way.

### Data model

| Table                 | Holds                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `channels`            | One row per errand that opened a channel, and `latest_seq`, its newest message's number                                                                                                                          |
| `messages`            | `seq` 1, 2, 3… per channel, the sender, the browser's `client_id` (unique per sender) and the body                                                                                                               |
| `read_positions`      | How far each participant has read                                                                                                                                                                                |
| `admin_channel_reads` | Administrator reads, one row per who, which errand, `CHANNEL` or `MESSAGES`, and UTC hour: the count, the first read's correlation ID and time, the last read's time. No foreign key, so it outlives the channel |

A send takes the channel's row lock, so concurrent sends get consecutive numbers and a retry
racing its original is stored once (`test/chat.postgres.test.ts`).

## The socket

A WebSocket that tells a participant's open chat panel that a channel has new messages, so the panel
reads them at once instead of on its next poll (ADR 0012 §3). The service side came with #362 and
#391, and the web app's panel opens it since #399 (`web-app/src/lib/chat-socket.ts`). It says that
something new arrived, never what: a frame carries an errand's ID and its latest `seq`, never a
message. A client still reads through `GET /channels/:orderId/messages`, where the live Order lookup
decides access, and still sends with `POST`, so every rule above applies unchanged. A socket that
outlives its owner's right to a channel can leak a number, but no text. OpenAPI cannot describe a
socket, so this section is its contract.

**Polling stays the fallback.** While the socket is live the panel still polls every 30 seconds as
a backstop; a panel without a socket, whether refused, closed or blocked by a network, polls every 2
seconds and misses nothing. With
`CHAT_SOCKET_ENABLED=false` the service answers no upgrade at all, so every socket fails to open and
every client polls.

### Connecting

`ws://<host>/api/chat/socket` through the edge (`wss://` behind TLS), which is `/socket` on the
service's public port. The internal port takes no socket. Nothing in the URL is read: a token in
the query string is ignored, and a token must never be put there, since URLs reach logs.

1. Within 5 seconds of connecting (`CHAT_SOCKET_AUTH_TIMEOUT_MS`), the client sends one frame, `{"type":"auth","token":"…"}`,
   with the access token it sends as `Authorization: Bearer` on the HTTP routes.
2. The service checks it with the same `authenticate()` as every route: the signature and expiry,
   then the User Service for the session and account.
3. It answers `{"type":"ready"}`. After that the client sends nothing more: any further frame
   closes the socket.

### Frames from the service

| Frame                                             | When                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `{"type":"ready"}`                                | Once, after the auth frame is accepted. Read the channel once, in case something arrived while the socket connected.                 |
| `{"type":"messages","orderId":"…","latestSeq":N}` | A new message was stored in that errand's channel, and it now goes up to `N`. Read the messages after the last `seq` the client has. |

A new message goes to every open socket of the errand's requester and current courier, the
sender's other tabs included. Administrators get none, since they are not participants. A retried
send that answers the stored message (`200`) sends nothing. A nudge may be lost, repeated or arrive
out of order, so the client reads up to the highest `latestSeq` it has seen. A lost nudge costs at
most the panel's 30-second backstop poll.

The service pings every 25 seconds, and a socket that has not answered the previous ping is dropped
without a close frame. Browsers answer pings by themselves.

### Close codes

A client branches on the code. The name is the `reason` label in the metrics; the close frame's
reason text is for people.

| Code   | Name                   | When                                                                                                                        |
| ------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `4408` | `auth-timeout`         | Not signed in within 5 seconds of connecting (`CHAT_SOCKET_AUTH_TIMEOUT_MS`): no auth frame, or its check had not finished. |
| `4401` | `unauthenticated`      | The token was refused, expired, its session was revoked, or the account was suspended.                                      |
| `4401` | `identity-changed`     | The account was suspended, reactivated, or a role changed.                                                                  |
| `4503` | `identity-unavailable` | The User Service could not answer, at sign-in or at a check. The token may be fine.                                         |
| `4429` | `too-many`             | The user already has 5 sockets open on this instance, or the instance holds 1,000.                                          |
| `4429` | `too-many-pending`     | 100 sockets are waiting to sign in on this instance. See below.                                                             |
| `4400` | `bad-frame`            | Anything but one auth frame: invalid JSON, binary, over 8 KiB, or a second auth frame.                                      |
| `1001` | `shutdown`             | The service is stopping, or was stopping when the socket connected.                                                         |

**Waiting to sign in (#370).** At most 100 sockets per instance, a tenth of the 1,000, may be
waiting to sign in: from connecting until their token is checked. When all 100 places are taken, a
new socket pushes out the oldest that has not sent its auth frame, closed with `4429`
`too-many-pending`. So clients that never sign in push each other out, and a real client, which signs
in within a round trip, still gets in. A socket whose token is being checked is never pushed out;
while all 100 are, a new socket is refused with the same code. That can happen after a restart, when
every connected client reconnects at once and more than 100 wait on the User Service: those clients
poll and connect again later. `foc_chat_sockets_waiting` shows how many are waiting.

**Protocol errors (#369).** A frame that breaks the WebSocket protocol itself (a reserved opcode, an
unmasked frame, or more than 16 KiB) is closed by the WebSocket library with the standard code,
`1002`, `1007` or `1009`. Any client can send one, so it is not an error of the service: each is
counted in `foc_chat_socket_protocol_errors_total` by the library's error code, and logged at WARN
without a stack, at most once a minute, with how many went unlogged since and the edge's correlation
ID. The close counts as `client-closed` in `foc_chat_socket_closes_total`.

**At the edge (#371).** The edge holds at most ten sockets per address. It refuses an eleventh
before the upgrade with `429 TOO_MANY_SOCKETS` and `Retry-After: 60`, as it refuses an eleventh
live-update stream. A browser sees neither, only a close with `1006`, so a browser client paces its own
reconnects; the header is for other clients.

After `4401`, the client refreshes its access token and connects again, so a reactivated user or a
new role takes effect at once. After `4503`, `4429` or `1001` it polls, and connects again later
with backoff and the same token. It does not refresh the token after `4503`: an outage of the User
Service says nothing about the token. A frame over 16 KiB never reaches the service: the WebSocket
library closes it with `1009`.

### When a socket closes by itself

- **Its session is checked again every 55 seconds** (`CHAT_SOCKET_RECHECK_MS`), with the stored
  token, through the same `authenticate()`. A revoked session or a suspended account closes it with
  `4401`. A User Service that cannot answer closes it with `4503`, and the client polls until the
  service is back. A check can reuse an identity cached up to 5 seconds earlier, so a revoked
  session's socket closes within 60 seconds.
- **At its token's expiry** (`exp`), with `4401`.
- **On an identity change.** On `user.suspended`, `user.reactivated` or `user.role-changed`, every
  open socket of that user closes with `4401` within a second. A socket still signing in when the
  event arrives is not yet listed, so it misses the close: it opens, and its first check, 55 seconds
  later, closes it. Chat's own queue `foc.chat.socket-status.<random>` (exclusive, deleted with the
  instance) receives them. The event
  only makes chat forget: the reconnect is checked against the User Service afresh.

### Limits and scope

- 5 open sockets per user and 1,000 per instance, of which 100 may be waiting to sign in, then
  `4429`. At the edge, 10 per client address, then `429 TOO_MANY_SOCKETS` before the upgrade.
- The edge holds a quiet socket for 75 seconds, so the 25-second pings keep it open.
- One instance only. A message sent through one instance nudges only the sockets it holds; sockets
  across several instances would need a broker fan-out, which is out of scope.

Metrics: `foc_chat_sockets` (open now), `foc_chat_sockets_waiting` (not yet signed in),
`foc_chat_socket_nudges_total` (one per socket nudged), `foc_chat_socket_closes_total` by `reason`
(the table above, plus `client-closed` and `no-pong`), and `foc_chat_socket_protocol_errors_total`
by the WebSocket library's error `code`.

## Running this service

Node 22.12 or later (`.nvmrc`). Install and build once from the repository root (`npm install`,
then `npm run build`): the service imports the compiled `@foc/platform` and `@foc/auth-client`, so
build again after pulling a change to either. Run these from the root:

| Command                                  | What it does                                                                                                         |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `npm run dev:chat`                       | Start with reload on change                                                                                          |
| `npm run build -w @foc/chat-service`     | Compile TypeScript to `dist/`                                                                                        |
| `npm test -w @foc/chat-service`          | Run this service's tests; with `TEST_POSTGRES_URL` also the real-PostgreSQL send races, which are skipped without it |
| `npm run typecheck -w @foc/chat-service` | Type-check without emitting                                                                                          |

### Ports

| Port | What                                                                          |
| ---- | ----------------------------------------------------------------------------- |
| 3006 | Public: `/health`, `/metrics`, the chat routes and `/socket`. 127.0.0.1 only. |
| 4005 | Internal: not published (`compose.dev.yaml` publishes it locally).            |

### Required environment

On top of the shared base (`SERVICE_NAME`, `PORT`, `NODE_ENV`, `LOG_LEVEL`, `CORS_ORIGINS`,
optional `INTERNAL_PORT`, `RABBITMQ_URL`, `TRUSTED_PROXY` and `METRICS_TOKEN`):

| Variable               | Example                               | Notes                                                            |
| ---------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`         | `postgres://…@postgres:5432/foc_chat` | Migrated by the one-shot migrate step before the service starts. |
| `USER_SERVICE_URL`     | `http://user-service:4001`            | The User Service's internal port, for identity introspection.    |
| `ORDER_SERVICE_URL`    | `http://order-service:4003`           | The Order Service's internal port, for the chat lookup.          |
| `INTERNAL_SERVICE_KEY` | `CHAT_INTERNAL_KEY` from `.env`       | Presented as `X-Service-Key`.                                    |

Optional, with the defaults of ADR 0012:

| Variable                      | Default    | Notes                                                              |
| ----------------------------- | ---------- | ------------------------------------------------------------------ |
| `CHAT_RETENTION_DAYS`         | `90`       | Days after the errand ends that the conversation is kept.          |
| `CHAT_CLEANUP_INTERVAL_MS`    | `86400000` | How often the cleanup runs; at least a minute, at most ~24.8 days. |
| `CHAT_CLEANUP_RETRY_MS`       | `300000`   | How soon a run that skipped a channel is tried once more.          |
| `CHAT_SOCKET_ENABLED`         | `true`     | `false` refuses every socket upgrade, and clients poll.            |
| `CHAT_SOCKET_RECHECK_MS`      | `55000`    | How often an open socket's session is checked again; 5 s to 55 s.  |
| `CHAT_SOCKET_AUTH_TIMEOUT_MS` | `5000`     | How long a new socket has to send its auth frame; 1 s to 30 s.     |

A missing required variable stops the service at boot and names the variable.

To run it by hand against the rest of the stack, work from the repository root. `npm run dev:chat`
runs in `chat-service/`, so it never reads the root `.env`: load it into the shell first. `.env`
says `NODE_ENV=production`, which a service run by hand should not use.

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d   # publishes the internal ports 4001 and 4003
docker compose stop chat-service                            # it holds port 3006
set -a; . ./.env; NODE_ENV=development; set +a
DATABASE_URL=$HOST_CHAT_DATABASE_URL npm run db:migrate -w @foc/chat-service
DATABASE_URL=$HOST_CHAT_DATABASE_URL USER_SERVICE_URL=http://localhost:4001 \
  ORDER_SERVICE_URL=http://localhost:4003 INTERNAL_SERVICE_KEY=$CHAT_INTERNAL_KEY \
  npm run dev:chat
curl -i http://localhost:3006/health
```

The stack still routes to the stopped container, so the web app's chat panel and its socket do not
reach this process: call it at `http://localhost:3006`.

Without `RABBITMQ_URL` neither identity-change queue is declared, so a suspension reaches chat only
through the 5-second cache and the socket's recheck.

### An existing `.env` and Compose volume

`./scripts-init-env.sh` adds chat's new secrets but never changes a value already set, so delete
the `INTERNAL_SERVICE_KEYS` line from an older `.env` first: rebuilt, it includes
`CHAT_INTERNAL_KEY`, and the User Service accepts chat's calls.

`postgres-init.sh` runs only on a fresh data volume, so a stack created before this service has
no `foc_chat` database and `chat-service-migrate` fails. Either start over with
`docker compose down -v`, or create the role and database by hand with the statements for
`chat_service` in `postgres-init.sh`.

### Tests

- `test/chat.test.ts` runs the real modules over an in-memory PostgreSQL (PGlite), with stand-ins
  for the Order and User Services. It covers opening, closing, who may read and send, retries,
  paging, read positions, failing closed, that chat only ever reads the errand, administrators'
  recorded reads, the length and rate limits, retention and the cleanup.
- `test/provider.contract.test.ts` checks every route's answers against the contract, and
  `/health` up and with the database down.
- `test/chat.postgres.test.ts` races sends on real PostgreSQL (with `TEST_POSTGRES_URL` set),
  including a burst of 30 from one sender, of which exactly 20 are stored.
- `test/auth-status-wiring.test.ts` proves both identity-change subscriptions are wired when a
  broker is configured, and that an event on the socket queue closes that user's sockets.
- `test/retention.test.ts` covers the cleanup: on fake timers, the one retry after the Order
  Service did not answer; then reading in pages with a bounded number of lookups at once, and a
  failed delete.
- `test/socket-hub.test.ts` covers the socket's rules without Nest, on fake timers: signing in,
  nudges, limits, the recheck, expiry, identity changes, keep-alive, shutdown, closing once.
- `test/socket.test.ts` connects real WebSocket clients to the app: a message nudges both
  participants within a second without its text, a stranger hears nothing, a retried send nudges
  no one, a token in the query string is not accepted, a refused token closes with `4401` and any
  other frame with `4400`, and a frame that breaks the protocol closes with its code and is counted
  (#369). `test/socket-disabled.test.ts` checks
  that `CHAT_SOCKET_ENABLED=false` refuses the upgrade.

### Docker

```bash
docker build -f chat-service/Dockerfile -t foc/chat-service .
```

The build context is the repository root, because the image needs the workspace manifests,
`@foc/platform` and `@foc/auth-client`. The image runs as a non-root user and declares a
`HEALTHCHECK`.
