# Chat Service (N1.2)

Owned by **Patrick, Zhang Yuan and Anselm**, the N1.2 owners. Messages between an errand's
requester and its current courier, so they can agree details inside the application and a later
dispute has a record of it. The design is [ADR 0012](../docs/adr/0012-participant-chat.md); the
API is [`contracts/chat-service.openapi.yaml`](../contracts/chat-service.openapi.yaml).

The fifth service's wiring came with #345, its channels and messages with
[#162](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/162), and read-only access for
administrators, the 280-character and 20-a-minute limits and the 90-day retention with
[#163](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/163).

Built on the shared runtime: `@foc/platform` (config, logging, correlation, health, the error
envelope) and `@foc/auth-client` (verifies a caller's token and resolves their live identity from
the User Service).

## Where it sits

- **Its own database and login**, `foc_chat` and `chat_service`, which no other service can open
  (`postgres-init.sh`). Migrated by the one-shot `chat-service-migrate` container.
- **Its own broker account**, `chat-service`, which may publish nothing (`rabbitmq-init.sh`). It
  reads only identity-change events, to drop a suspended user's cached identity at once.
- **Its own internal key**, `CHAT_INTERNAL_KEY`, accepted by the User Service (who is calling, and
  the participants' names) and the Order Service (`GET /internal/orders/{id}/chat`).
  Chat serves no `/internal/**` route, and with `INTERNAL_PORT` set the public port hides any.
- **Behind the edge** at `/api/chat/`. The edge reports the stack ready only while chat answers
  `/health`.

Chat publishes no event, so the errand and credit workflows run unchanged when it is down.

## API

All four routes need a signed-in caller, and are reached at `/api/chat/` through the edge.

| Method | Path                          | What it does                                                                                                       |
| ------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/channels/:orderId`          | The channel: `open`, the caller's role, both participants' names, read and latest `seq`                            |
| `GET`  | `/channels/:orderId/messages` | A page of messages, ascending: `?after=` newer, `?before=` older, neither the latest; `limit` 1-100, 20 by default |
| `POST` | `/channels/:orderId/messages` | `{clientId, body}`: `201` stored, `200` when this `clientId` already stored it                                     |
| `PUT`  | `/channels/:orderId/read`     | `{seq}`: moves the caller's read position forward, never back                                                      |

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
  the participant, and those reads are not recorded.
- **A channel opens** on the first participant request while the errand has a courier and has not
  reached a final status. An administrator's read never opens one. Before that, for an errand that
  ended without one, or for an unknown errand, every route answers `404`.
- **Sending is open** while the errand has a courier and no final status. Otherwise a new message
  is `409 CHANNEL_CLOSED`. Reading and marking read still work, so a requester whose courier
  withdrew can still read the conversation, and a replacement courier sees all of it.
- **A retried send** with the same `clientId` from the same sender answers the stored message
  (`200`), even after the channel closes. With a different body it is `422 IDEMPOTENCY_KEY_REUSED`.
- **If the Order or User Service does not answer**, the request is `503 UNAVAILABLE` and nothing is
  read or stored.

### Limits

- **Length:** 1 to 280 characters, counted as Unicode code points (`[...body].length`, so an emoji
  is one), and not only whitespace. Otherwise it is `422 VALIDATION_FAILED` with a `body` field
  error. A NUL is refused the same way.
- **Rate:** 20 new messages per sender in any 60 seconds, across all their channels, counted from
  `messages` on the database clock. The 21st is `429 RATE_LIMITED` with `Retry-After`, the whole
  seconds (at least 1) until the oldest of those 20 is 60 seconds old. A retried `clientId` answers
  `200` and is neither refused nor counted. A send takes the sender's advisory lock after the
  channel's row lock, so a burst of parallel sends from one sender stores exactly 20.
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

Administrators' read records are not deleted with the channel: they are the audit trail.

Chat only ever reads the errand: no route can change it. A message sent in the moment the errand
reaches a final status can still be stored, a few milliseconds after it ended. That window is
accepted: the message keeps its server time, and chat cannot change the errand either way.

### Data model

| Table                 | Holds                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `channels`            | One row per errand that opened a channel, and `latest_seq`, its newest message's number                                                    |
| `messages`            | `seq` 1, 2, 3… per channel, the sender, the browser's `client_id` (unique per sender) and the body                                         |
| `read_positions`      | How far each participant has read                                                                                                          |
| `admin_channel_reads` | Every administrator read: who, which errand, `CHANNEL` or `MESSAGES`, the correlation ID, when. No foreign key, so it outlives the channel |

A send takes the channel's row lock, so concurrent sends get consecutive numbers and a retry
racing its original is stored once (`test/chat.postgres.test.ts`).

## Running this service

Install dependencies once from the repository root (`npm install`). Run these from the root:

| Command                                  | What it does                  |
| ---------------------------------------- | ----------------------------- |
| `npm run dev:chat`                       | Start with reload on change   |
| `npm run build -w @foc/chat-service`     | Compile TypeScript to `dist/` |
| `npm test -w @foc/chat-service`          | Run this service's tests      |
| `npm run typecheck -w @foc/chat-service` | Type-check without emitting   |

### Ports

| Port | What                                                                |
| ---- | ------------------------------------------------------------------- |
| 3006 | Public: `/health`, `/metrics`, and the chat routes. 127.0.0.1 only. |
| 4005 | Internal: not published (`compose.dev.yaml` publishes it locally).  |

### Required environment

On top of the shared base (`SERVICE_NAME`, `PORT`, `NODE_ENV`, `LOG_LEVEL`, `CORS_ORIGINS`,
optional `INTERNAL_PORT` and `RABBITMQ_URL`):

| Variable               | Example                               | Notes                                                            |
| ---------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| `DATABASE_URL`         | `postgres://…@postgres:5432/foc_chat` | Migrated by the one-shot migrate step before the service starts. |
| `USER_SERVICE_URL`     | `http://user-service:4001`            | The User Service's internal port, for identity introspection.    |
| `ORDER_SERVICE_URL`    | `http://order-service:4003`           | The Order Service's internal port, for the chat lookup.          |
| `INTERNAL_SERVICE_KEY` | `CHAT_INTERNAL_KEY` from `.env`       | Presented as `X-Service-Key`.                                    |

Optional, with the defaults of ADR 0012:

| Variable                   | Default    | Notes                                                              |
| -------------------------- | ---------- | ------------------------------------------------------------------ |
| `CHAT_RETENTION_DAYS`      | `90`       | Days after the errand ends that the conversation is kept.          |
| `CHAT_CLEANUP_INTERVAL_MS` | `86400000` | How often the cleanup runs; at least a minute, at most ~24.8 days. |
| `CHAT_CLEANUP_RETRY_MS`    | `300000`   | How soon a run that skipped a channel is tried once more.          |

A missing required variable stops the service at boot and names the variable.

```bash
curl -i http://localhost:3006/health
```

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
- `test/auth-status-wiring.test.ts` proves the identity-change subscription is wired when a broker
  is configured.

### Docker

```bash
docker build -f chat-service/Dockerfile -t foc/chat-service .
```

The build context is the repository root, because the image needs the workspace manifests,
`@foc/platform` and `@foc/auth-client`. The image runs as a non-root user and declares a
`HEALTHCHECK`.
