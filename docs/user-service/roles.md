# User Service — Role Design and Authorization Matrix

D2 §1 (Role Design) and §6 (Role Lifecycle). Backlog refs: US-FR2.1, US-FR2.1.1, US-FR2.1.2,
US-FR3.1.1–3.1.3.1, US-NFR1.1.1, US-NFR1.1.2. Update this file as the design evolves — it is reused
in the final presentation.

## 1. Roles

There are **two authorization roles**. Requester and courier are *capabilities*, not roles.

| Role      | Who                                   | Problem it solves                                                                 |
| --------- | ------------------------------------- | --------------------------------------------------------------------------------- |
| `STUDENT` | Every registered NUS student          | One identity that can both ask for errands and fulfil them — no second account.   |
| `ADMIN`   | Operators of the platform             | Someone who can suspend abusers, manage suppliers and appoint further operators.  |

Every `ADMIN` is also a `STUDENT` (an admin can still place and fulfil errands).

**Why not `REQUESTER` and `COURIER` as roles?** In FoC the same person alternates between asking and
delivering (US-FR2.1.1). Modelling them as roles would force a role change or a second account for a
routine action, and would put a permission check on something that carries no privilege difference.
The requester↔courier switch is therefore a **UX preference** (`preferredMode` on the profile). It
changes which screens the navigation shows and **never** changes a server authorization decision
(US-FR2.1.2, US-NFR1.1.2).

### Account status (orthogonal to role)

| Status               | Meaning                                              | Can log in | Can act on orders / suppliers |
| -------------------- | ---------------------------------------------------- | ---------- | ----------------------------- |
| `PENDING_ACTIVATION` | Registered, email not yet confirmed                  | No         | No                            |
| `ACTIVE`             | Normal account                                       | Yes        | Per role                      |
| `SUSPENDED`          | Blocked by an admin (with a recorded reason)         | No (new sessions denied) | No; existing sessions stop working ≤ 10 s |

## 2. Authorization rules

1. **Deny by default.** Every endpoint in every service is closed unless a row in the matrix below
   allows it.
2. **Server-side only.** Authorization reads the caller's `userId` from the verified access token and
   then reads **role and status from the User Service** (least-data lookup, `GET /internal/users/{id}`).
   A role, header or display value supplied by the client is never an input.
3. **Ownership.** "Own" means the token's `sub` equals the resource's owner id.
4. **Suspension** takes effect for new sessions immediately and for existing access tokens within
   10 s (services cache a lookup for at most 5 s). The User Service's own guard checks the session in the
   database on every request, so it blocks a suspended account immediately; USR-03 also revokes all of the
   account's refresh sessions in the same transaction as the suspension.

## 3. Actor–resource–action matrix

Legend: ✅ allowed · ❌ denied (`403`) · 🔒 `401` if unauthenticated · — not applicable.

### User Service

| Action                                              | Anonymous | Pending | Active STUDENT | Suspended STUDENT | ADMIN |
| --------------------------------------------------- | :-------: | :-----: | :------------: | :---------------: | :---: |
| Register, activate, log in                          | ✅        | ✅      | ✅             | ❌ login denied   | ✅    |
| Refresh / log out own session                       | 🔒        | ❌      | ✅             | ❌                | ✅    |
| Read own profile                                    | 🔒        | ❌      | ✅             | ❌                | ✅    |
| Edit own profile (display name, faculty, avatar, contact pref, preferred mode) | 🔒 | ❌ | ✅ | ❌ | ✅ |
| Edit `role`, `status`, `id`, `email` through profile | ❌ (never a valid field, any actor) |
| Read / edit **another** user's profile               | 🔒        | ❌      | ❌             | ❌                | read ✅, edit ❌ |
| List users, read audit records                       | 🔒        | ❌      | ❌             | ❌                | ✅    |
| Suspend / reactivate a user                          | 🔒        | ❌      | ❌             | ❌                | ✅ (not self) |
| Appoint an admin (`STUDENT` → `ADMIN`)               | 🔒        | ❌      | ❌             | ❌                | ✅    |
| Downgrade an admin (`ADMIN` → `STUDENT`)             | 🔒        | ❌      | ❌             | ❌                | seeded admin only, never self |
| Internal identity / permissions lookup               | service credential only — no user token is accepted |

### Other services (enforced by their own middleware calling the User Service — USR-06 / USR-07)

| Action                                  | Anonymous | Active STUDENT | Suspended STUDENT | ADMIN |
| --------------------------------------- | :-------: | :------------: | :---------------: | :---: |
| Supplier: list, search, view            | 🔒        | ✅             | ❌                | ✅    |
| Supplier: create, edit, delete          | 🔒        | ❌             | ❌                | ✅    |
| Order: create request (requester)       | 🔒        | ✅             | ❌                | ✅    |
| Order: browse and accept (courier)      | 🔒        | ✅             | ❌                | ✅    |
| Order: act on someone else's order      | 🔒        | ❌             | ❌                | ❌ (admin support view is a separate N2H feature) |
| Credit: read own wallet                 | 🔒        | ✅             | ❌                | ✅    |

The automated matrix test (US-NFR1.1.1) runs every protected endpoint for four actors —
unauthenticated, active student, suspended student, administrator — and fails on any unauthorized success.

## 4. Role lifecycle (D2 §6)

**First administrator.** Admins are *seeded*, never self-registered. At boot the service reads
`ADMIN_SEED_EMAILS` (comma-separated, each checked against the NUS allowlist) and `ADMIN_SEED_PASSWORD`
(a bootstrap secret from the environment or secret store) and creates those accounts as `ACTIVE`, `ADMIN`
and `STUDENT`, with `is_seeded_admin = true` and a unique Argon2id salt each. Properties:
- **Idempotent** — an address that already exists is skipped.
- **Never escalates** — an address that already has an ordinary account is *skipped, not promoted*; a
  config line must not be able to grant privilege to an existing student.
- **Fails loudly** — an off-allowlist address, or emails without a password, stops the service at boot.
- **No endpoint** creates the first admin, and the password is never logged.
- A seeded admin also gets a `UserActivated` event, so Credit Service issues a wallet like any student.

Limitation: there is no change-password endpoint yet, so the bootstrap password *is* the admin's
password until one exists. In production it must come from the secret store and be treated as sensitive.

**Promotion (no developer involved).** An `ADMIN` calls `PUT /admin/users/{id}/role` with `ADMIN`
and a reason. The target must be `ACTIVE`. The change is written with an audit record in the same
transaction. Any admin, seeded or appointed, may appoint further admins (US-FR3.1.3).

**Demotion.**

| Case                                                                  | Outcome                                             |
| --------------------------------------------------------------------- | --------------------------------------------------- |
| Appointed admin demotes another admin                                 | `403 ADMIN_DOWNGRADE_NOT_PERMITTED` (US-FR3.1.3.1)  |
| Seeded admin demotes an appointed admin or another seeded admin        | Allowed, if at least one admin remains              |
| Any admin demotes **themselves**                                      | `409 SELF_DEMOTION_FORBIDDEN` — another seeded admin must do it |
| Demotion would leave zero admins                                      | `409 LAST_ADMIN` — checked inside the same transaction with a row lock so two simultaneous demotions cannot both succeed |
| Admin suspends themselves                                             | `409 SELF_SUSPENSION_FORBIDDEN`                     |
| Suspending an account that is not `ACTIVE`                            | `409 ACCOUNT_NOT_ACTIVE` — so a never-activated account can never be "reactivated" past activation |
| Reactivating an account that is not `SUSPENDED`                        | `200` if already `ACTIVE` (idempotent), `409 ACCOUNT_NOT_ACTIVE` if pending |
| Suspending another admin                                              | Allowed only for a seeded admin; an appointed admin gets `403 ADMIN_ACTION_NOT_PERMITTED` |

**Only admin tries to demote or delete their account.** Demotion → `409 LAST_ADMIN` (and self-demotion is
already refused). There is **no account-deletion endpoint in v1**; accounts are suspended, not deleted, so
historical orders and ledger entries always resolve to a user.

**Why forbid self-demotion?** It removes a footgun (an admin locking the platform out by accident) and
makes the last-admin rule trivial to reason about. The cost is that a lone seeded admin cannot step down
without first appointing and seeding a successor — which is the behaviour we want.

## 5. Open decisions (need a teammate or mentor to confirm)

- Suspending another admin: restricted to seeded admins here; the backlog is silent (US-FR3.1.2 only says "an administrator").
- Whether an admin may act on orders they do not own — deferred to the admin console (N2H, USR-08).
