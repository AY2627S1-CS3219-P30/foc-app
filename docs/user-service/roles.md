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
| Register, activate, log in                          | ✅        | ✅      | ✅             | ❌ login denied   | ✅ ¹  |
| Change own password (`POST /auth/password`, proving the current one; no token) | ✅ with the password | ❌ | ✅ | ❌ | ✅ |
| Refresh / log out own session                       | 🔒        | ❌      | ✅             | ❌                | ✅ ¹  |
| Read own profile                                    | 🔒        | ❌      | ✅             | ❌                | ✅    |
| Edit own profile (display name, faculty, avatar, contact pref, preferred mode) | 🔒 | ❌ | ✅ | ❌ | ✅ |
| Edit `role`, `status`, `id`, `email` through profile | ❌ (never a valid field, any actor) |
| Read / edit **another** user's profile               | 🔒        | ❌      | ❌             | ❌                | read ✅, edit ❌ |
| List users, read audit records, reads, alerts, role requests | 🔒 | ❌      | ❌             | ❌                | ✅ ² |
| Suspend / reactivate a user                          | 🔒        | ❌      | ❌             | ❌                | ✅ (not self) ³ |
| Appoint an admin (`STUDENT` → `ADMIN`)               | 🔒        | ❌      | ❌             | ❌                | request ✅ ⁴ |
| Downgrade an admin (`ADMIN` → `STUDENT`)             | 🔒        | ❌      | ❌             | ❌                | seeded admin requests, never self ⁴ |
| Approve / reject a role request                      | 🔒        | ❌      | ❌             | ❌                | ✅ unless requester or target ⁴ |
| Re-enter own password (`POST /auth/step-up`)         | 🔒        | ❌      | ✅             | ❌                | ✅    |
| Internal identity / permissions lookup               | service credential only — no user token is accepted |

¹ Except a bootstrap admin who has not yet replaced the bootstrap password: login and refresh answer
`403 PASSWORD_CHANGE_REQUIRED`, and every token-guarded route treats a session of theirs as ended. The
one thing they can do is `POST /auth/password` (§4).

² Reading another user's account is recorded (`GET /admin/reads`); many reads in an hour raise an alert.
³ Suspending an **admin**: seeded admin only, and the password must have been re-entered in the last
5 minutes. Suspending anyone: at most 20 per admin per hour, with an alert from 10.
⁴ Two-person rule: the change applies only when another eligible admin approves, within 24 hours,
and both the request and the approval need the password re-entered in the last 5 minutes. See
[ADR 0008](../adr/0008-controlling-administrators.md) for every control on administrators.

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
| Cancel, confirm receipt, report non-receipt (**own** errand as requester) | 🔒 | ✅    | ❌                | ✅    |
| Record pickup / delivery, withdraw (errand **assigned to you**) | 🔒      | ✅             | ❌                | ✅    |
| Read an errand you are neither requester nor courier of       | 🔒        | ❌             | ❌                | ✅ (admin console, NTH-01) |
| Act on **someone else's** errand, with a reason, through the transitions the Order Service gives an *Administrator* — today: resolve a dispute (`DISPUTED` → paid or refunded) | 🔒 | ❌ | ❌ | ✅    |
| System transitions (deadline, timeouts, credit replies)       | Not a user action — performed by the service itself or on a Credit Service event |

An administrator's *own* errands follow the student rules. On **someone else's** errand an administrator
may take exactly the transitions `order-service/README.md` lists with *Administrator* as actor — today,
resolving a dispute — each with a reason, enforced server-side by the Order
Service (decisions.md R4). Nothing else: an administrator does not confirm receipt or record a delivery
for someone, and no administrator action edits a wallet.

### Credit Service (designed — CRD-01…CRD-08; enforced by `@foc/auth-client` + ownership checks)

| Action                                              | Anonymous | Active STUDENT | Suspended STUDENT | ADMIN |
| --------------------------------------------------- | :-------: | :------------: | :---------------: | :---: |
| Read **own** wallet balance and ledger              | 🔒        | ✅             | ❌                | ✅    |
| Read **another** user's wallet                      | 🔒        | ❌             | ❌                | ✅ read-only (admin console, NTH-01) |
| Directly credit, debit or adjust any wallet         | ❌ — **no actor, ever.** Credits move only as reservation, transfer and release driven by errand events (closed economy, CRD-06) — an administrator's errand decision included. |

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
(a bootstrap secret from the environment or secret store) and creates those accounts through normal
account provisioning — the seed's own SQL, not the registration endpoint, with the same guarantees:
Argon2id hash with a unique salt, domain check, one transaction, and the `UserActivated` event so Credit
Service issues a wallet. They are `ACTIVE`, `ADMIN` and `STUDENT`, with
`is_seeded_admin = true`. Properties:
- **Idempotent** — an address that already exists is skipped; two boots at once still create one account.
- **Never escalates** — an address that already has an ordinary account is *skipped, not promoted*; a
  config line must not be able to grant privilege to an existing student.
- **Fails loudly** — an off-allowlist address, or emails without a password, stops the service at boot.
- **No endpoint** creates the first admin, and the password is never logged.
- **Audited** — each account created writes an `ADMIN_BOOTSTRAP` audit row with actor `SYSTEM`
  (`actor_id` null), in the same transaction as the account. The secret is not recorded.
- **The bootstrap secret cannot start a session.** A bootstrap admin signing in with it is refused with
  `403 PASSWORD_CHANGE_REQUIRED` and gets no session; `POST /auth/password` (proving the bootstrap
  password) sets their own password and clears the flag. After that the secret no longer signs in to
  *that* account — not even after a restart with the same configuration, because the seed skips
  existing accounts — and it cannot be chosen again as its password.
- **Until it is claimed, a seeded account belongs to whoever knows the secret.** One
  `ADMIN_SEED_PASSWORD` covers every address in `ADMIN_SEED_EMAILS`, and `POST /auth/password` proves
  the password, not the mailbox. So claim each seeded account as soon as the deploy that creates it is
  up, and **rotate the secret whenever `ADMIN_SEED_EMAILS` changes**: otherwise whoever knew the old one
  (an earlier admin, anyone who read the old configuration) can claim the new account first.

**Promotion (no developer involved).** An `ADMIN` calls `PUT /admin/users/{id}/role` with `ADMIN`
and a reason. The target must be `ACTIVE`. Any admin, seeded or appointed, may ask to appoint further
admins (US-FR3.1.3).

**Two people for every role change (ADR 0008, ADM-03).** Asking changes nothing: the answer is `202`
with a pending request. The change applies only when an **eligible approver** — an active admin who is
neither the requester nor the target — approves it within 24 hours, and it is then written with an
audit record (the approver as actor) in the same transaction. Every rule in this section is checked
again at approval, so a requester who was demoted or suspended meanwhile, or a target who was
suspended, stops it. Both the request and the approval need the admin's password re-entered in the
last 5 minutes. When nobody else is eligible (a lone admin, or two where one is the target), the
change applies at once, is logged as a warning, and raises an alert like any other role change.

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
| Suspending another admin                                              | Allowed only for a seeded admin, after re-entering the password; an appointed admin gets `403 ADMIN_ACTION_NOT_PERMITTED`; always raises an `ADMIN_SUSPENDED` alert |
| Approving your own role request, or one about yourself                | `409 SELF_APPROVAL_FORBIDDEN` / `409 CONFLICT_OF_INTEREST` |
| A 21st suspension by one admin within an hour                         | `429 RATE_LIMITED`, nothing changes, and a `SUSPENSION_LIMIT_REACHED` alert |

**Why keep the seeded-vs-appointed tier (US-FR3.1.3.1)?** The D1 feedback asked us to reconsider it:
once the bootstrap admin graduates, could a misbehaving appointed admin never be removed? Decision:
**keep the tier**, because that failure has a recovery path that needs no database edit — the operators
add a new address to `ADMIN_SEED_EMAILS`, rotate `ADMIN_SEED_PASSWORD` and redeploy, which bootstraps a
fresh seeded admin who can then demote or suspend the appointed one (`user-service/test/seed.test.ts`
walks through it). With the two-person rule, an admin who has left still counts as an approver, so the
new seeded admin first suspends each unreachable admin — which needs no second admin — and their role
changes then apply at once (ADR 0008, "Break glass"). Recovery therefore requires *deployment access*, which is exactly the authority that
created the first admin.
Without the tier, any appointed admin — possibly appointed casually — could demote every other admin
but one, including the operators who appointed them. The last-admin protection alone does not stop
that takeover; the tier does.
- **Trade-off:** routine removal of an admin needs a seeded admin to be reachable; if none is, the fix
  is a redeploy rather than an in-app action.
- **The recovery address must be a dedicated mailbox that has never been registered.** The seed skips
  any existing account, `PENDING_ACTIVATION` included, and anyone can register an NUS address without
  owning its mailbox (the account just never activates). So keep the address private until it is
  claimed. If the boot log reports it as skipped, it has been squatted: configure a different
  never-registered address (with a fresh secret) and redeploy. The seed never takes over an existing
  row — that is the same rule that stops a config line promoting a student.

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
- The controls on administrators (two-person rule, password re-entry, alerts, the suspension limit) are
  ADR 0008, status *Proposed* until the group approves it.
- Order and Credit rows above are the agreed design; each service's own matrix test must confirm them once its endpoints land.
