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

### 6. Run a service in Docker

The build context is the repository root, not the service folder, because the
image needs the workspace manifests and `@foc/platform`:

```bash
docker build -f user-service/Dockerfile -t foc/user-service .
docker run --rm -p 3001:3001 \
  -e SERVICE_NAME=user-service -e PORT=3001 \
  foc/user-service
```

Images run as a non-root user and declare a `HEALTHCHECK`. A one-command
`docker compose up` for the whole stack arrives with
[PLT-02](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/116).

### 7. Check your setup

```bash
npm run build       # compile every service
npm test            # 26 tests, no env vars needed
npm run lint
npm run typecheck
npm run format      # apply Prettier
```

All four should pass on a fresh clone. If they do, you are set up correctly.

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
