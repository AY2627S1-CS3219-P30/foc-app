# CS3219 — Software Design and Architecture (AY2627 Sem 1)

## Friend on Campus (FoC)

**Friend on Campus (FoC)** is a peer-to-peer campus errand platform where
students can request items to be collected from stores or facilities on
campus, and other students can fulfil (and deliver) those requests. The
platform runs on a closed credit economy — credits cannot be bought,
withdrawn, or exchanged for money, and only circulate within the platform.

---

## Team Members

| Name           | Role                               |
| -------------- | ---------------------------------- |
| Anselm Long    | Developer/LinkedInfluencer         |
| Zhang Yuan     | Developer/Hasn't showered in weeks |
| Jonus Ho       | Developer/BTS 8th member           |
| Isaac Chua     | Developer/Goat                     |
| Patrick Thomas | Developer/Diversity hire           |

---

## Getting Started

Everything below is run from the **repository root** unless stated otherwise.

### 1. Install the prerequisites

| Tool                                                              | Version            | Why                                |
| ----------------------------------------------------------------- | ------------------ | ---------------------------------- |
| [Node.js](https://nodejs.org)                                     | **22.12 or later** | Node 20 is past end of life        |
| [Docker Desktop](https://www.docker.com/products/docker-desktop/) | any current        | Running the services in containers |
| [Bun](https://bun.sh)                                             | any current        | **Only** needed for `web-app`      |
| Git                                                               | any current        | —                                  |

If you use [nvm](https://github.com/nvm-sh/nvm), the right Node version is already
pinned in `.nvmrc`:

```bash
nvm install   # first time only
nvm use       # in every new terminal
node --version   # expect v22.x
```

### 2. Clone and install

```bash
git clone https://github.com/AY2627S1-CS3219-P30/foc-app.git
cd foc-app
npm install
```

> **Run `npm install` once, from the root.** This is an npm workspace, so a
> single install covers `platform/` and all four services. Running `npm install`
> inside a service folder is not needed and will create a nested `node_modules`
> that shadows the shared one.

### 3. Create your `.env`

```bash
cp .env.example .env
```

The services read `.env` automatically. Real environment variables always win,
so Docker and CI are unaffected. A missing required variable stops a service at
boot and tells you which one — nothing falls back to an insecure default.

### 4. Run a service

Each `dev` script supplies its own `SERVICE_NAME` and `PORT`, so nothing needs
exporting first. Code changes reload automatically.

```bash
npm run dev:user       # http://localhost:3001
npm run dev:supplier   # http://localhost:3002
npm run dev:order      # http://localhost:3003
npm run dev:credit     # http://localhost:3004
```

Supplier, Order and Credit verify callers through the User Service, so they also
need `USER_SERVICE_URL` and `INTERNAL_SERVICE_KEY`. User, Supplier and Credit own
persistence and require their service-specific `DATABASE_URL` too. Put them in
your `.env` or shell; see `.env.example`. A missing value stops the service at
boot and names it.

Check it is alive:

```bash
curl -i http://localhost:3001/health
# {"status":"ok","service":"user-service","version":"0.1.0","uptimeSeconds":3}
```

### 5. Run the web app

`web-app` uses Bun and is deliberately **outside** the npm workspace, so the two
package managers never contend for one `node_modules`.

```bash
cd web-app
bun install
bun dev        # http://localhost:3000
```

### 6. Run the whole stack in Docker

One command brings up the web app, all four services, PostgreSQL and RabbitMQ:

```bash
cp .env.example .env     # if you have not already
docker compose up -d --build
docker compose ps        # every row should read healthy
```

Then open <http://localhost:3000>.

| Command                               | What it does                                 |
| ------------------------------------- | -------------------------------------------- |
| `docker compose up -d --build`        | Build and start everything                   |
| `docker compose ps`                   | Show health of each container                |
| `docker compose logs -f user-service` | Follow one service's logs                    |
| `docker compose restart`              | Restart everything, **keeping** data         |
| `docker compose down`                 | Stop and remove containers, **keeping** data |
| `docker compose down -v`              | Stop and **delete the databases too**        |
| `./scripts-smoke.sh`                  | Verify the running stack                     |
| `./scripts-smoke.sh --up`             | Verify a separate copy, then delete it       |

`docker compose down` keeps your data. Use `-v` only when you want a clean
database — it is also the only way to re-run `postgres-init.sql`, which runs
once when the data volume is empty.

**Data isolation.** One PostgreSQL server hosts four databases with four roles,
one per service. Each role can connect only to its own database — a service
cannot read another service's tables even by accident. A single server rather
than four keeps a laptop usable during the demo; production can split the
instances with no application change, because each service already connects with
its own credentials. See [`postgres-init.sql`](postgres-init.sql).

**Ports.** PostgreSQL is published on **55432** and RabbitMQ on **55672**, not
their defaults, because a locally installed copy usually holds 5432 and 5672 and
`up` would fail to bind. Override any port in `.env`. RabbitMQ's management UI is
at <http://localhost:15672> (`foc` / `foc_dev`). The operator dashboard is
Grafana at <http://localhost:3005>, open to view without signing in, with
Prometheus behind it at <http://localhost:9090>; see [Observability](#observability).

**Connections.** Compose gives each service its own `DATABASE_URL` and the shared
`RABBITMQ_URL`. User, Supplier and Credit apply their own migrations through
one-shot containers before starting. Services talk to the browser directly with
CORS; a thin gateway is a later ticket.

### 7. Check your setup

```bash
npm run build       # compile every service
npm test            # no env vars needed
npm run lint
npm run typecheck
npm run format      # apply Prettier
```

All four should pass on a fresh clone. For the containerized stack:

```bash
./scripts-smoke.sh --up
```

If that prints `All smoke checks passed`, you are set up correctly.

---

## Ports and ownership

| Service            | Port | Owner      | Dev command             |
| ------------------ | ---- | ---------- | ----------------------- |
| `web-app`          | 3000 | Patrick    | `cd web-app && bun dev` |
| `user-service`     | 3001 | Anselm     | `npm run dev:user`      |
| `supplier-service` | 3002 | Patrick    | `npm run dev:supplier`  |
| `order-service`    | 3003 | Zhang Yuan | `npm run dev:order`     |
| `credit-service`   | 3004 | Isaac      | `npm run dev:credit`    |
| `grafana`          | 3005 | Jonus      | Compose only            |
| `prometheus`       | 9090 | Jonus      | Compose only            |

---

## What every service already has

Each service imports `PlatformModule` from `platform/` and gets:

- **`GET /health`** returning the service's own identifier
- **Structured JSON logging** — one line per request, every line carrying a
  correlation ID read from `x-correlation-id` (the web app sends one with every
  request) and echoed back on the response. A service passes it on when it calls
  another (the auth client's identity check, Order's supplier lookup) and in every
  event, so one browser action can be followed across services
- **`GET /metrics`** for Prometheus: request latency by route, events handled,
  retried and dead-lettered, and the outbox backlog (PLT-04)
- **A shared error envelope**, so the web app handles failures uniformly
- **Boot-time environment validation** that fails loudly and names the variable
- **Graceful shutdown** on `SIGTERM`

Extend `platform/` rather than re-implementing any of this per service — a change
there lands once instead of four times.

See [docs/adr/0001-runtime-and-service-framework.md](docs/adr/0001-runtime-and-service-framework.md)
for why the stack is what it is, including two constraints worth knowing before
you add a dependency.

---

## Observability

`docker compose up` also starts Prometheus and Grafana (PLT-04). Open
<http://localhost:3005>: the **FoC Platform** dashboard is the home page, with
nothing to set up and no sign-in needed to view it.

| Panel                          | Shows                                                            | From                                                       |
| ------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------------- |
| HTTP p95 latency, by service   | time to answer, 95th percentile                                  | `http_request_duration_seconds`                            |
| Requests by status code        | request rate per HTTP status                                     | `http_request_duration_seconds_count`                      |
| Errands by status              | errands in each state right now                                  | `foc_orders` (Order Service)                               |
| Consumer backlog per queue     | messages waiting for a consumer                                  | RabbitMQ's exporter                                        |
| Event lag p95, by queue        | time from an event occurring to its consumer handling it         | `foc_event_lag_seconds`                                    |
| Retries per minute, by queue   | retries scheduled after a handler failed                         | `foc_event_retries_total`                                  |
| Dead-letter queue depth        | messages set aside for an operator                               | RabbitMQ's exporter                                        |
| Dead-lettered events by reason | `unparseable` (set aside at once) or `exhausted` (retries spent) | `foc_events_dead_lettered_total`                           |
| Outbox backlog                 | events committed but not yet confirmed by the broker             | `foc_outbox_backlog`, `..._oldest_unpublished_age_seconds` |

- **Follow one request.** Its correlation ID is in the `x-correlation-id`
  response header. `docker compose logs | grep <id>` then shows every service it
  reached and every event it caused.
- **Rates need traffic.** A rate panel shows a request once Prometheus has
  scraped before and after it (every 15 s), so give a demo a minute of traffic.
- **Add a metric.** Inject `METRICS` from `@foc/platform` and call `addGauge`;
  Order's `foc_orders` in `order-service/src/orders/order.metrics.ts` is the
  example. Every series carries a `service` label.
- **Change the dashboard** in `observability/grafana/dashboards/foc-platform.json`.
  Grafana reloads it within seconds; edits made in the UI are not saved.

---

## Troubleshooting

**`Invalid environment configuration. The service cannot start.`**
Working as intended — it names the missing variable. Copy `.env.example` to
`.env`, or use a `npm run dev:*` script, which supplies its own values.

**`EADDRINUSE` / port already taken**
Another service or an old process holds the port. Find it with
`lsof -i :3001`, then `kill <pid>`.

**`Unknown file extension ".ts"` or `ERR_REQUIRE_ESM`**
Something is loading the code as CommonJS. This workspace is ESM-only because
NestJS 12 ships no CommonJS build. Relative imports need an explicit `.js`
extension — `import { env } from './config.js'` — even though the file on disk
is `.ts`. That is correct, not a typo.

**`Cannot find module '@foc/platform'`**
Run `npm install` from the **root**, then `npm run build -w @foc/platform`.
Services import the compiled output.

**`Cannot connect to the Docker daemon`**
Start Docker Desktop and wait for the whale icon to settle.

**Wrong Node version**
`nvm use`. If `node --version` still shows v20 or lower, open a new terminal.

---

## Asynchronous workflows

Services exchange domain events through RabbitMQ rather than calling each other
and waiting. [`catalogue.ts`](platform/src/events/catalogue.ts) declares every
message, grouped by the six workflows in `EI-FR1.1.1`. The first — create a
wallet after a student's first activation — runs today, and the rest land with
their own tickets.

### What a service gets

```ts
import { EventsModule, EVENTS, EVENT_PUBLISHER, EVENT_CONSUMER } from '@foc/platform';

// Publishing
EventsModule.forRoot({ url: env.RABBITMQ_URL, producer: 'user-service' });

// Consuming — declare the queue up front so the topology is reproducible
EventsModule.forRoot({
  url: env.RABBITMQ_URL,
  producer: 'credit-service',
  subscriptions: [
    { queue: 'foc.credit.wallet-provisioning', routingKeys: [EVENTS.USER_ACTIVATED] },
  ],
});
```

`RABBITMQ_URL` is **optional**. A service without it boots and simply does not
publish or consume, so `npm run dev:user` works with no broker running. Compose
always supplies it.

A routing key is prefixed by the service that **publishes** it, not the one that
consumes it: the Order Service asks for a reservation with
`order.reservation-requested`, and the Credit Service answers with
`credit.reserved`. Add a message to the catalogue, with its payload schema,
before anything publishes it.

### The envelope

Every message carries the same envelope. Two fields matter most:

- **`correlationId`** — minted at the HTTP edge and copied onto every message
  the request causes, and every message those cause in turn. This is the thread
  an operator follows to reconstruct one order (`EI-NFR4.1.1`).
- **`causationId`** — the immediate parent. Where `correlationId` says _which
  request_, `causationId` says _which event directly produced this one_.

The rest — `eventId`, `eventType`, `schemaVersion`, `aggregateId`, `occurredAt`,
`producer` — is validated on send **and** on receive. A handler never sees a
payload that failed its schema.

### What happens when a handler fails

| Outcome                 | Behaviour                                                                  |
| ----------------------- | -------------------------------------------------------------------------- |
| Handled                 | Acknowledged                                                               |
| **Transient failure**   | Retried up to 5 times with growing delay — 1s, 5s, 15s, 60s                |
| **Attempts exhausted**  | Dead-lettered with the failure reason attached                             |
| **Unparseable message** | Dead-lettered immediately — retrying malformed input only burns the budget |

Retry uses delay queues rather than requeueing: a nack-and-requeue loop spins
hot and starves every other message. A failed message goes to a queue whose only
job is to hold it for a TTL and then route it back.

Two details that are easy to get wrong, and are commented in the code:

- A retry goes back to **the queue that failed**, not to the event's routing
  key: several services can bind one event type, and each must not handle
  another's retries. Each delay level is a **fanout** exchange whose queue
  dead-letters onto the default exchange; the failed message travels with its
  queue's name as routing key, which fanout ignores on the way in and the
  default exchange delivers by on the way out.
- Delay queues are **namespaced per service** (`foc.<service>.delay.N`). A
  queue's TTL is fixed at declaration, so globally named retry queues would
  force every service onto one backoff forever and require deleting queues to
  change it. (The first release named them `foc.<service>.retry.N` and routed
  retries by event type; a broker that still has those can delete them.)

A consumer survives the broker: if the connection or its channel goes, the
service reconnects with backoff, declares its topology again and re-registers
every subscription.

A subscription can also be **per instance** (`exclusive`, `autoDelete`,
`messageTtlMs`, `maxLength` on its `SubscriptionSpec`) when every replica must
see every message — the auth cache invalidation of USR-07. Such a queue goes
with its connection and has no retry or dead-letter queue: a failed message is
dropped, so its handler must be idempotent and have a fallback.

### Inspecting it

RabbitMQ's management UI is at <http://localhost:15672> (`foc` / `foc_dev`).

```bash
docker compose exec rabbitmq rabbitmqctl list_exchanges name type
docker compose exec rabbitmq rabbitmqctl list_queues name messages
```

A queue ending `.dlq` holds messages a consumer could not process. Each carries
an `x-foc-failure-reason` header, so you can see why without reading logs.

### Testing against a real broker

The unit tests need no broker and skip the integration suite. To run it:

```bash
docker compose up -d rabbitmq
RABBITMQ_URL=amqp://foc:foc_dev@localhost:55672 npm test -w @foc/platform
```

### Publishing with a database write: the outbox and inbox

An event that records a state change is never published straight from the
code that made the change: a crash between the commit and the publish would
lose it. It is written to the service's `outbox_events` table **in the same
transaction as the change**, and the platform's relay publishes it after the
commit ([EVT-02](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/135)).
The event exists exactly when the change does — a rollback discards both, and a
crash after the commit only delays the event until the relay next runs.

```ts
import {
  INBOX_TABLE_SQL,
  OUTBOX_TABLE_SQL,
  insertOutboxEvent,
  provideOutboxRelay,
  withInbox,
} from '@foc/platform';

// 1. Migrations: the shared tables. Both snippets are frozen, like any migration.
{ id: '002_outbox', sql: OUTBOX_TABLE_SQL },
{ id: '003_inbox', sql: INBOX_TABLE_SQL },

// 2. Producing: in the transaction that changes state. The payload is checked
//    against the catalogue here, so a bad shape fails the change, not a consumer.
await db.transaction(async (tx) => {
  await orders.save(tx, order); // PENDING_CREDIT
  await insertOutboxEvent(tx, {
    eventType: EVENTS.CREDIT_RESERVATION_REQUESTED,
    aggregateId: order.id,
    correlationId,
    payload: { orderId: order.id, requesterId, amount },
  });
});

// 3. Relaying: next to EventsModule, so it runs only when RABBITMQ_URL is set.
providers: env.RABBITMQ_URL ? [provideOutboxRelay({ db: DB })] : [],

// 4. Consuming: the effect, any reply, and the inbox record commit together.
handler: withInbox(db, RESERVATION_QUEUE, async (event, tx) => {
  await wallets.reserve(tx, event.payload);
  await insertOutboxEvent(tx, {
    eventType: EVENTS.CREDITS_RESERVED,
    aggregateId: event.payload.orderId,
    correlationId: event.correlationId,
    causationId: event.eventId,
    payload: event.payload,
  });
}),
```

| Property                                | How                                                                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Crash after commit still publishes      | The relay polls at boot, then every 500 ms, for rows with no `published_at`                                             |
| A redelivery is recognisably the same   | The row's id is the envelope's `eventId` on every attempt, with its `occurredAt` and `correlationId`                    |
| Duplicates have one effect              | The inbox (`processed_events`, keyed by consumer and event id) is written in the effect's own transaction               |
| One aggregate's events stay in order    | A row waits while an earlier row for the same aggregate is unpublished; other aggregates are not held up                |
| Several instances can relay at once     | Rows are claimed with `FOR UPDATE SKIP LOCKED`                                                                          |
| The broker is down or refuses a message | The row stays unpublished, with `attempts`, `last_error` and a backoff of 1 s doubling to 60 s; nothing is ever dropped |

Delivery is therefore **at least once**, and every consumer must go through the
inbox (or be naturally idempotent, like dropping a cache entry).

**Metrics** are structured log lines: `outbox relay stats` every minute
(`published`, `failed`, `backlog`, `oldestUnpublishedAgeMs`), `outbox publish
failed; will retry` per failed attempt, and `duplicate event skipped` per
duplicate an inbox absorbs. `OutboxRelay.stats` returns the same numbers. A
growing `oldestUnpublishedAgeMs` is the signal that events are stuck.

The relay's concurrency test needs real PostgreSQL, since PGlite runs one
transaction at a time:

```bash
docker compose up -d postgres
TEST_POSTGRES_URL=postgres://postgres:postgres_dev@localhost:55432/postgres npm test -w @foc/platform
```

Not done yet: published outbox rows and old inbox rows are never pruned.

## Continuous integration

Every pull request runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
It is **path-aware**: a change to one service does not rebuild and retest the
other three. Shared code — `platform/`, the root configs, the lockfile — fans out
to all four, because it can break any of them. So does any path the filter does
not recognise, such as a new package: it fails closed, running everything rather
than nothing.

| Job               | Runs when                                       | What it does                                                           |
| ----------------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `Detect changes`  | always                                          | Works out what is affected                                             |
| `Lint and format` | any Node code changed                           | `eslint`, `prettier --check`, and the contract compatibility check     |
| `Shared packages` | any Node code changed                           | Build and test every shared package, with real RabbitMQ and PostgreSQL |
| `<service>`       | that service or shared code changed             | Typecheck, test, and build its image                                   |
| `web-app`         | `web-app/**` changed                            | `bun install`, lint, build                                             |
| `Compose smoke`   | container wiring changed, or any push to `main` | Brings the whole stack up and runs the smoke checks                    |
| **`CI`**          | **always**                                      | The gate — fails if anything above failed                              |

### Why there is a separate `CI` job

A **skipped** job never reports a status. If the per-service jobs were marked
required, a documentation-only PR would skip them, the required checks would
never arrive, and the PR would be blocked forever. The `CI` job always runs and
fails if any job it depends on failed, so it is the only check that needs to be
required on `main`.

### Checking the path filter without pushing

The filter lives in [`scripts-ci-detect.sh`](scripts-ci-detect.sh) rather than
inline in the workflow, so it can be tested locally:

```bash
./scripts-ci-detect.sh --self-test              # CI runs this first, too
echo "supplier-service/src/app.module.ts" | ./scripts-ci-detect.sh
# services=["supplier-service"]
# web=false
# node=true
# stack=false
```

If you add a top-level folder, add it to that script and to its self-test — CI
will otherwise silently skip it.

### Running what CI runs, locally

```bash
npm ci                       # exactly what CI installs
npm run lint
npm run format:check
npm run typecheck
npm test
npm run test:contract        # contract compatibility + provider checks
./scripts-smoke.sh --up      # the Compose smoke job
```

Every test suite, its naming convention and the variables that switch on the real-PostgreSQL and
RabbitMQ suites are described in [docs/testing.md](docs/testing.md).

## Repository Structure

This repository follows a **one-service-per-folder** structure: each
microservice (`user-service/`, `supplier-service/`, `order-service/`,
`credit-service/`) lives in its own top-level folder.

```text
.
├── user-service/
├── supplier-service/
├── order-service/
├── credit-service/
├── <n2h-service>/
└── README.md
```

- Any **nice-to-have (N2H)** feature that warrants its own service should
  be added as an **additional folder** at the same level, following the
  same per-service structure.
- Files for agentic coding tools (e.g. agent configs, prompts, skills)
  may be added as needed, but must still **respect the
  one-service-per-folder skeleton** for core implementation.

---
