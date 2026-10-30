# Chat Service (N1.2, NTH-11 #345)

Owned by **Patrick, Zhang Yuan and Anselm**, the N1.2 owners. Messages between an errand's
requester and its current courier, so they can agree details inside the application and a later
dispute has a record of it. The design is [ADR 0012](../docs/adr/0012-participant-chat.md); the
API is [`contracts/chat-service.openapi.yaml`](../contracts/chat-service.openapi.yaml).

This is the fifth service's wiring (#345): it starts, reports healthy, and is built, tested,
backed up and restored like the other four. It serves no chat route yet. Those come with
[#162](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/162) (channels, messages and the
Order lookup) and [#163](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/163) (access,
limits and retention).

Built on the shared runtime: `@foc/platform` (config, logging, correlation, health, the error
envelope) and `@foc/auth-client` (verifies a caller's token and resolves their live identity from
the User Service).

## Where it sits

- **Its own database and login**, `foc_chat` and `chat_service`, which no other service can open
  (`postgres-init.sh`). Migrated by the one-shot `chat-service-migrate` container.
- **Its own broker account**, `chat-service`, which may publish nothing (`rabbitmq-init.sh`). It
  reads only identity-change events, to drop a suspended user's cached identity at once.
- **Its own internal key**, `CHAT_INTERNAL_KEY`, accepted by the User Service (who is calling, and
  the participants' names) and the Order Service (`GET /internal/orders/{id}/chat`, from #162).
  Chat serves no `/internal/**` route, and with `INTERNAL_PORT` set the public port hides any.
- **Behind the edge** at `/api/chat/`. The edge reports the stack ready only while chat answers
  `/health`.

Chat publishes no event, so the errand and credit workflows run unchanged when it is down.

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

`test/provider.contract.test.ts` boots the real module and checks `/health`, up and with the
database down, against the contract, along with the correlation ID and the error envelope.
`test/auth-status-wiring.test.ts` proves the identity-change subscription is wired when a broker
is configured.

### Docker

```bash
docker build -f chat-service/Dockerfile -t foc/chat-service .
```

The build context is the repository root, because the image needs the workspace manifests,
`@foc/platform` and `@foc/auth-client`. The image runs as a non-root user and declares a
`HEALTHCHECK`.
