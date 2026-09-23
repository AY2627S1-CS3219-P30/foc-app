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
| `./scripts-smoke.sh`                  | Verify a running stack (16 checks)           |
| `./scripts-smoke.sh --up`             | Bring it up, verify, tear it down            |

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
at <http://localhost:15672> (`foc` / `foc_dev`).

**Not yet wired.** No service reads `DATABASE_URL` or `RABBITMQ_URL` yet — the
connections are provisioned and injected, ready for USR-01, SUP-01 and EVT-01 to
consume. Services currently talk to the browser directly with CORS; a thin
gateway is a later ticket.

### 7. Check your setup

```bash
npm run build       # compile every service
npm test            # 26 tests, no env vars needed
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

---

## What every service already has

Each service imports `PlatformModule` from `platform/` and gets:

- **`GET /health`** returning the service's own identifier
- **Structured JSON logging** — one line per request, every line carrying a
  correlation ID read from `x-correlation-id` and echoed back on the response,
  so one browser action can be followed across services
- **A shared error envelope**, so the web app handles failures uniformly
- **Boot-time environment validation** that fails loudly and names the variable
- **Graceful shutdown** on `SIGTERM`

Extend `platform/` rather than re-implementing any of this per service — a change
there lands once instead of four times.

See [docs/adr/0001-runtime-and-service-framework.md](docs/adr/0001-runtime-and-service-framework.md)
for why the stack is what it is, including two constraints worth knowing before
you add a dependency.

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

## Continuous integration

Every pull request runs [`.github/workflows/ci.yml`](.github/workflows/ci.yml).
It is **path-aware**: a change to one service does not rebuild and retest the
other three. Shared code — `platform/`, the root configs, the lockfile — fans out
to all four, because it can break any of them.

| Job               | Runs when                                       | What it does                                           |
| ----------------- | ----------------------------------------------- | ------------------------------------------------------ |
| `Detect changes`  | always                                          | Works out what is affected                             |
| `Lint and format` | any Node code changed                           | `eslint` and `prettier --check` across the repo        |
| `platform`        | any Node code changed                           | Typecheck and test the shared runtime                  |
| `<service>`       | that service or shared code changed             | Typecheck, test, and build its image                   |
| `web-app`         | `web-app/**` changed                            | `bun install`, lint, build                             |
| `Compose smoke`   | container wiring changed, or any push to `main` | Brings the whole stack up and runs the 16 smoke checks |
| **`CI`**          | **always**                                      | The gate — fails if anything above failed              |

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
./scripts-ci-detect.sh --self-test              # 24 cases
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
./scripts-smoke.sh --up      # the Compose smoke job
```

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
