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
| `bun test` | Unit tests |
| `bun run generate` | Regenerate `tokens.css` and the API types after editing `tokens.ts` or a contract |

## Design system

**Tokens.** `src/styles/tokens.ts` is the single source for colour, spacing, type, radius, shadow and
size. `bun run generate` writes them to `src/styles/tokens.css` as variables (`--color-primary`,
`--space-4`, `--text-md`, …). Use `var(--…)` in CSS modules and `vars.*` from `@/styles/tokens` in inline
styles. `bun test` fails on a literal colour, font size or weight, or a breakpoint other than the two
below.

**Breakpoints.** Mobile first. Base styles hold from **360 px**; `@media (min-width: 768px)` switches to
the top bar and sidebar; `@media (min-width: 1440px)` widens the gutters. Nothing scrolls sideways at
360, 768 or 1440, and controls are at least 44 px tall.

**Primitives** (`src/components/`):

| Component | Use |
| --- | --- |
| `Field` | Label, hint, error and required marker for one control; wires `id`, `aria-describedby` and `aria-invalid` for it |
| `Input`, `Select`, `Textarea`, `Slider` | Native controls with the shared focus, disabled and invalid looks. Work inside or outside a `Field` |
| `FormField` | Shorthand for `<Field><Input /></Field>` |
| `FormAlert` | Form-level live message (`error`, `info`, `success`) |
| `Button`, `buttonClass` | `primary`, `accent`, `outline`, `subtle`; `buttonClass()` styles a `<Link>` as a button |
| `LoadingState`, `Skeleton` | Skeleton rows announced as a status |
| `EmptyState` | Title, explanation and an optional action |
| `ErrorState` | `role="alert"` with a retry button |

```tsx
<Field label="Email" hint="Your NUS address" error={errors.email} required>
  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
</Field>
```

## API clients

Types come from the contracts in [`contracts/`](../contracts), generated into `src/lib/generated/` by
`bun run generate` — never edit them by hand, and `bun test` fails if they are stale. The Supplier
Service client (`src/lib/supplier-api.ts`) is [`openapi-fetch`](https://openapi-ts.dev/openapi-fetch/)
over those types, so paths, parameters and bodies are checked against the contract at compile time.
`unwrap` turns a failure into the same `ApiError` the account screens use, and `authed` refreshes the
token on a `401`:

```ts
const { authed } = useAuth();
const page = await authed((token) =>
  unwrap(supplierApi.GET("/suppliers", { params: { query: { type: "CAFE" } }, headers: bearer(token) })),
);
```

`src/lib/user-api.ts` keeps its hand-written transport (the session rules depend on it) but takes its
types from the generated User Service contract. `NEXT_PUBLIC_SUPPLIER_SERVICE_URL` works like the User
Service's address below.

## Talking to the services

**Accounts are live (USR-05).** Register, activate, sign in, change password, profile and the
requester↔courier switch call the real User Service (`src/lib/user-api.ts`, `src/lib/auth.tsx`).
Errands, wallet and suppliers still run on the in-memory mock store (`src/lib/store.tsx`); replacing
that is [WEB-01](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/146).

### Sessions

The rules live in `src/lib/session.ts` (no React, so they are unit-tested); `src/lib/auth.tsx`
holds the React state around them.

- The access token is kept **in memory only** (never `localStorage`); the refresh token is an
  `HttpOnly` cookie the page cannot read. Every cold load calls `/auth/refresh`.
- Refresh **rotates** the cookie and a reused cookie revokes the session, so refresh is
  single-flight: one promise per tab, and a Web Lock (`foc-auth-refresh`) across tabs. Without the
  lock, two tabs restored together sign each other out — verified in a browser both ways.
- An API call that gets `401` refreshes once and retries — with the newer token if another call
  already refreshed, so the cookie is not rotated twice. A refresh that comes back for a different
  account (signed in from another tab) reloads the user and does not replay the call.
- Only the service **refusing** the cookie (`401`/`403`) signs you out. Offline, a timeout (10 s on
  every call, so a hung service cannot hold the lock) or a `5xx` shows "Try again" instead.
- Signing out must reach the service, or the cookie stays live for the next person at a shared
  computer. If it cannot, a non-secret `foc-logout-pending` flag goes into `localStorage`, the sign-in
  screen says so (with a retry), and the next load revokes the cookie instead of refreshing it.
  Signing out in one tab signs out the others.
- Screens in the `(app)` group need a session; a signed-out visitor goes to `/login?next=…` and
  comes back afterwards (`next` must resolve to a path on this site).

### Configuration

- `NEXT_PUBLIC_USER_SERVICE_URL` is inlined at **build** time, so set it where the app is built:
  the Vercel project's environment, or the `web-app` build args in `compose.yaml` (the Dockerfile
  takes it as an `ARG`; setting it on a running container does nothing). Unset, a development build
  uses `http://localhost:3001`; a production build shows a configuration error on the account
  screens rather than calling localhost. The build itself still succeeds.
- **The web app and the User Service must be same-site** (same registrable domain, e.g.
  `app.example.com` and `api.example.com`; the port does not matter, so `localhost:3000` and
  `localhost:3001` are fine). The refresh cookie is `SameSite=Strict`
  (`user-service/src/auth/cookies.ts`), so across sites the browser never sends it and every reload
  signs the user out. Note that each `*.vercel.app` subdomain is its own site. The User Service's
  `CORS_ORIGINS` must also list the web app's origin.
- `NEXT_PUBLIC_DEV_MAILBOX=true` lets a production build use the User Service's development mailbox
  (the Compose stack does, since its User Service runs in development mode). A development build
  always may; nothing else calls it.

### Waiting on the User Service

- **Resend activation.** There is no endpoint to send a fresh activation link, and registering again
  is refused (`409 EMAIL_ALREADY_REGISTERED`), so an expired link is a dead end: the activate screen
  can only say to contact support. It needs something like `POST /auth/activation/resend` (rate
  limited, answering the same whether or not the email exists).

### Tests

`bun test` runs the unit tests in `test/`: validation, error-envelope parsing, redirect safety, nav
ordering, the generated API client, `Field`'s accessibility wiring, generated files being current, the
design-token rules, and the session rules above (single-flight refresh, retry after `401`, which failures
sign out, pending sign-out, cross-tab sign-out) against a fake `fetch`, fake locks and a fake tab
channel. They use Bun's built-in runner, so `test/` is excluded from the Next typecheck. CI runs them
in the `web-app` job.

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
├── components/    shared UI and the form, button and state primitives
├── lib/           auth, API clients (generated/ from contracts), store, navigation, mock data
└── styles/        design tokens (tokens.ts → generated tokens.css)
```

## Admin console (ADM-02)

`/admin` sits in the `(app)` group, so it needs a session, and shows the console to administrators
only: a student who visits is told it is not for them, and the menu entry appears for administrators
alone. That is presentation. Every page calls real endpoints (`src/lib/admin-api.ts`), and each of them
refuses a student with `403` on its own.

| Page | Calls |
| --- | --- |
| Overview | Role requests and alerts (User Service); stuck errands and reconciliation (Order Service) |
| Users, one account | `GET /admin/users[/{userId}]`, suspend, reactivate, role change |
| Role requests | `GET /admin/role-requests`, approve, reject |
| Audit trail | `GET /admin/audit-records`, by administrator, account, action and dates |
| Admin activity | `GET /admin/alerts`, `GET /admin/reads` |
| Errands | `GET /admin/orders/pending-credit`, `GET /admin/orders/reconciliation-attempts`; referrals arrive with ORD-11 (#171) |
| Wallets | `GET /admin/wallets/{userId}` and its ledger (Credit Service; read-only, every read recorded) |
| Operations | Placeholder until PLT-05 (#154) |

**Controls on administrators** ([ADR 0008](../docs/adr/0008-controlling-administrators.md)). Every
write asks for a reason first. Requesting or approving a role change, and suspending an administrator,
can answer `401 STEP_UP_REQUIRED`: `useStepUp()` then asks for the password (`POST /auth/step-up`) and
runs the action once more (`src/lib/step-up.ts`). `session.ts` hands `STEP_UP_REQUIRED` and
`INVALID_CREDENTIALS` straight back to the caller instead of refreshing, since neither is about the
token. A role change answers `202` while it waits for a second administrator, and the account page
shows who may approve it.

**Names, not ids.** Tables name accounts from one read of the user list (`_components/Directory.tsx`):
opening each account instead would record an admin read for every name on screen.

`NEXT_PUBLIC_ORDER_SERVICE_URL` and `NEXT_PUBLIC_CREDIT_SERVICE_URL` work like the User Service's
address: inlined at build time, with `http://localhost:3003` and `:3004` as the development defaults.

## Deployment

Pushes to `main` that touch `web-app/**` deploy to Vercel via
[`.github/workflows/deploy-web-app.yml`](../.github/workflows/deploy-web-app.yml).
