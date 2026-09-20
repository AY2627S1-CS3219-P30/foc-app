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

**Prerequisites:** Node 22.12+ (`nvm use` reads `.nvmrc`) and Docker.

```bash
npm install          # once, from the repository root — this is an npm workspace
npm run build        # compile every service
npm test             # run every service's tests
npm run lint         # lint every service
npm run typecheck    # type-check without emitting
```

Run a single service:

```bash
SERVICE_NAME=user-service PORT=3001 npm run dev:user
curl -i http://localhost:3001/health
```

| Service            | Port | Owner      |
| ------------------ | ---- | ---------- |
| `user-service`     | 3001 | Anselm     |
| `supplier-service` | 3002 | Patrick    |
| `order-service`    | 3003 | Zhang Yuan |
| `credit-service`   | 3004 | Isaac      |
| `web-app`          | 3000 | Patrick    |

`web-app` uses Bun and its own commands — see [web-app/README.md](web-app/README.md).
It is deliberately outside the npm workspace so the two package managers never
contend for the same `node_modules`.

Every service shares `platform/`, which supplies `GET /health`, structured JSON
logging with a correlation ID on every line, a common error envelope, boot-time
environment validation, and graceful shutdown. Extend that package rather than
re-implementing any of it per service.

Copy `.env.example` to `.env` before running anything. A missing required
variable stops a service at boot and names the variable.

See [docs/adr/0001-runtime-and-service-framework.md](docs/adr/0001-runtime-and-service-framework.md)
for why the stack is what it is.

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
