# CS3219 — Software Design and Architecture (AY2627 Sem 1)

## Friend on Campus (FoC)

**Friend on Campus (FoC)** is a peer-to-peer campus errand platform where
students can request items to be collected from stores or facilities on
campus, and other students can fulfil (and deliver) those requests. The
platform runs on a closed credit economy — credits cannot be bought,
withdrawn, or exchanged for money, and only circulate within the platform.

---

## Team Members

| Name           | GitHub                | Owns                                                        | Nice-to-have                                                |
| -------------- | --------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| Anselm Long    | `@anselmlong`         | User Service: identity and access                           | N1.1 the User Service side; N1.2 chat access and retention  |
| Zhang Yuan     | `@volleyballkickedme` | Order Service: the errand lifecycle                         | N1.1 dispute referral and decision; N1.2 the chat lifecycle |
| Jonus Ho       | `@jonushzw`           | Integration and platform: events, containers, observability | N1.1 the admin console and operations; N4.1 CI/CD           |
| Isaac Chua     | `@isaacchua0309`      | Credit Service: the credit economy                          | N3.1 conservation evidence; N3.2 credit reconciliation      |
| Patrick Thomas | `@pastchum`           | Supplier Service and the web app                            | N1.2 the chat interface                                     |

What each nice-to-have is, and how the work on it is shared, is in
[docs/nice-to-haves.md](docs/nice-to-haves.md).

---

## How it fits together

- **A web app and four services.** The web app (Next.js) is what students and administrators use. It
  calls each service's public API directly, with the signed-in user's token: the
  [User](user-service), [Supplier](supplier-service), [Order](order-service) and
  [Credit](credit-service) Services, each a NestJS application in a container of its own
  ([Ports and ownership](#ports-and-ownership)).
- **Each service owns its data.** One PostgreSQL server holds four databases, one per service, and
  each service has a login to its own alone. No service reads another's tables
  ([ADR 0003](docs/adr/0003-service-boundaries-and-data-ownership.md)).
- **Who you are is checked everywhere.** The User Service signs short-lived access tokens; every
  service verifies them itself and asks the User Service, on an internal port, whether the account is
  still active ([ADR 0004](docs/adr/0004-authentication-and-trust.md)).
- **The credit workflow is asynchronous.** An errand's credits are reserved, transferred and returned
  through RabbitMQ: the Order Service asks, the Credit Service answers, and each change is saved
  with its message so neither is lost or applied twice
  ([Asynchronous workflows](#asynchronous-workflows),
  [ADR 0002](docs/adr/0002-asynchronous-order-credit-saga.md),
  [ADR 0009](docs/adr/0009-messaging-rabbitmq-events-and-ordering.md)).
- **It can be watched and run anywhere Docker runs.** Prometheus and Grafana show latency, queues
  and alerts ([Observability](#observability)); one `docker compose up` starts all of it
  ([Containers](#containers-secrets-networks-and-restarts)), and CI runs the whole stack on every push
  to `main` and on a pull request that touches it ([Continuous integration](#continuous-integration)).

Every design decision and its reasons are in the [decision records](docs/adr/README.md).

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
./scripts-init-env.sh
```

No password, key or token is in this repository. `.env.example` lists every
variable and marks each secret `<generated>`; the script writes `.env` with a
random value for each, made on your machine. `.env` is git-ignored and readable
by you alone. Run the script again after pulling: it adds whatever is new and
never changes a value you already have.

**If you already had a `.env`** (a copy of the old example), it holds the old
shared key and default passwords. The script names them and stops. Delete
`.env`, run the script again, and start the stack afresh once, because its
volumes hold the old passwords too:
`docker compose down -v && docker compose up -d --build`. That deletes local data.

The services read `.env` automatically. Real environment variables always win,
so Docker and CI are unaffected. A missing required variable stops a service at
boot and tells you which one — nothing falls back to a default.

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
need `USER_SERVICE_URL` and `INTERNAL_SERVICE_KEY`. Every service owns
persistence and requires its own `DATABASE_URL` too. Your `.env` has both ready
for the Compose stack's Postgres, under other names so that Compose ignores them:

```bash
docker compose -f compose.yaml -f compose.dev.yaml up -d   # the others, internal ports on 127.0.0.1
set -a; . ./.env; set +a
DATABASE_URL=$HOST_ORDER_DATABASE_URL INTERNAL_SERVICE_KEY=$ORDER_INTERNAL_KEY \
  USER_SERVICE_URL=http://localhost:4001 npm run dev:order
```

The override matters: a service checks its callers through the User Service's
`/internal/introspect`, which the stack serves on an internal port and not on 3001. [`compose.dev.yaml`](compose.dev.yaml) publishes those ports on
`127.0.0.1`; plain `docker compose up` does not publish them at all. A missing
value stops the service at boot and names it.

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
./scripts-init-env.sh    # if you have not already; Compose stops without a .env
docker compose up -d --build
docker compose ps        # every row should read healthy
```

Then open <http://localhost:3000>.

**This is how FoC is deployed for D4:** the whole stack in local containers, which the D3
instructions accept. There is no hosted deployment
([PLT-11 #286](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/286)).

| Command                               | What it does                                  |
| ------------------------------------- | --------------------------------------------- |
| `docker compose up -d --build`        | Build and start everything                    |
| `docker compose ps`                   | Show health of each container                 |
| `docker compose logs -f user-service` | Follow one service's logs                     |
| `docker compose restart`              | Restart everything, **keeping** data          |
| `docker compose down`                 | Stop and remove containers, **keeping** data  |
| `docker compose down -v`              | Stop and **delete the databases too**         |
| `./scripts-smoke.sh`                  | Verify the running stack                      |
| `./scripts-smoke.sh --up`             | Verify a separate copy, then delete it        |
| `./scripts-demo-failures.sh`          | Force messaging failures on the running stack |
| `./scripts-demo-credits.sh`           | Walk credits through an errand, with balances |
| `./scripts-restart-check.sh`          | Restart, recreate and take Postgres away      |
| `./scripts-demo-journey.sh`           | A student, an errand and its credits, by API  |

`docker compose down` keeps your data. Use `-v` only when you want a clean
database — it is also the only way to re-run `postgres-init.sh`, which runs
once when the data volume is empty. What each of these keeps is spelled out
under [Stopped, restarted, recreated](#stopped-restarted-recreated).

**Data isolation.** One PostgreSQL server hosts four databases with four roles,
one per service. Each role can connect only to its own database — a service
cannot read another service's tables even by accident. A single server rather
than four keeps a laptop usable during the demo; production can split the
instances with no application change, because each service already connects with
its own credentials. See [`postgres-init.sh`](postgres-init.sh).

**Ports.** PostgreSQL is published on **55432** and RabbitMQ on **55672**, not
their defaults, because a locally installed copy usually holds 5432 and 5672 and
`up` would fail to bind. Both listen on `127.0.0.1` only. Override any port in
`.env`. RabbitMQ's management UI is
at <http://localhost:15672>; sign in as `RABBITMQ_USER` with `RABBITMQ_PASSWORD`
from your `.env`. The operator dashboard is
Grafana at <http://localhost:3005>, open to view without signing in, with
Prometheus behind it at <http://localhost:9090>; see [Observability](#observability).

**Connections.** Compose gives each service its own `DATABASE_URL` and its own
`RABBITMQ_URL`: a database role and a broker account per service. Each applies
its own migrations through a one-shot container before starting. Services talk
to the browser directly with CORS, and to each other on a second port that is
not published; see [Containers](#containers-secrets-networks-and-restarts).

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

To see the system do its job rather than only start, run the journey the D3 demo
uses: a student registers and gets a wallet, an errand is created, accepted,
delivered and paid, one is cancelled, and six actions are refused. Each API call
is printed as it is made.

```bash
./scripts-demo-journey.sh
```

The demo itself, part by part with who presents what, is
[docs/demo/d3-runbook.md](docs/demo/d3-runbook.md).

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

- **`GET /health`** returning the service's own identifier and the state of what
  it depends on: `503` while its database is unreachable, `200` again as soon as
  it is back (PLT-06)
- **`/internal/**` on a port of its own** when `INTERNAL_PORT` is set, as Compose
  sets it: the public port then answers those routes with `404`
- **Structured JSON logging** — one line per request, every line carrying a
  correlation ID read from `x-correlation-id` (the web app sends one with every
  request) and echoed back on the response. A service passes it on when it calls
  another (the auth client's identity check, Order's supplier lookup) and in every
  event, so one browser action can be followed across services
- **`GET /metrics`** for Prometheus: request latency by route, events handled,
  retried and dead-lettered, and the outbox backlog (PLT-04). It wants
  `Authorization: Bearer $METRICS_TOKEN`, since it lists every route with its
  error rate; without a token it is open in development and refused in production
- **A shared error envelope**, so the web app handles failures uniformly. A
  request that fails because the database has gone away is a `503` with
  `Retry-After`, not a `500`
- **Boot-time environment validation** that fails loudly and names the variable
- **Graceful shutdown** on `SIGTERM`

Extend `platform/` rather than re-implementing any of this per service — a change
there lands once instead of four times.

See [docs/adr/0001-runtime-and-service-framework.md](docs/adr/0001-runtime-and-service-framework.md)
for why the stack is what it is, including two constraints worth knowing before
you add a dependency.

## Containers: secrets, networks and restarts

What PLT-06 set up, and what the D3 instructions ask us to explain (Part 4).
`./scripts-smoke.sh` and `./scripts-restart-check.sh` check every claim below
against a running stack, and CI runs both.

### One service, one of everything

Each service is developed, built and deployed on its own:

| Per service            | Where                                                                      |
| ---------------------- | -------------------------------------------------------------------------- |
| Source, tests, README  | its own folder, e.g. [`order-service/`](order-service)                     |
| Image                  | its own `Dockerfile`, multi-stage, running as the unprivileged `node` user |
| Schema                 | its own migrations, applied by its own one-shot `*-migrate` container      |
| Database and role      | `foc_order` and `order_service`, with a password no other service has      |
| Broker account         | `order-service`, which may publish only `order.*`                          |
| Key for calling others | `ORDER_INTERNAL_KEY`, which no other service presents                      |
| Ports                  | `3003` published; `4003` for other services only                           |

`docker compose up -d --build order-service` builds and starts that one service
and what it depends on. CI builds and tests only the services a change touches
([Continuous integration](#continuous-integration)). What the services share is
[`platform/`](platform) and the contracts in [`contracts/`](contracts), which CI
checks for breaking changes.

The chat nice-to-have (N1.2) would arrive the same way, as one more row of this
table: a `chat-service` folder with its own Dockerfile and migrate container, a
`foc_chat` database and role in `postgres-init.sh`, a broker account in
`rabbitmq-init.sh`, a key of its own, and membership of the `db`, `broker` and
`services` networks. Nothing about the other four changes.

### Secrets

No password, key or token is committed (PL-NFR2.1.1). `compose.yaml` reads each
from `.env` and has no fallback: without one, Compose stops and names it.

| Secret                   | Who holds it                                                  |
| ------------------------ | ------------------------------------------------------------- |
| `*_DB_PASSWORD`          | one per service, for its own database role                    |
| `*_BROKER_PASSWORD`      | one per service, for its own broker account                   |
| `*_INTERNAL_KEY`         | one per calling service; the callee lists the keys it accepts |
| `JWT_PRIVATE_KEY`        | the User Service: signs access tokens                         |
| `ADMIN_SEED_PASSWORD`    | the User Service: the bootstrap admin's first password        |
| `METRICS_TOKEN`          | the services and Prometheus                                   |
| `POSTGRES_PASSWORD`      | the Postgres superuser, used only to create the roles         |
| `RABBITMQ_PASSWORD`      | the broker operator: the management UI and the scripts        |
| `GRAFANA_ADMIN_PASSWORD` | Grafana's admin; viewing needs no sign-in                     |

`JWT_PRIVATE_KEY` is required in production and by Compose. A User Service run
by hand outside production without one makes a throwaway key at boot, which
signs everyone out at each restart.

To change a secret, edit `.env` and run `docker compose up -d`. A broker
password takes effect then (the accounts are set at every start). A database
role keeps the password its volume was created with: `ALTER ROLE`, or
`docker compose down -v` for a fresh one.

Two things keep it this way. A test in the Node job
([`compose-config.test.ts`](test-harness/test/compose-config.test.ts)) fails if
a credential, or a fallback for one, is written into a deployment file. And
`./scripts-scan-secrets.sh`, which CI runs, scans the repository and every
image the stack builds.

### Networks and ports

A container joins only the networks of what it depends on (PL-NFR2.1.2):

| Network         | On it                                               | For                                    |
| --------------- | --------------------------------------------------- | -------------------------------------- |
| `db`            | Postgres, the four services, the migrate containers | each service's own database            |
| `broker`        | RabbitMQ, the four services, Prometheus             | events; queue depths for the dashboard |
| `services`      | the four services, Prometheus                       | service-to-service calls; scraping     |
| `public`        | the four services                                   | publishing ports 3001-3004             |
| `web`           | the web app                                         | publishing port 3000                   |
| `local`         | Postgres, RabbitMQ                                  | publishing their ports on `127.0.0.1`  |
| `observability` | Prometheus, Grafana                                 | the dashboard's queries; their ports   |

The first three are `internal`: containers talk on them, they have no route
out, and no port can be published through them. Publishing a port needs an
ordinary network, and each container has exactly one, because with two Docker
can publish the port on one and send the replies out of the other. So the web
app's container cannot open a connection to Postgres, and Grafana cannot reach
a service.

| From this machine                                             | Reachable on     |
| ------------------------------------------------------------- | ---------------- |
| The web app (3000) and each service's public port (3001-3004) | every interface  |
| Postgres, RabbitMQ and its management UI, Grafana, Prometheus | `127.0.0.1` only |
| Each service's internal port (4001-4004)                      | not published    |

**External and internal communication.** A browser reaches a service on its
public port. `/internal/**` (token introspection, Credit's reconciliation
read) is for other services: each service listens on a second port that is not
published, so only a container that shares a network with it can connect, and
on the public port an internal route answers `404`, exactly as a route that
does not exist. It still wants the caller's service key.

**One broker account per service.** RabbitMQ refuses, with a 403, a service
that publishes another service's event (`user.activated` from the Order
Service), writes to another service's queue, or reads one. Until PLT-06 every
service shared one login and Credit believed the producer name written inside
a message.

That rule alone can be walked around: RabbitMQ checks routing keys only on the
exchange a client publishes to, and a service may bind an exchange of its own
into the shared one. So there is a second rule, which no route gets past. The
broker stamps every message with the account that published it and refuses a
false stamp, and a consumer sets aside any message whose stamp is not the
producer it names (`untrusted_sender`). `./scripts-demo-failures.sh` has the
Order Service try both. [`rabbitmq-init.sh`](rabbitmq-init.sh) has the
permissions, [`sender.ts`](platform/src/events/sender.ts) the check, and
[ADR 0004](docs/adr/0004-authentication-and-trust.md) the reasoning.

**Privileges.** Every container's main process is unprivileged. The services,
their migrate containers and the web app also drop every Linux capability and
cannot gain one (`no-new-privileges`). The four pre-built images (Postgres,
RabbitMQ, Prometheus, Grafana) keep their publishers' defaults: they are not
given `cap_drop` or `no-new-privileges`, because their entrypoints were not
tested under them here. RabbitMQ is started as its own user; Postgres starts as
root and drops to `postgres` before it serves.

### Stopped, restarted, recreated

| Command                          | Containers | Volumes | Users, errands, wallets, ledger, inbox, outbox | Messages waiting in a queue |
| -------------------------------- | ---------- | ------- | ---------------------------------------------- | --------------------------- |
| `docker compose stop` / `start`  | kept       | kept    | kept                                           | kept, handled once          |
| `docker compose restart`         | kept       | kept    | kept                                           | kept, handled once          |
| `docker compose down`, then `up` | recreated  | kept    | kept                                           | kept, handled once          |
| `docker compose down -v`         | removed    | removed | **deleted**                                    | **deleted**                 |

State lives in three named volumes (Postgres, RabbitMQ, Prometheus) and nowhere
else, so a container can be thrown away. Queues are durable and messages
persistent; RabbitMQ's host name is fixed so that a recreated container finds
them. "Handled once" is the inbox: a message redelivered after a restart is
recognised by its event id and has no second effect (PL-NFR3.1.1). Sign-ins
survive too, because the signing key is in `.env` rather than made at boot.

```bash
./scripts-restart-check.sh --up
```

does the first three rows to a stack of its own with a request to Credit
waiting in its queue, and checks after each that no table lost a row and the
request was honoured exactly once. Without `--up` it does them to the stack
you have running, and leaves two students and three errands of its own there.

### When a dependency goes away

| Missing                | `GET /health`                      | A request                                         | When it returns             |
| ---------------------- | ---------------------------------- | ------------------------------------------------- | --------------------------- |
| The service's database | `503`, `status: unavailable`       | `503` with `Retry-After`: never accepted and lost | healthy again, no restart   |
| RabbitMQ               | `200`, `dependencies.broker: down` | accepted; its events wait in the outbox           | the outbox drains by itself |
| A consuming service    | unaffected                         | accepted; requests wait in that service's queue   | it works through its queue  |

A service cannot record anything without its database, so it says so
(PL-NFR3.1.2). An event that arrives meanwhile is retried for about 81 seconds;
if the database is away longer than that, the event waits as a dead letter and
an operator redrives it afterwards ([Dead letters](#dead-letters-and-alerts-plt-05)). It can work without the broker for a while, which is the point of
the outbox, so that is reported but does not fail the check; `OutboxEventStuck`
fires if it lasts two minutes.

Started in the wrong order, the same rules apply. Compose starts a service only
once Postgres and RabbitMQ are healthy and its migrations have run. A service
that loses the broker reconnects on its own. An event published before its
consumer has ever started stays in the outbox until the consumer's queue exists.

### Pre-built images

Six images are pulled as published; everything else is built from this
repository. Each is pinned to an exact version and digest, in `compose.yaml` and
the Dockerfiles, so two builds of one commit use the same bytes.

| Image                              | Used for                           | Published by                                              | Licence of the software |
| ---------------------------------- | ---------------------------------- | --------------------------------------------------------- | ----------------------- |
| `node:22.23.3-alpine3.24`          | base of the four services, web app | Docker Official Image, by the Node.js Docker team         | MIT                     |
| `oven/bun:1.4.2-alpine`            | building the web app               | Oven, the makers of Bun                                   | MIT                     |
| `postgres:17.11-alpine3.24`        | the database server                | Docker Official Image, by the PostgreSQL Docker community | PostgreSQL Licence      |
| `rabbitmq:4.3.6-management-alpine` | the message broker                 | Docker Official Image, by the Docker community            | MPL 2.0                 |
| `prom/prometheus:v3.13.4`          | metrics and alert rules            | The Prometheus project                                    | Apache 2.0              |
| `grafana/grafana-oss:12.4.3`       | the dashboard                      | Grafana Labs                                              | AGPL 3.0                |

Two more are run as tools, not as part of the stack: `ghcr.io/gitleaks/gitleaks:v8.30.0`
(the Gitleaks project, MIT), by `./scripts-scan-secrets.sh`, and `aquasec/trivy:0.58.1` (Aqua
Security, Apache 2.0), by `./scripts-scan-vulnerabilities.sh`.

The Alpine Linux base of the first four carries its own packages under their
own licences. To update an image, change its version and its digest together;
a test fails if either is missing.

---

## Observability

`docker compose up` also starts Prometheus and Grafana (PLT-04). Open
<http://localhost:3005>: the **FoC Platform** dashboard is the home page, with
nothing to set up and no sign-in needed to view it. Both are published on
`127.0.0.1` only, so anonymous viewing stays on your machine. Prometheus sends
`METRICS_TOKEN` to each service (Compose mounts it as a file); to read one
yourself, `curl -H "Authorization: Bearer $METRICS_TOKEN" localhost:3001/metrics`.

| Panel                             | Shows                                                                                                                                              | From                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| HTTP p95 latency, by service      | time to answer, 95th percentile                                                                                                                    | `http_request_duration_seconds`                                                     |
| Requests by status code           | request rate per HTTP status                                                                                                                       | `http_request_duration_seconds_count`                                               |
| Errands by status                 | errands in each state right now                                                                                                                    | `foc_orders` (Order Service)                                                        |
| Consumer backlog per queue        | messages waiting for a consumer                                                                                                                    | RabbitMQ's exporter                                                                 |
| Event lag p95, by queue           | time from an event occurring to its consumer handling it                                                                                           | `foc_event_lag_seconds`                                                             |
| Retries per minute, by queue      | retries scheduled after a handler failed                                                                                                           | `foc_event_retries_total`                                                           |
| Dead letters waiting, by queue    | parked for an operator (PLT-05); "not yet parked" only while the owning service is down                                                            | `foc_dead_letters_waiting`, RabbitMQ's exporter                                     |
| Dead-lettered events by reason    | `unparseable`, `unsupported_version` or `untrusted_sender` (set aside at once), or `exhausted` (retries spent); a per-instance queue drops instead | `foc_events_dead_lettered_total`, `foc_events_dropped_total`                        |
| Outbox backlog                    | events committed but not yet confirmed by the broker                                                                                               | `foc_outbox_backlog`, `..._oldest_unpublished_age_seconds`                          |
| Oldest errand waiting for Credit  | how long the oldest `PENDING_CREDIT` errand has waited for its reservation                                                                         | `foc_orders_pending_credit_oldest_age_seconds`                                      |
| Firing alerts                     | the rules in `observability/alerts.yml` that are firing now                                                                                        | Prometheus `ALERTS`                                                                 |
| Repeated, stale and waiting steps | deliveries already applied, steps older than a change already applied, and steps retried while an earlier one is missing                           | `foc_events_duplicate_total`, `foc_events_stale_total`, `foc_events_deferred_total` |

- **Follow one request.** Its correlation ID is in the `x-correlation-id`
  response header. `docker compose logs | grep <id>` then shows every service it
  reached and every event it caused. The web app gives every call one user
  action makes the same ID (signing in is the login and the account read), and a
  credit reconciliation run is `reconcile-<runId>`. Two limits: identity checks
  that arrive together share one call to the User Service, logged there under the
  first caller's ID, and a cached check makes no call at all.
- **Per-instance queues** (each service's `auth-status` cache queue) carry a
  random suffix; their metrics are labelled without it, so a restart continues
  the same series.
- **Rates need traffic.** A rate panel shows a request once Prometheus has
  scraped before and after it (every 15 s), so give a demo a minute of traffic.
- **Add a metric.** Inject `METRICS` from `@foc/platform` and call `addGauge`;
  Order's `foc_orders` in `order-service/src/orders/order.metrics.ts` is the
  example. Every series carries a `service` label.
- **Change the dashboard** in `observability/grafana/dashboards/foc-platform.json`.
  Grafana reloads it within seconds; edits made in the UI are not saved.

### Dead letters and alerts (PLT-05)

An event that fails every retry is **dead-lettered**. The service that consumes
it (Order or Credit) drains its own `.dlq` queues into a `dead_letters` table in
its own database, so a dead letter is kept, searchable and never lost to a queue
purge. The admin console's **Operations** tab (`/admin/operations`) is where an
operator works with them:

- **Find** a dead letter by correlation ID, errand ID, user ID or event ID, in
  either service, waiting or already redriven.
- **Inspect** it: the queue it failed on, why (the `x-foc-failure-reason` the
  consumer recorded), how many attempts, and the message exactly as it arrived.
- **Redrive** it, with a reason. The service publishes the stored bytes, unedited,
  to the queue it failed on and nowhere else, waits for the broker to confirm,
  then records who redrove it, when and why. A dead letter is redriven once; if
  it fails again it comes back as a new one. The consumer's inbox makes a repeat
  harmless: a redriven `user.activated` issues exactly one wallet however often
  it arrives (`credit-service/test/operations.test.ts`).
- **Trace an errand** from its ID: every state change, every event sent or still
  waiting, reconciliation, alerts and dead letters from both services, in order.

A `dead_letters` row cannot be deleted, and changes once, to record its redrive
(a database trigger refuses anything else). The Credit Service's one HTTP write
is this redrive; it moves no credit itself, so a balance still changes only
through the four event subscriptions in `credit-service/src/closed-economy.ts`.

Prometheus evaluates `observability/alerts.yml`. A firing alert shows on the
dashboard's **Firing alerts** panel and at <http://localhost:9090/alerts>; no
Alertmanager runs locally, so nothing is sent anywhere.

| Alert                    | Fires when                                                     |
| ------------------------ | -------------------------------------------------------------- |
| `DeadLetterWaiting`      | any dead letter is waiting, at once                            |
| `DeadLetterNotParked`    | a `.dlq` queue has held a message for 2 minutes (service down) |
| `ErrandWaitingForCredit` | an errand has waited more than 5 minutes for its reservation   |
| `OutboxEventStuck`       | a saved event has not been published for 2 minutes             |
| `ServiceDown`            | a service has not answered a scrape for a minute               |

The rules have unit tests, which CI runs before the Compose smoke test:

```bash
docker run --rm -v "$PWD/observability:/rules:ro" --entrypoint promtool prom/prometheus:v3.13.4 test rules /rules/alerts.test.yml
```

**When `DeadLetterWaiting` fires:**

1. Open the Operations tab and find the dead letter; its queue says which
   consumer failed and its reason says why.
2. Trace the errand (or open the account, for a `user.activated`) to see what
   happened around it.
3. Fix the cause: a service or database that was down, a bad deployment, a row
   in the wrong state. Redriving before then only fails it again.
4. Redrive it with a reason, then watch the trace: the consumer handles it, or
   it fails again and comes back as a new dead letter with the new reason.

---

## Troubleshooting

**`Invalid environment configuration. The service cannot start.`**
Working as intended — it names the missing variable. Create `.env` with
`./scripts-init-env.sh`, or use a `npm run dev:*` script, which supplies its own
values.

**`required variable ... is missing a value: run ./scripts-init-env.sh`**
Compose has no fallback for a secret. Run the script; it creates `.env`, or adds
what a newer `.env.example` introduced.

**`password authentication failed`, or `PRECONDITION_FAILED` on a `foc.*.delay.*` queue**
Your volumes are older than your `.env`: Postgres keeps the role passwords it
was first started with, and RabbitMQ the queues it first declared. After pulling
PLT-06, or after deleting `.env`, start both afresh once:
`docker compose down -v && docker compose up -d --build`. This deletes local data.

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
message, grouped by the six workflows in `EI-FR1.1.1`.
[ADR 0009](docs/adr/0009-messaging-rabbitmq-events-and-ordering.md) records why
RabbitMQ, which messages are facts and which are requests, how a repeat is
recognised, and why nothing depends on the order messages arrive in.

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
`producer` — is validated on send **and** on receive. The publisher refuses an
event type the catalogue does not describe, or a payload that fails its schema,
before anything reaches the broker, and a handler never sees a payload that
failed its schema or a major `schemaVersion` it was not written for.

### What happens when a handler fails

| Outcome                                 | Behaviour                                                                                            |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Handled                                 | Acknowledged                                                                                         |
| **Transient failure**                   | Retried up to 5 times with growing delay — 1s, 5s, 15s, 60s                                          |
| **Attempts exhausted**                  | Dead-lettered with the failure reason attached, then parked for an operator                          |
| **Unparseable message**                 | Dead-lettered immediately — retrying malformed input only burns the budget                           |
| **Unsupported major version**           | Dead-lettered whole, before its payload is read, stating that the form is unsupported                |
| **Already applied**                     | Acknowledged with no further effect; a redelivery of the same event id is counted                    |
| **Older than a change already applied** | Acknowledged, ignored and counted; never applied, retried or dead-lettered                           |
| **Waiting on an earlier step**          | Counted and retried like a transient failure; set aside for review if the earlier step never arrives |

Retry uses delay queues rather than requeueing: a nack-and-requeue loop spins
hot and starves every other message. A failed message goes to a queue whose only
job is to hold it for a TTL and then route it back.

Two details that are easy to get wrong, and are commented in the code:

- A retry goes back to **the queue that failed**, not to the event's routing
  key: several services can bind one event type, and each must not handle
  another's retries. Each delay level is a **fanout** exchange whose queue
  dead-letters onto the service's own **requeue** exchange
  (`foc.<service>.requeue`, direct); the failed message travels with its
  queue's name as routing key, which fanout ignores on the way in and the
  requeue exchange delivers by on the way out. A redrive uses the same
  exchange. Not the default exchange: writing to that is writing to any queue
  on the broker, so no service's account may.
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

### Seeing it fail on purpose

`./scripts-demo-failures.sh` forces five failures on the running stack and checks
what the system did about each (EVT-03, PLT-06). It signs up its own students each run,
so it can be repeated.

| Step                                                           | What it shows                                                                                                           |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| The Credit Service is killed, then an errand is created        | The errand waits as `PENDING_CREDIT`, then opens with 3 credits reserved once                                           |
| An activation published again, twice, with the same event id   | One wallet, one issue of 10 credits; `foc_events_duplicate_total` rises by 2                                            |
| `credit.reserved` delivered again after a courier has accepted | Ignored and counted (`foc_events_stale_total`); no dead letter                                                          |
| An activation in schema version 2                              | Set aside whole as a dead letter, reason "unsupported schema version 2"; no wallet                                      |
| The Order Service forges an activation as the User Service's   | Refused by the broker outright; routed in through its own exchange, set aside by Credit with the real sender; no wallet |
| The closing check                                              | Wallets hold exactly the credits that were issued                                                                       |

The version 2 and forged activations each leave a dead letter waiting, so the
`DeadLetterWaiting` alert fires and the Operations tab has something to show.

### Inspecting it

RabbitMQ's management UI is at <http://localhost:15672>. Sign in as the operator:
`RABBITMQ_USER` and `RABBITMQ_PASSWORD` from your `.env`.

```bash
docker compose exec rabbitmq rabbitmqctl list_exchanges name type
docker compose exec rabbitmq rabbitmqctl list_queues name messages
```

A queue ending `.dlq` receives messages a consumer could not process. Each
carries an `x-foc-failure-reason` header, so you can see why without reading
logs. Its service drains it at once into its `dead_letters` table, so the queue
reads empty while the service runs; find, inspect and redrive them in the admin
console's Operations tab ([Dead letters and alerts](#dead-letters-and-alerts-plt-05)).

### Testing against a real broker

The unit tests need no broker and skip the integration suite. To run it:

```bash
docker compose up -d rabbitmq
set -a; . ./.env; set +a   # the stack's addresses and logins, from your .env
RABBITMQ_URL=$HOST_RABBITMQ_URL npm test -w @foc/platform
```

### Publishing with a database write: the outbox and inbox

An event that records a state change is never published straight from the
code that made the change: a crash between the commit and the publish would
lose it. It is written to the service's `outbox_events` table **in the same
transaction as the change**, and the platform's relay publishes it after the
commit ([EVT-02](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/135)).
The event exists exactly when the change does — a rollback discards both, and a
crash after the commit only delays the event until the relay next runs.

An event that must reach a consumer (`REQUIRES_CONSUMER` in the catalogue: a
wallet, and every reservation, transfer and release step) is published as
mandatory. If no queue is bound for it yet, which happens on a clean broker when
a producer starts before its consumer ever has, the broker hands it back and the
publish fails as `unroutable`. The row stays in the outbox and is retried until
the queue exists, instead of being confirmed and then discarded. The relay goes
on to the rows behind it, later events for the same user or errand wait, and
`OutboxEventStuck` fires if it is still there after two minutes.

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
set -a; . ./.env; set +a   # the stack's addresses and logins, from your .env
TEST_POSTGRES_URL=$HOST_POSTGRES_URL npm test -w @foc/platform
```

**Pruning** (PLT-12, [#287](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/287)). Neither
table grows for ever. Each service with event tables registers an `EventTablePruner`
([`pruner.ts`](platform/src/events/pruner.ts)), with or without a broker. On a timer of its own,
right after start and then hourly, it deletes, in batches of 1,000, published outbox rows more than
30 days old and inbox rows more than 30 days old (`pruneEventTables` in
[`retention.ts`](platform/src/events/retention.ts)). It never deletes an unpublished row, however
old, nor an inbox row whose event still waits as a dead letter, which an operator may redrive at
any time. Thirty days is far longer than any copy of an event can take to arrive; it is also how far
back the admin console's errand trace sees an errand's events. It runs apart from the relay, so even
a first prune of a long backlog never holds up a publish, and a service shutting down stops it after
the batch in hand. It finds its rows through two indexes each service's migrations create
(`outbox_events_published_idx`, `processed_events_processed_idx`). A failed prune is logged with
its error (`pruning the event tables failed; will retry`) and tried again an hour later;
`foc_event_rows_pruned_total{table}` counts what went, batch by batch. Pass `retention` or
`intervalMs` to `provideEventTablePruner` to change either.

## What is kept about a person, and for how long

FoC stores what its features need and keeps it for the life of the deployment: there is no account
deletion (an administrator suspends an account instead), and history that settles credits or
disputes is append-only by design ([ADR 0007](docs/adr/0007-credit-invariant-and-double-entry-ledger.md),
[ADR 0008](docs/adr/0008-controlling-administrators.md)).

| Where                         | About a person                                                                                                       | Kept                                                                        | Who can read it                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| User Service (`foc_user`)     | NUS email, password hash (Argon2id), display name, faculty, avatar, contact preference, mode, roles, status          | for the life of the account                                                 | the person; administrators, each opening of an account recorded                                                               |
|                               | Sign-in sessions (a hash of the refresh token), activation tokens (hashed)                                           | until they expire; expired rows are not yet removed                         | nobody through the API                                                                                                        |
|                               | The audit trail: who suspended, reactivated or changed whose role, and why                                           | for ever (append-only)                                                      | administrators                                                                                                                |
| Order Service (`foc_order`)   | Errands: requester and courier ids, items and notes, delivery zone and instructions, status history, dispute reasons | for ever                                                                    | the requester and courier; an administrator only once a dispute is referred to them (ADR 0008); others see public fields only |
| Credit Service (`foc_credit`) | Wallet balances and the ledger, by user id                                                                           | for ever (append-only)                                                      | the person; administrators, every read recorded                                                                               |
| Events (each service)         | Ids (user, errand) in event payloads; no email or name                                                               | outbox 30 days once published, inbox 30 days (above); dead letters for ever | operators, in the Operations tab                                                                                              |
| Logs                          | User and correlation ids; never an email, password or token (redacted)                                               | as long as Docker keeps the container's log                                 | whoever runs the stack                                                                                                        |
| Supplier Service, metrics     | Nothing about a person                                                                                               | —                                                                           | —                                                                                                                             |

Personal data never leaves the stack: no service calls a third party, and no secret or personal
value is written to an image ([Secrets](#secrets)).

## Continuous integration

Every pull request runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
It is **path-aware**: a change to one service does not rebuild and retest the
other three. Shared code — `platform/`, the root configs, the lockfile — fans out
to all four, because it can break any of them. So does any path the filter does
not recognise, such as a new package: it fails closed, running everything rather
than nothing.

| Job               | Runs when                                                  | What it does                                                                                                            |
| ----------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Detect changes`  | always                                                     | Works out what is affected                                                                                              |
| `Lint and format` | any Node code changed                                      | `eslint`, `prettier --check`, the contract compatibility check, and a vulnerability scan of the production dependencies |
| `Shared packages` | any Node code changed                                      | Build and test every shared package, with real RabbitMQ and PostgreSQL, and report their coverage                       |
| `<service>`       | that service or shared code changed                        | Typecheck, test and report coverage, build its image, and scan the image for vulnerabilities                            |
| `web-app`         | `web-app/**`, a contract, or what builds its image changed | `bun install`, lint, test with coverage; then build its image, which builds the app, and scan it                        |
| `Compose smoke`   | container wiring changed, or any push to `main`            | Brings the whole stack up and runs the smoke checks                                                                     |
| **`CI`**          | **always**                                                 | The gate — fails if anything above failed                                                                               |

### Why there is a separate `CI` job

A **skipped** job never reports a status. If the per-service jobs were marked
required, a documentation-only PR would skip them, the required checks would
never arrive, and the PR would be blocked forever. The `CI` job always runs and
fails if any job it depends on failed, so it is the only check that needs to be
required on `main`.

### Vulnerabilities, coverage, owners and what `main` requires

- **A critical vulnerability with a fix fails the pull request** (NTH-04,
  [#164](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/164); PL-NFR4.1.2), as a failed
  test does. [`scripts-scan-vulnerabilities.sh`](scripts-scan-vulnerabilities.sh) runs Trivy,
  pinned like every other image, over `package-lock.json`'s production dependencies and over each
  image a change builds. It lists every HIGH and CRITICAL finding that has a fixed version and fails
  on a CRITICAL one; HIGH ones are listed, not gated, and one with no fix yet is left out. The web
  app's dependencies are scanned in its image, as this Trivy does not read `bun.lock`. Each target
  is analysed once, and one Trivy cannot scan (a refused database download, a missing image) fails
  while the rest are still scanned. CI restores the day's Trivy database from its cache
  ([`.github/actions/trivy-db`](.github/actions/trivy-db/action.yml)), so a run seldom downloads it.
  To run it: `./scripts-scan-vulnerabilities.sh --lockfile`, or `--image <name>` for an image you
  have built.
- **Code owners.** [`.github/CODEOWNERS`](.github/CODEOWNERS) asks each service's owner, and the
  owner of the web app, the console, the contracts and the pipeline, to review a change to theirs.
  A catch-all line gives everything else, root files included, an owner too.
- **What `main` requires.** Branch protection requires the `CI` check, on a branch up to date with
  `main`, and refuses force pushes. It does not require an approval: a review by one person other
  than the author is the team's rule (each ticket's Definition of Done), and `CODEOWNERS` requests it.
- **Coverage is reported, not gated** (PL-NFR4.1.1). Each service's and shared package's tests run
  with `--coverage` in CI, and [`scripts-coverage-summary.sh`](scripts-coverage-summary.sh) puts
  their lines, branches and functions in the job's summary; the web app's table is in its log. No
  package has a threshold. To see a service's locally:
  `npm test -w @foc/order-service -- --coverage`.
- **Pinned tools.** Bun in CI is the version the web app's image builds with (1.4.2), and a test
  fails if the two differ.

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
./scripts-init-env.sh        # once: the stack scripts read .env
./scripts-scan-secrets.sh    # no secret in the repository or the images
./scripts-smoke.sh --up      # the Compose smoke job
./scripts-demo-failures.sh --up   # the failure demo it runs afterwards
./scripts-restart-check.sh --up   # restart, recreate, lose Postgres
./scripts-demo-journey.sh --up --redrive   # the D3 journey, and a dead letter redriven
```

Every test suite, its naming convention and the variables that switch on the real-PostgreSQL and
RabbitMQ suites are described in [docs/testing.md](docs/testing.md).

### Published images

A push to `main` that passes every check publishes the five application images to the GitHub
Container Registry (NTH-04, [#164](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/164)):
`ghcr.io/ay2627s1-cs3219-p30/foc-user-service`, `-supplier-service`, `-order-service`,
`-credit-service` and `-web-app`. Each is tagged `sha-<commit>` with the full commit hash, and the
newest is also `main`. Pull requests build the images but never push them.

[`compose.images.yaml`](compose.images.yaml) names them for Compose. With it, a stack starts from
the published images instead of building:

```bash
FOC_IMAGE_TAG=sha-<commit> docker compose -f compose.yaml -f compose.images.yaml pull
FOC_IMAGE_TAG=sha-<commit> docker compose -f compose.yaml -f compose.images.yaml up -d --no-build
```

`FOC_IMAGE_TAG` defaults to `main`. Starting an earlier commit's tag rolls the stack back (PLT-09,
[#284](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/284)). CI builds with the same file
through `docker buildx bake`, so a published image has exactly `compose.yaml`'s build arguments.

- **The web app's image is for this local stack only.** `next build` inlines its build arguments,
  so it calls the services at `localhost` on `compose.yaml`'s default ports (3001 to 3004) and links
  sign-up to the dev mailbox; its image label says so. A stack on other ports keeps the published
  services and builds the web app from its own `.env` first:
  `docker compose -f compose.yaml -f compose.images.yaml build web-app`, then `up -d --no-build`.
  A web app image that can be deployed elsewhere waits for the edge proxy (PLT-10,
  [#285](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/285)), which puts it and the APIs
  on one origin.
- **Every merged commit is published, unless its scan fails.** Each run on `main` has a concurrency
  group of its own, so none is dropped or cancelled while another runs; only a pull request's
  superseded run is cancelled. As runs can then finish out of order, a run moves `main` only while
  its commit is still the newest on `main`.
- **What is pushed is what was scanned.** The publish job builds all five images, scans every one,
  changed in that push or not, and only then pushes them. A critical vulnerability with a fix,
  disclosed since an image was last scanned, stops the publish: nothing is pushed.
- **Only the publish job may write to the registry.** It alone has `packages: write`, and it runs
  only after the `CI` job passed on a push to `main`.
- **Fast after the first.** It reads and writes the per-service layer cache that the image builds
  use, from `main`, which every later run, pull requests included, can read.
- **If `pull` says `denied`,** the package is still private: an organisation owner makes it public
  under the package's settings, or you sign in first with
  `docker login ghcr.io -u <github-user>` and a token that has `read:packages`.

## Repository Structure

This repository follows a **one-service-per-folder** structure: each
microservice (`user-service/`, `supplier-service/`, `order-service/`,
`credit-service/`) lives in its own top-level folder.

```text
.
├── user-service/        identity, sign-in, roles, the audit trail
├── supplier-service/    the campus supplier catalogue
├── order-service/       errands: their lifecycle, disputes, reconciliation
├── credit-service/      wallets and the double-entry ledger
├── web-app/             the Next.js front end, students' and administrators'
├── platform/            what every service shares: config, logging, health, events
├── auth-client/         how a service verifies a caller with the User Service
├── contracts/           the OpenAPI and event contracts, checked for breaking changes
├── test-harness/        shared test fixtures, contract and deployment-file checks
├── system-tests/        Order and Credit run together: races, faults, conservation
├── observability/       Prometheus rules and the Grafana dashboard
├── data/                the supplier seed data
├── docs/                decision records, runbooks, reports, the plan
├── compose*.yaml        the stack, and its overrides
└── scripts-*.sh         start, smoke-test, demo and check the stack
```

- Any **nice-to-have (N2H)** feature that warrants its own service should
  be added as an **additional folder** at the same level, following the
  same per-service structure (the chat service, N1.2, would be one).
- Files for agentic coding tools (e.g. agent configs, prompts, skills)
  may be added as needed, but must still **respect the
  one-service-per-folder skeleton** for core implementation.

---
