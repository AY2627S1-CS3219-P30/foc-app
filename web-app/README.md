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

**Accounts are live (USR-05).** Register, activate, sign in, change password, profile and the
requester↔courier switch call the real User Service (`src/lib/user-api.ts`, `src/lib/auth.tsx`).
Errands, wallet and suppliers still run on the in-memory mock store (`src/lib/store.tsx`); replacing
that is [WEB-01](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/146).

### Sessions

- The access token is kept **in memory only** (never `localStorage`); the refresh token is an
  `HttpOnly` cookie the page cannot read. Every cold load calls `/auth/refresh`.
- Refresh **rotates** the cookie and a reused cookie revokes the session, so refresh is
  single-flight: one promise per tab, and a Web Lock (`foc-auth-refresh`) across tabs. Without the
  lock, two tabs restored together sign each other out — verified in a browser both ways.
- An API call that gets `401` refreshes once and retries. Signing out in one tab signs out the others.
- Screens in the `(app)` group need a session; a signed-out visitor goes to `/login?next=…` and
  comes back afterwards (`next` must be a same-site path).
- `NEXT_PUBLIC_USER_SERVICE_URL` is inlined at **build** time; unset, it is `http://localhost:3001`.

### Tests

`bun test` runs the unit tests in `test/` (validation, error-envelope parsing, redirect safety, nav
ordering). They use Bun's built-in runner, so `test/` is excluded from the Next typecheck.

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
└── lib/           auth + User Service client, store, types, navigation, mock data
```

## Deployment

Pushes to `main` that touch `web-app/**` deploy to Vercel via
[`.github/workflows/deploy-web-app.yml`](../.github/workflows/deploy-web-app.yml).
