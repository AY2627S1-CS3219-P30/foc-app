# User Service — Decision Log and Trade-offs

A record of what was decided while building the User Service (contract, USR-01, USR-02), why, what
was given up, and what is still open. It exists so that in the D2 "why?" questions, and in the final
presentation, every answer is one someone already thought through — including the parts that went
wrong.

**Status legend** — ✅ built and verified · 🟡 built, one caveat · 📝 designed, not built yet · ❓ needs a teammate or mentor to confirm

Related docs: [roles.md](roles.md) (role design and authorization matrix) ·
[schema.md](schema.md) (database and tables) · `contracts/user-service.openapi.yaml` (the API) ·
`user-service/README.md` (running it).

---

## 1. How the work was organised

### P1. Closed DOC-01a (#111) instead of redoing it — ✅
The User Service FR/NFR rows were already in the submitted D1 document (US-FR1–4, US-NFR1–4, three
levels each, with priority and iteration), and the Canvas deadline (17 Sep) had passed.
- **Chosen:** close the ticket, and record three small gaps in its comment (activation single-use,
  login rate limiting / refresh rotation, log-privacy iteration) rather than edit the submitted docx.
- **Trade-off:** the docx and the tickets can now drift. The tickets are the more current source
  ("updated against the final backlog"), so they win; the docx is the frozen record.

### P2. Design artifacts before the API — ✅
Order of work: role matrix and schema first, then the OpenAPI, then code.
- **Why:** D2 explicitly grades role design and schema (§1, §2). The API cannot be specified without
  knowing which profile fields are editable and what the identity lookup returns. The docs also
  survive if the session ends.
- **Trade-off:** more writing before any running code, in a sprint where the demo window was opening.

### P3. Three stacked pull requests — ✅
`main` ← #176 (contract, docs) ← #177 (USR-01) ← #178 (USR-02).
- **Why:** the plan (§8.2) wants PRs under ~400 lines, shared-contract review is a different audience
  (Jonus, Patrick) from implementation review, and auth changes need two approvals.
- **Trade-off:** they must merge in order, each retargets to `main` as its parent lands, and a change
  requested on #176 means rebasing the two above it. `Closes #…` keywords only fire when a PR reaches `main`.

### P4. Tests run on PGlite; correctness is confirmed on real Postgres — ✅
The suite runs the service's real SQL on PGlite (PostgreSQL compiled to WASM), so it needs no server
in CI. The service itself uses `pg` against the Compose Postgres 17.
- **Trade-off:** PGlite is a single connection, so it cannot exercise real concurrency or row locking.
  That gap was closed by hand on the Compose stack (see §6), not by an automated test.
- **Still open:** those concurrency checks are not repeatable in CI. A Postgres service container in
  the pipeline (PLT-03) would fix that.

---

## 2. Roles and authorization

### R1. Two roles, `STUDENT` and `ADMIN`; requester and courier are capabilities — ✅ (design) / 📝 (RBAC enforcement, USR-03)
Every active student may both request and fulfil errands.
- **Why:** one person alternates between asking and delivering. Making them roles would force a role
  change or a second account for a routine action, and a permission check on something with no
  privilege difference.
- **Trade-off:** the requester↔courier switch is just a preference, so it cannot be used to gate
  anything. If the product later needs "courier verification", that would be a new capability, not a role flip.

### R2. `preferredMode` on the profile persists the toggle server-side — ❓
It is UX only and is never read by an authorization decision.
- **Alternative:** keep the toggle client-side (`localStorage`). Simpler, and removes a column.
- **Chosen:** persist it, so the choice follows the user across devices and USR-05 can show the right
  navigation on first load.
- **Open:** confirm with Patrick that he wants it on the profile.

### R3. Admin lifecycle rules — 📝 (documented in roles.md; implemented in USR-03)
- Admins are **seeded** from configuration, never self-registered; there is no endpoint that creates the first admin.
- Any admin may appoint an admin; **only a seeded admin may downgrade** an admin (US-FR3.1.3.1).
- **No admin may demote or suspend themselves**; the last admin can never be removed (row-locked check).
- **No account-deletion endpoint in v1** — accounts are suspended, so old orders and ledger entries always resolve to a user.
- **Why forbid self-demotion?** D2 asks what happens when an admin revokes their own privileges and no
  ticket covered it. Forbidding it removes a footgun and makes the last-admin rule trivial.
- **Trade-off:** a lone seeded admin cannot step down without first appointing and seeding a successor.
- ❓ Suspending *another* admin is restricted to seeded admins here; the backlog only says "an administrator".

---

## 3. API contract

### C1. Contract lives in `contracts/`, not `packages/contracts` — 🟡
The FND-03 ticket text says `packages/contracts`; the execution plan (§3.1, §8.1) and the root README use a flat layout.
- **Chosen:** follow the plan. **Trade-off:** it contradicts a ticket body, so Jonus should confirm; it is a `git mv` if not.

### C2. The contract is a proposal until the consumers sign off — ❓
FND-03 asked for a workshop with Patrick. There is no evidence it happened, so the cross-service
conventions (error envelope, pagination, auth header, IDs, timestamps, event envelope) are written as a
proposal in `contracts/README.md` for review in #176.
- **Trade-off:** faster to review than a meeting, but nothing is frozen until Jonus and Patrick approve.

### C3. Events follow the submitted backlog — 🟡
`UserActivated`, `UserSuspended`, `UserReactivated` — not the plan's `UserActivated` + `UserStatusChanged` (§3.2).
- **Why:** the backlog is the frozen document and USR-03 cites it. The plan looks stale on this point.
- ❓ `aggregateVersion` is in the plan's envelope but not in FND-03's scope list; left optional.

### C4. Error codes are domain codes, so the shared error filter was extended — ✅
The platform filter derived `code` from the HTTP status only (409 → `CONFLICT`). The contract promises
`EMAIL_ALREADY_REGISTERED`, `LAST_ADMIN`, `VALIDATION_FAILED` with per-field details.
- **Chosen:** add `ApiException(status, code, message, details)`; anything else still gets the status-derived code.
- **Trade-off:** it changes a package every service uses. It is additive, but Jonus should review it.

### C5. Duplicate registration returns `409 EMAIL_ALREADY_REGISTERED` — 🟡
- **Trade-off:** it tells an attacker that an address is registered (account enumeration). Accepted
  because the ticket requires rejecting duplicates, the population is one campus's `@u.nus.edu`
  addresses, and registration is rate limited. A "check your email either way" flow would hide it but
  worsens the user experience.

---

## 4. Data and storage

### S1. PostgreSQL — ✅
- **Why:** relational, constraint-heavy data (email uniqueness, one profile per user, FKs); rules that
  need transactions (single-use activation, last-admin check, suspend + revoke + audit together); simple
  indexed queries; campus scale (~10⁴ users); one engine for the whole team, one Compose service.
- **Rejected:** MongoDB (flexibility not needed, weaker cross-row invariants), Redis (cache, not a
  system of record), a hosted identity provider (would hide the RBAC and credential storage the course asks us to explain).

### S2. `pg` with hand-written, forward-only SQL migrations — 🟡
- **Chosen:** plain `pg`, a ~40-line migrator, and migrations as TypeScript strings so `tsc` carries
  them into `dist/` with no copy step.
- **Rejected:** Drizzle / Prisma. An ORM would give typed queries, but adds a dependency, a codegen or
  shadow-database step, and a second description of the schema to explain at D2.
- **Trade-off:** SQL is written and typed by hand. Every later service copies whichever approach lands first.

### S3. `text` email with a unique index on `lower(email)`, not `citext` — ✅
- **Why:** no dependency on an extension being available to the service's role; the service normalises
  before insert anyway, and the index still enforces uniqueness if a row is ever written another way.
- **Verified:** `ON CONFLICT ((lower(email)))` only skips a duplicate email — a wrong expression errors,
  and an unrelated primary-key collision still surfaces (a test pins this).

### S4. Token hashes are hex SHA-256 in `text` columns — ✅
- **Why SHA-256 and not Argon2:** activation and refresh tokens are 256 bits of randomness, so there is
  nothing to brute-force and a slow hash would only add latency. Passwords are different and use Argon2id.
- **Why `text`, not `bytea`:** `pg` returns `Buffer` and PGlite returns `Uint8Array`; hex strings behave the same on both.

### S5. Argon2id via `@node-rs/argon2`, OWASP-minimum parameters — ✅
m = 19 MiB, t = 2, p = 1, fresh salt per hash.
- **Why this package:** ships prebuilt binaries for Alpine/musl, so the Docker image builds without a compiler.
- **Trade-off:** minimum, not maximum, cost — chosen so login stays fast on a laptop during the demo.
  The encoded hash carries its parameters, so they can be raised later without invalidating old hashes.

### S6. Events go to an outbox table in the same transaction — 🟡
`UserActivated` is inserted into `outbox_events` in the activation transaction, so an account can never
activate without its event.
- **Trade-off:** nothing drains the table until EVT-02 (Jonus), which may reshape it. Until then the
  event is durable but unpublished, so Credit Service will not yet issue starting balances.

### S7. Password policy: 12–128 characters, no composition rules — ✅
Length over complexity (current NIST guidance). The 128 cap bounds Argon2 cost per request.

---

## 5. Authentication and sessions

### A1. Access token is a JWT with `sub` and `sid` only — no role, no status — ✅
Claims: `sub`, `sid`, `iss`, `jti`, `iat`, `exp`. Services learn role and status from
`GET /internal/users/{id}`.
- **Why:** if the role were in the token, a suspended or demoted user would keep it for up to 15 minutes.
  This also guarantees that no client-visible value is an authorization input (US-NFR1.1.2).
- **Trade-off:** the User Service is on every request's critical path. Consumers may cache a lookup
  for ≤ 5 s and must fail closed on `503`. Suspension therefore takes effect in seconds, not at token expiry.

### A2. Ed25519 signing with a public JWKS, not a shared HS256 secret — ✅
- **Why:** other services verify with the public key and hold no secret that could mint tokens.
- **Trade-off:** more moving parts (key generation, JWKS caching, key rotation) than one shared string.
  `kid` support is in, but rotation is not automated.
- **Dev convenience:** outside production, if `JWT_PRIVATE_KEY` is unset a throwaway key is generated,
  so no key is ever committed. Every restart then invalidates access tokens; refresh sessions survive.
  In production the key is required. ❓ JWKS caching and key distribution to other services is an open question (contracts/README.md).

### A3. Access token lives in memory; refresh token lives in an `HttpOnly` cookie — ✅
Cookie: `foc_refresh; HttpOnly; SameSite=Strict; Path=/auth` (`Secure` in production).
- **Why not `localStorage` for both:** simpler and immune to CSRF, but one XSS bug would hand an
  attacker a 7-day credential. `HttpOnly` keeps the long-lived token out of JavaScript.
- **Costs to carry:**
  1. Web and API must be the same *site* (`localhost:3000` and `:3001` are; ports don't count).
  2. A page reload loses the in-memory token, so **every cold load calls `/auth/refresh`**.
  3. `Secure` is off outside production because Safari drops `Secure` cookies over plain http.

### A4. CSRF: `SameSite=Strict` + `Origin` allowlist + JSON content type — ✅ (after a fix)
Applied to **login, refresh and logout** — every endpoint that sets or reads the cookie.
- **Why login is included:** it sets the refresh cookie. Without a check, a hostile page could post the
  attacker's own credentials and silently sign the victim in as the attacker (login CSRF / session
  fixation). *This was missed at first and caught in review — see §7.*
- **Caveats:** a request with no `Origin` is allowed (only a non-browser client omits it, and it has no
  victim cookie); the content-type rule is the backstop. `CORS_ORIGINS` doubles as the CSRF allowlist, so
  widening CORS (previews, dashboards) silently widens who can drive login/refresh/logout — flagged in code.

### A5. Refresh rotation with reuse detection, under a row lock — ✅
Each refresh issues a new token and marks the old one rotated. Presenting a rotated token revokes the
whole family. The lookup uses `SELECT … FOR UPDATE`, so simultaneous use of one token is serialised.
- **Trade-off — the two-tab problem:** two tabs refreshing at the same instant look like a replay and
  end the session. Because reloads always refresh (A3.2), restoring two tabs together is common.
  **USR-05 must make refresh single-flight across tabs** (a shared lock or `BroadcastChannel`).
- **Trade-off — sliding lifetime:** each rotation grants a fresh 7 days; there is no absolute cap.
- The ticket marks reuse detection as "cut order #4". It is built; it is the first thing to drop under time pressure.

### A6. The access-token guard checks the session in the database on every request — ✅
- **Why:** so logout is immediate rather than "within 15 minutes". Verified: the same access token goes 200 → 401 straight after logout.
- **Trade-off:** one small indexed query per protected request; the JWT is no longer fully stateless.
- **Consequence for other services:** trusting only the JWT would leave logout delayed by up to 15 minutes
  there. The shared middleware (USR-06) must check session state, not just verify the signature.

### A7. Login gives away nothing about which accounts exist — ✅
- Unknown email and wrong password return an identical response, and an unknown email still pays for an
  Argon2 verification against a dummy hash, so timing does not reveal it.
- Account status (`ACCOUNT_NOT_ACTIVATED`, `ACCOUNT_SUSPENDED`) is only revealed **after** the password is proven.
- **Trade-off:** the dummy verification means bad-email attempts cost as much CPU as real ones. Rate limits bound it.

### A8. Rate limiting is in memory, per instance — 🟡
Login 10 per email and 50 per IP per 15 min; registration 20 per IP per hour; `429` with `Retry-After`.
- **Trade-off:** correct for one replica, resets on restart, and would not be shared across replicas.
- **Known risk — client IP:** no `trust proxy` is configured. Behind a gateway every request would appear
  to come from the gateway's address, turning the per-IP limit into one **global** cap of 50 logins per
  15 minutes. Fix when the gateway is added: set Express `trust proxy` for it and read `X-Forwarded-For`, or move limiting to the gateway.

### A9. Activation is replay-idempotent and single-use — ✅
- First success → `200 alreadyActivated:false` and exactly one `UserActivated`. Replay → `200 alreadyActivated:true`, no second event.
- **Why 200 and not 409 on replay:** a user who double-clicks the email link should not see an error.
- A **suspended** account cannot activate; the request fails and the token is left unconsumed (the failed transaction rolls back).

---

## 6. Service-to-service and operations

### O1. `/internal/**` uses per-caller API keys in `X-Service-Key` — 🟡
Compared in constant time against digests; a user access token is never accepted there.
- **Rejected:** mutual TLS and service-issued JWTs — more machinery than a five-person, two-week project needs.
- **Trade-off:** static shared secrets, no rotation story. `compose.yaml` carries a **dev-only default key**
  so `up` works on a clean clone — a committed credential PLT-06 (secrets hardening) should remove.

### O2. Dev mailbox exposes activation tokens; it refuses to run in production — 🟡
`GET /dev/mailbox?to=…` returns the emailed token, so the demo can activate without a mail server.
- **Guard:** the module throws at boot if `NODE_ENV=production`, and a test pins that.
- **Trade-off:** the demo stack runs with `NODE_ENV=development`, so that endpoint is live and unauthenticated there.
  There is no production mail adapter yet — a real deployment cannot start until one exists.

### O3. Shared `platform` package changes — ✅ (needs Jonus's review)
Three additive changes, all in code every service imports:
1. `ApiException` (see C4).
2. The error filter now reports the **real** correlation id. It read `req.id` while the middleware sets
   `req.correlationId`, so every error envelope said `"unknown"`.
3. An optional log destination, so a test can assert what reaches the log.

### O4. Verification on the real stack — ✅
Run on `docker compose` (Postgres 17, the built image), not just PGlite:
- Full HTTP flow: register, duplicate, off-domain, pre-activation login, activate, replay, login, `/users/me`, foreign-origin login, rotate, replay a rotated cookie, logout, internal lookup, JWKS.
- 10 parallel registrations of one email → one `201`, nine `409`.
- 10 parallel activations of one token → one event, nine replays.
- 10 parallel refreshes of one cookie → one `200`, nine `401`, zero live sessions left.
- Stored: every password `$argon2id$`, every token hash 64-hex, no plaintext; the container log holds no password, token, hash, cookie or service key.

---

## 7. Mistakes found and fixed

Recorded because they are the honest answer to "what went wrong?" and each has a regression test.

| # | What was wrong | How it was found | Fix |
|---|---|---|---|
| 1 | An email with a stray space (`"  E0123456@U.NUS.EDU "`) was rejected with 422: validation ran before normalisation. | A test for case/whitespace duplicates failed. | Trim before the email-format check. |
| 2 | **Login had no CSRF check** while setting the refresh cookie (login CSRF / session fixation). | Advisor review of the finished USR-02 code. | Same origin and content-type check as refresh/logout; three tests. |
| 3 | The shared error filter always reported `correlationId: "unknown"`. | Noticed while wiring the contract's error envelope. | Read `req.correlationId`. |
| 4 | My "expired token" test only proved a token signed by a *different key* is rejected — it never tested expiry. | Re-reading passing tests with suspicion. | Advance the clock: 14 minutes accepted, 16 rejected. |
| 5 | The new registration rate limit made the test suite fail (one IP, dozens of registrations). | Test run. | Test app defaults to generous limiters; dedicated tests use strict ones. |
| 6 | The docs said `citext` and port `8081`; the merged scaffold uses plain `text` and port `3001`. | Reading the merged scaffold. | Docs and contract corrected. |
| 7 | The docs claimed suspension revokes refresh sessions. Nothing calls that yet. | Advisor review. | Docs now say USR-03 wires it; the guard already blocks a suspended user on the next request. |
| 9 | An oh-my-claudecode state file (`user-service/.omc/…`) was committed into #177 by a broad `git add`. | `git status` after a test run showed it as modified. | Untracked it, and gitignored `.omc/`. It only held a throttle timestamp; it stays in #177's history. |
| 10 | The roles doc said seeded admins "activate and set a password through the normal flow". Nothing like that was built. | Writing the seed code. | Doc rewritten to what exists, including the no-change-password limitation. |
| 11 | My first mutation test of the self-demotion rule "passed" — the mutation never applied because Prettier had reformatted the line. | The mutation script did not print a failure and the output showed a clean 153. | Re-ran against the real text; the test then failed as it should. Lesson: a mutation that changes nothing proves nothing. |
| 8 | The `ON CONFLICT` clause could have been a bare `DO NOTHING`, hiding any constraint failure. | Advisor question, then checked directly. | Verified the inference is real; a test pins that a primary-key collision still errors. |

---

## 8. Open questions and known limitations

**Needs a teammate or mentor**
- ❓ Jonus: review the `platform` changes (O3) and the `compose.yaml` additions; confirm `contracts/` vs `packages/contracts`; decide whether `aggregateVersion` is in the envelope.
- ❓ Patrick: is `preferredMode` on the profile the right home for the toggle? Will the gateway or dev proxy keep web and API on one site?
- ❓ Everyone: how do other services get and cache the JWKS, and who owns key rotation?

**Deferred, with an owner**
- ~~USR-03~~ — built: admin endpoints, suspension revoking sessions, audit table, seeded admins, profile edits (see §9).
- USR-05 — single-flight refresh across tabs.
- USR-06 — shared middleware must check session state, not just the JWT signature.
- PLT-06 — remove the dev default `INTERNAL_SERVICE_KEYS`.
- EVT-02 — drain `outbox_events`.
- Gateway work — configure `trust proxy` so per-IP limits mean per client.

**Not yet automated**
- The real-Postgres concurrency checks (O4) were run by hand.
- The full `docker compose up` (all services and web-app) has not been run; only Postgres and the User Service.

---

## 9. Administration and profile (USR-03)

### M1. Admin authority is read from the database on every request — ✅
`AdminGuard` looks up the caller's roles and status live. Nothing in the token, a header, or the body is consulted.
- **Consequence:** a demoted admin loses access on their very next request, with the same token. A test pins this.
- **Trade-off:** one extra indexed read per admin request.

### M2. Concurrency: lock the admin rows first, then the target, then re-check the actor — ✅
Anything that could reduce the number of admins first locks every `ADMIN` role row, so simultaneous
demotions queue. After the lock the actor's own authority is checked *again*: a demotion that landed a
moment earlier must not let its victim demote someone else.
- **Verified:** two seeded admins demoting each other at the same instant → exactly one succeeds, one admin remains.
- **Why the order matters:** a fixed lock order (admin rows, then the target) is what prevents two such transactions from deadlocking.

### M3. `LAST_ADMIN` is a safety net, and it is structurally unreachable — 🟡
A demoter must themselves be a *different* admin, so at least two admins always exist at that moment.
The real guarantees are (a) self-demotion is forbidden, and (b) demotions are serialised (M2). The
`adminIds.length <= 1` check is kept as an explicit invariant, but no test can reach the branch — the
tests prove the invariant (mutual demotion, self-demotion) rather than that line.
- **Trade-off:** a branch that reads as dead code. Kept because it fails loudly if a future change (a bulk
  endpoint, a new role source) ever breaks the reasoning above.
- Suspended admins are counted as admins for this purpose.

### M4. Only an `ACTIVE` account can be suspended — ✅
So reactivation always restores a state the account already had, and can never skip email activation.
- **Trade-off:** an admin cannot pre-emptively block an account that has registered but not yet activated;
  it can still activate later. Acceptable for v1; it can be suspended straight after.

### M5. Suspension is one transaction: status, all refresh sessions, audit row, event — ✅
The audit row's id is the `reasonRef` carried in `UserSuspended`, so a consumer can trace an event back to who did it and why.
Suspending an already-suspended account is idempotent and adds no second audit row or event.

### M6. Seeded admins come from configuration with a bootstrap password — 🟡
See roles.md. **Never promotes** an existing account; **fails loudly** on bad config; idempotent; emits `UserActivated`.
- **Trade-offs / limits:** no change-password endpoint exists, so the bootstrap password is the admin's password;
  and `compose.yaml` carries a dev-only default (`admin@u.nus.edu`) — another committed credential for PLT-06 to remove.
- **Rejected:** a first-registered-user-becomes-admin rule (racy, and a takeover risk), and a setup endpoint (an unauthenticated privilege grant).

### M7. Profile edits use a closed schema and are all-or-nothing — ✅
`PATCH /users/me` accepts five fields. `id`, `email`, `roles`, `role`, `status` or any unknown key → `422 FIELD_NOT_EDITABLE`
with **nothing changed** (not even the valid fields sent alongside). The target is always the token's subject; no route takes another user's id.
- **Why reject rather than ignore:** silently dropping `role: "ADMIN"` would hide an attack and make the client think it worked.

### M8. The audit trail is append-only by trigger *and* by revoked privilege — 🟡
A `BEFORE UPDATE OR DELETE` trigger raises, and the service's own role has `UPDATE, DELETE, TRUNCATE` revoked. No API route writes it, and it is read-only over HTTP.
- **Honest limit:** the service role *owns* the table, so it could re-grant itself or drop the trigger. True
  immutability needs a separate owner role that the service does not hold (PLT-06). Today it stops bugs and
  API abuse, not a compromised service.

### M9. Non-admins get `403`, not `404`, for a user id that may not exist — ✅
An admin route is refused before the id is looked up, so a student learns nothing about which accounts exist. A test pins it.

### M10. Deny-by-default is enforced by tests, not just by convention — ✅
- An actor–resource–action matrix runs every protected endpoint as four actors (unauthenticated, active student, suspended student, administrator) and fails on any unauthorised success.
- A **route-coverage meta-test** enumerates the live routes and fails if any is neither in the matrix nor on an explicit public list — so a new endpoint cannot ship without a matrix row.
- I deliberately broke seven rules (drop the admin guard, allow any admin to downgrade, allow self-demotion, skip session revocation, loosen the profile schema, remove the audit trigger, drop the seeded-only suspend rule) and confirmed a test fails for each.
- **Limit:** mutation testing was done by hand, once; it is not a CI job.

### M11. List endpoints use offset pagination and prefix search — ✅
`page`/`pageSize` (default 20, max 101 rejected), status/role filters, and a case-insensitive **prefix** match on email or display name with `LIKE` wildcards escaped (searching `%` matches the text, not everything).
- **Trade-off:** offset pagination drifts if rows change between pages and slows on deep pages — fine at ~10⁴ users.
