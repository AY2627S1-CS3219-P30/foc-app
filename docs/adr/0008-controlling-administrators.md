# ADR 0008 — How administrators are controlled

- **Status:** Proposed; implementation basis
- **Date:** 2026-10-08
- **Deciders:** Group 30; approvals tracked in [the ADR index](README.md)
- **Ticket:** [ADM-01 #218](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/218)
- **Built by:** ADM-03 [#220](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/220), ADM-04
  [#221](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/221), ORD-11
  [#171](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/171), PLT-06
  [#155](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/155)

## Context

D3 teaching-team feedback (7 Oct 2026): _"think about how to control admins"_.

Until now the rules limited who may act **on** an administrator: only a bootstrap (seeded) admin may
demote or suspend one, nobody may demote or suspend themselves, at least one admin always remains,
and every change is audited in the same transaction as the change ([roles.md](../user-service/roles.md)).
Nothing stopped one administrator from misusing powers they legitimately hold — appointing friends,
suspending people in bulk, browsing accounts — and nobody was told when they did. A stolen admin
session could do anything until it expired.

## Decision

Administrators are controlled in five layers. Each names the code or ticket that enforces it.

### 1. Least authority (existing, kept)

- Two roles, `STUDENT` and `ADMIN`; every admin is also a student.
- Only a **seeded** admin may demote or suspend an admin (`ADMIN_DOWNGRADE_NOT_PERMITTED`,
  `ADMIN_ACTION_NOT_PERMITTED`). Appointed admins cannot remove the people who appointed them.
- Nobody may demote or suspend themselves; the last admin cannot be removed.
- No API deletes an account, edits an audit record or changes a wallet balance. Credits move only
  through reservation, transfer and release ([ADR 0007](0007-credit-invariant-and-double-entry-ledger.md)).

### 2. Two people for every role change (ADM-03)

Appointing or demoting an admin is a **request**, not an action:

1. An admin requests the change with a reason (`PUT /admin/users/{id}/role` answers `202` with
   the pending request). The request is audited as `ROLE_CHANGE_REQUESTED`.
2. An **approver** — an active admin who is neither the requester nor the target — approves
   (`POST /admin/role-requests/{id}/approve`) or rejects it (`…/reject`), with their own reason.
   Only an approval changes the role; it is audited as `ROLE_GRANT` / `ROLE_REVOKE` with the
   approver as actor and `approval: SECOND_ADMIN`, and emits `user.role-changed`. A rejection is
   audited as `ROLE_CHANGE_REJECTED`. The requester may withdraw their own request by rejecting it.
3. A request not decided within **24 hours** expires and can no longer be approved.
4. Every rule from layer 1 is checked when the request is made **and again** when it is approved,
   with the approver, the requester and the target locked: an approver or a requester who lost the
   role or was suspended meanwhile, a target who was suspended, or a request that would no longer
   change anything (`ROLE_REQUEST_STALE`) stops the change.
5. One pending request per target at a time (`ROLE_REQUEST_PENDING`), even when the change would
   otherwise apply at once (below): an open request is decided or withdrawn first.

**Only when nobody else holds the role** — a single admin, or two admins where the other is the
target — does the requester act alone: the change applies at once (`200`), a warning is logged, and
the audit row says so (`approval: NO_APPROVER`). This keeps the first appointment possible, and a
target never decides their own demotion. ADM-04 raises an alert for every role change either way.

Every holder of the role counts, **suspended or not**. Otherwise one admin could suspend the
others, change a role alone, and reactivate them. A suspended admin approves nothing, so a request
whose only possible approvers are suspended waits for one to be reactivated — which is controlled
and alerted (layer 3) — or for a second seeded admin (Break glass).

### 3. Re-entering the password for the riskiest actions (ADM-03)

Requesting a role change, approving or rejecting someone else's request, and suspending or
reactivating an admin require the admin to have re-entered their password (`POST /auth/step-up`) in
the **last 5 minutes** in the same sign-in; otherwise `401 STEP_UP_REQUIRED`. Withdrawing one's own
request does not. Permission rules are checked first, so nobody is asked for a password they could
not use. A stolen access token alone can no longer change who is an admin, undo an admin's
suspension, or quietly reject pending demotions. Step-up is rate-limited like sign-in.

A token refresh keeps the re-entry, since it continues the same sign-in; another login or device does
not, and neither does a revoked session. So a stolen *refresh cookie* used within those 5 minutes
inherits it. That is accepted: the cookie is `HttpOnly` and `SameSite=Strict`, and using a copy
revokes the whole session family as soon as the real browser refreshes.

### 4. Conflicts of interest

- An admin cannot approve their own request, and the target of a request cannot decide it
  (`SELF_APPROVAL_FORBIDDEN`, `CONFLICT_OF_INTEREST`).
- An admin cannot decide a referred errand they are the requester or courier of
  (`403 CONFLICT_OF_INTEREST`, ORD-11 #171).

### 5. Watching the admins (ADM-04)

- **Writes** are audited in the same transaction as the change (existing).
- **Reads of personal data** are recorded: Credit records every admin wallet and ledger read
  (`admin_wallet_reads`); the User Service records every admin read of another user's full record,
  opened one at a time or listed (`admin_reads`, `GET /admin/reads`). The **directory**
  (`GET /admin/directory`) is not recorded: email, display name, roles and status, enough to find an
  account and see its standing, and nothing of its profile. The console finds and names accounts
  through it.
- **Alerts** (`GET /admin/alerts`, and a structured warn log) when:

  | Alert                      | When                                                      | Default |
  | -------------------------- | --------------------------------------------------------- | ------- |
  | `ROLE_CHANGE`              | any role change is applied                                | always  |
  | `ADMIN_SUSPENDED`          | an administrator is suspended                             | always  |
  | `ADMIN_REACTIVATED`        | an administrator is reactivated                           | always  |
  | `BULK_SUSPENSIONS`         | one admin suspends this many accounts within an hour       | 10      |
  | `SUSPENSION_LIMIT_REACHED` | one admin hits the suspension limit below                  | 20      |
  | `BULK_READS`               | one admin reads this many accounts within an hour          | 50      |

  A bulk alert is raised at most once per admin per hour, under an advisory lock so simultaneous
  requests cannot raise it twice.
- **A hard limit**: one admin may suspend at most 20 accounts in a rolling hour; the next attempt
  is refused with `429 RATE_LIMITED` and changes nothing. Counted from the audit trail, so it holds
  across restarts and instances.

Thresholds are configuration (`ADMIN_SUSPENSIONS_ALERT_PER_HOUR`, `ADMIN_SUSPENSIONS_LIMIT_PER_HOUR`,
`ADMIN_READS_ALERT_PER_HOUR`, `ROLE_REQUEST_TTL_HOURS`, `STEP_UP_WINDOW_SECONDS`), not code.

### Break glass (existing)

If no seeded admin is reachable, an operator adds a new address to `ADMIN_SEED_EMAILS` and
redeploys. That needs deployment access — the authority that created the first admin — and the
bootstrap is audited as `ADMIN_BOOTSTRAP` by `SYSTEM`.

The new bootstrap admin can stop a misbehaving admin at once, alone: a seeded admin may suspend any
admin, which ends all of that admin's sessions. Removing the role still takes two people, because an
admin who has left still holds it and counts as a possible approver. So the recovery seeds **two**
new addresses: one asks for the demotion and the other approves it. Both suspensions and role changes
raise alerts (`ADMIN_SUSPENDED`, `ROLE_CHANGE`), and reactivating an admin needs a seeded admin and
the password and raises `ADMIN_REACTIVATED`, so a rogue seeded admin's suspension of the others can
neither stay unnoticed nor be undone quietly.

## Every admin action and its control

| Service  | Action                                      | Controls                                                              |
| -------- | ------------------------------------------- | --------------------------------------------------------------------- |
| User     | find accounts (directory)                   | admin only; email, name, roles and status only; not recorded          |
| User     | read or list full account records           | admin only; every other account read is recorded; bulk-read alert     |
| User     | suspend / reactivate a student              | reason; audited; per-admin suspension limit and bulk alert            |
| User     | suspend / reactivate an admin               | seeded admin only; password re-entry; reason; audited; alert          |
| User     | appoint / demote an admin                   | two-person rule; password re-entry; tier rules; audited; alert        |
| User     | approve / reject a role request             | approver only; password re-entry (not to withdraw one's own); audited |
| User     | read audit trail, reads, alerts, requests   | admin only; read-only (no route edits a record)                        |
| Supplier | create / update / deactivate a supplier     | admin only; versioned (`If-Match`); deactivation, never deletion      |
| Order    | read stuck and reconciling errands          | admin only                                                            |
| Order    | decide a referred errand (ORD-11)           | reason; audited; conflict-of-interest rule                            |
| Credit   | read a wallet or ledger                     | admin only; every read recorded                                       |
| Platform | redrive a dead letter (PLT-05)              | operator only; payload unchanged; audited                             |
| Platform | publish to the broker                       | one broker account per service, limited to its own events (PLT-06)    |

## Alternatives considered

- **Scoped admin roles** (support, operations, owner): finer least privilege, but more roles to
  assign and test. The seeded/appointed tier plus the two-person rule already blocks the main risk,
  privilege escalation. Revisit if the console grows more powers.
- **Two people for every suspension**: too slow for stopping abuse as it happens. A rate limit,
  alerts and password re-entry for suspending an admin cover the abuse cases instead.
- **TOTP or WebAuthn second factor** for admins: stronger than password re-entry, but needs an
  enrolment and recovery flow. Password re-entry is the step that fits this sprint.
- **Time-limited admin grants**: removes dormant admins, but forces renewals; the console's user
  list (filter by role) supports a periodic manual review instead.
- **Letting the target approve their own demotion**: harmless for demotion, but a target who can
  _reject_ their own demotion could block it, so targets decide neither way.

## Consequences

- A role change takes a second admin and up to a day. The single-approver case with exactly two
  admins (demoting the other) is accepted: bounded by the seeded tier, logged, alerted, and marked
  `NO_APPROVER` on its audit row.
- Admins re-enter their password before high-impact actions; the console prompts for it.
- Operators have one place to see who did what, who looked at what, and what looked unusual.
- Directory information (email, name, roles, status) can be read without a record; every full
  record read is recorded.
- Removing an admin role while another admin is unreachable takes a second seeded admin, so
  break-glass seeds two addresses.
- Remaining gaps, tracked: Order's admin reads are not recorded; Supplier changes keep no actor record; Credit raises no
  bulk-read alert of its own; the affected user is not notified of an admin action (no notification
  channel yet).
