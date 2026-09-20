# Web App

The FoC front end — a responsive Next.js application covering the requester and
courier journeys.

## Toolchain

This package uses **Bun**, and is deliberately **outside** the repository's npm
workspace so the two package managers never contend for one `node_modules`.
Do not run `npm install` here.

## Getting started

```bash
cd web-app
bun install
bun dev
```

Open <http://localhost:3000>.

| Command | What it does |
| --- | --- |
| `bun dev` | Development server with hot reload |
| `bun run build` | Production build |
| `bun start` | Serve the production build |
| `bun run lint` | Lint |

## Talking to the services

The app currently runs on an in-memory mock store (`src/lib/store.tsx`) and is
not yet wired to the backend. Replacing that with a real API client is
[WEB-01](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/146).

When you do wire it up, the services run on ports 3001–3004 — see the root
[README](../README.md). Every service returns the same error envelope and echoes
an `x-correlation-id` header, so send one and log it alongside the response to
trace a failure across services.

> **Note:** `src/lib/types.ts` defines `RequestStatus` with five values. That does
> not match the order status model in
> [`order-service/README.md`](../order-service/README.md). Reconciling the two is
> part of WEB-01 — do not add screens against the current shape without reading
> that first.

## Structure

```text
src/
├── app/           routes — (app) group for the authenticated shell
├── components/    shared UI
└── lib/           store, types, navigation, mock data
```

## Deployment

Pushes to `main` that touch `web-app/**` deploy to Vercel via
[`.github/workflows/deploy-web-app.yml`](../.github/workflows/deploy-web-app.yml).
