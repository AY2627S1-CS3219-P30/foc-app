# Chat Service (N1.2)

Owned by **Patrick, Zhang Yuan and Anselm**, the N1.2 owners. Messages between an errand's
requester and its current courier, so they can agree details inside the application and a later
dispute has a record of it. The design is [ADR 0012](../docs/adr/0012-participant-chat.md); the
API is [`contracts/chat-service.openapi.yaml`](../contracts/chat-service.openapi.yaml).

The fifth service's wiring came with #345, and its channels and messages with
[#162](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/162). Still to come with
[#163](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/163): read-only access for
administrators, the 280-character and 20-a-minute limits, and the 90-day retention.

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

- **The requester and the current courier** may read, send and mark read. Anyone else, a former
  courier included, gets `403 NOT_PARTICIPANT`. Administrators do too, until #163 lets them read.
- **A channel opens** on the first such request while the errand has a courier. Before that, or
  for an unknown errand, every route answers `404`.
- **Sending is open** while the errand has a courier and no final status. Otherwise a new message
  is `409 CHANNEL_CLOSED`. Reading and marking read still work, so a requester whose courier
  withdrew can still read the conversation, and a replacement courier sees all of it.
- **A retried send** with the same `clientId` from the same sender answers the stored message
  (`200`), even after the channel closes. With a different body it is `422 IDEMPOTENCY_KEY_REUSED`.
- **If the Order or User Service does not answer**, the request is `503 UNAVAILABLE` and nothing is
  read or stored.

Chat only ever reads the errand: no route can change it. A message sent in the moment the errand
reaches a final status can still be stored, a few milliseconds after it ended. That window is
accepted: the message keeps its server time, and chat cannot change the errand either way.

### Data model

| Table            | Holds                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| `channels`       | One row per errand that opened a channel, and `latest_seq`, its newest message's number            |
| `messages`       | `seq` 1, 2, 3… per channel, the sender, the browser's `client_id` (unique per sender) and the body |
| `read_positions` | How far each participant has read                                                                  |

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
  paging, read positions, failing closed, and that chat only ever reads the errand.
- `test/provider.contract.test.ts` checks every route's answers against the contract, and
  `/health` up and with the database down.
- `test/chat.postgres.test.ts` races sends on real PostgreSQL (with `TEST_POSTGRES_URL` set).
- `test/auth-status-wiring.test.ts` proves the identity-change subscription is wired when a broker
  is configured.

### Docker

```bash
docker build -f chat-service/Dockerfile -t foc/chat-service .
```

The build context is the repository root, because the image needs the workspace manifests,
`@foc/platform` and `@foc/auth-client`. The image runs as a non-root user and declares a
`HEALTHCHECK`.
