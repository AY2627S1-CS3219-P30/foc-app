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

### Supplier Service (built — SUP-01; enforced by `@foc/auth-client`)

| Action                                              | Anonymous | Active STUDENT | Suspended STUDENT | ADMIN |
| --------------------------------------------------- | :-------: | :------------: | :---------------: | :---: |
| List, search, view suppliers (`GET /suppliers[/:id]`) | 🔒      | ✅             | ❌                | ✅    |
| Create, edit, deactivate a supplier (`POST`, `PUT`, `DELETE /suppliers…`) | 🔒 | ❌ | ❌         | ✅    |

A student **may not** edit suppliers. The web app hides the admin controls for clarity only; the service
refuses a student's write regardless (`403 FORBIDDEN`), because `@AdminOnly` reads the role from the
User Service, not from anything the client sent.

### Order Service (designed — ORD-01…ORD-11; enforced by `@foc/auth-client` + ownership checks)

"Requester" and "courier" below are *relationships to one errand*, not roles: any active STUDENT is the
requester of errands they created and the courier of errands they accepted.

| Action                                                        | Anonymous | Active STUDENT | Suspended STUDENT | ADMIN |
| ------------------------------------------------------------- | :-------: | :------------: | :---------------: | :---: |
| Create an errand                                              | 🔒        | ✅             | ❌                | ✅    |
| Browse open errands; accept one that is not your own          | 🔒        | ✅             | ❌                | ✅    |
| Cancel, confirm receipt, report non-receipt (**own** errand as requester) | 🔒 | ✅    | ❌                | ✅ (own only) |
| Record pickup / delivery, withdraw (errand **assigned to you**) | 🔒      | ✅             | ❌                | ✅ (own only) |
| Read an errand you are neither requester nor courier of       | 🔒        | ❌             | ❌                | ✅ read-only (console, USR-08) |
| Resolve a dispute (`DISPUTED` → paid or refunded), with reason | 🔒       | ❌             | ❌                | ✅    |
| System transitions (deadline, timeouts, credit replies)       | Not a user action — performed by the service itself or on a Credit Service event |

An administrator's *own* errands follow the student rules: being an admin grants no extra power over an
errand's lifecycle except resolving disputes.

### Credit Service (designed — CRD-01…CRD-08; enforced by `@foc/auth-client` + ownership checks)

| Action                                              | Anonymous | Active STUDENT | Suspended STUDENT | ADMIN |
| --------------------------------------------------- | :-------: | :------------: | :---------------: | :---: |
| Read **own** wallet balance and ledger              | 🔒        | ✅             | ❌                | ✅    |
| Read **another** user's wallet                      | 🔒        | ❌             | ❌                | ✅ read-only (console, USR-08) |
| Directly credit, debit or adjust any wallet         | ❌ — **no actor, ever.** Credits move only as reservation, transfer and release driven by errand events (closed economy, CRD-06). |

### Web app (UX only — never an authorization decision)

| Screen                                              | Shown to |
| --------------------------------------------------- | -------- |
| Requester views (compose, my errands) / courier views (discover, active deliveries) | Every active STUDENT; the requester↔courier switch (`preferredMode`) picks which is in front |
| Supplier admin controls, user administration, audit trail | ADMIN only — hidden for clarity; each service still refuses a non-admin |

The automated matrix test (US-NFR1.1.1) runs every protected endpoint for four actors —
unauthenticated, active student, suspended student, administrator — and fails on any unauthorized success.
The User Service's matrix is `user-service/test/matrix.test.ts`; each other service owns its own.

## 4. Role lifecycle (D2 §6)

**First administrator — bootstrapped from deployment configuration through normal account provisioning.**
Admins are never self-registered and never inserted by hand into the database. At boot the service reads
`ADMIN_SEED_EMAILS` (comma-separated, each checked against the NUS allowlist) and `ADMIN_SEED_PASSWORD`
(a bootstrap secret from the environment or secret store) and creates those accounts through the same
code path as registration: Argon2id hash with a unique salt, domain check, one transaction, and the
`UserActivated` event so Credit Service issues a wallet. They are `ACTIVE`, `ADMIN` and `STUDENT`, with
`is_seeded_admin = true`. Properties:
- **Idempotent** — an address that already exists is skipped; two boots at once still create one account.
- **Never escalates** — an address that already has an ordinary account is *skipped, not promoted*; a
  config line must not be able to grant privilege to an existing student.
- **Fails loudly** — an off-allowlist address, or emails without a password, stops the service at boot.
- **No endpoint** creates the first admin, and the password is never logged.
- **Audited** — each account created writes an `ADMIN_BOOTSTRAP` audit row with actor `SYSTEM`
  (`actor_id` null), in the same transaction as the account. The secret is not recorded.
- **The bootstrap secret is single-use.** A bootstrap admin signing in with it is refused with
  `403 PASSWORD_CHANGE_REQUIRED` and gets no session; `POST /auth/password` (proving the bootstrap
  password) sets their own password and clears the flag. From then on the configured secret opens
  nothing — not even a restart with the same configuration, because the seed skips existing accounts.

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

**Why keep the seeded-vs-appointed tier (US-FR3.1.3.1)?** The D1 feedback asked us to reconsider it:
once the bootstrap admin graduates, could a misbehaving appointed admin never be removed? Decision:
**keep the tier**, because that failure has a recovery path that needs no database edit — the operators
add a new address to `ADMIN_SEED_EMAILS` and redeploy, which bootstraps a fresh seeded admin who can
then demote or suspend the appointed one (`user-service/test/seed.test.ts` walks through it). Recovery
therefore requires *deployment access*, which is exactly the authority that created the first admin.
Without the tier, any appointed admin — possibly appointed casually — could demote every other admin
but one, including the operators who appointed them. The last-admin protection alone does not stop
that takeover; the tier does.
- **Trade-off:** routine removal of an admin needs a seeded admin to be reachable; if none is, the fix
  is a redeploy rather than an in-app action.

**The only admin tries to demote or delete their account (D2 §6, EC5).** Demotion → refused
(`409 SELF_DEMOTION_FORBIDDEN`, and `LAST_ADMIN` underneath it). **Deletion does not exist, for anyone:**
there is no account-deletion endpoint, by design (US-FR3.1.2.2). An account that should no longer be
used is *suspended*. Deleting it would orphan the errands it requested or delivered, the credit ledger
entries that moved its credits, and the audit rows that name it as actor or target — and the
closed-economy guarantee is only checkable if every ledger entry still resolves to an account. So the
"last admin deletes themselves" case cannot arise; an admin who wants to step down asks another seeded
admin to demote them.

**Why forbid self-demotion?** It removes a footgun (an admin locking the platform out by accident) and
makes the last-admin rule trivial to reason about. The cost is that a lone seeded admin cannot step down
without first appointing and seeding a successor — which is the behaviour we want.

## 5. Open decisions (need a teammate or mentor to confirm)

- Suspending another admin: restricted to seeded admins here; the backlog is silent (US-FR3.1.2 only says "an administrator").
- Order and Credit rows above are the agreed design; each service's own matrix test must confirm them once its endpoints land.
