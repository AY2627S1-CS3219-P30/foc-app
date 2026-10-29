# Architecture decision record index

Architecture decisions are immutable history. A later decision amends or supersedes an earlier
record; it does not silently rewrite it.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-runtime-and-service-framework.md) | Runtime, framework and repository layout | Accepted |
| [0002](0002-asynchronous-order-credit-saga.md) | Asynchronous Order/Credit saga | Accepted |
| [0003](0003-service-boundaries-and-data-ownership.md) | Service boundaries and database ownership | Accepted |
| [0004](0004-authentication-and-trust.md) | Authentication, authorization and service trust | Accepted |
| [0005](0005-error-contract.md) | HTTP and event error contract | Accepted |
| [0006](0006-time-policy.md) | UTC time and timer ownership | Accepted |
| [0007](0007-credit-invariant-and-double-entry-ledger.md) | Credit invariant and double-entry ledger | Accepted |
| [0008](0008-controlling-administrators.md) | How administrators are controlled | Accepted |
| [0009](0009-messaging-rabbitmq-events-and-ordering.md) | Messaging: RabbitMQ, what a message is, and ordering | Accepted |
| [0010](0010-api-edge.md) | The API edge: one origin, routed and protected by nginx | Proposed; implementation basis |
| [0011](0011-live-updates.md) | Live updates: a nudge, not the data | Proposed; implementation basis |

“Proposed; implementation basis” means the repository uses the decision while the required human
review is collected. The author cannot record approval on another team member's behalf.

## Approval register

| Reviewer | Required by | Status | Date |
| --- | --- | --- | --- |
| Isaac Chua (`@isaacchua0309`) | #132, #183 | Approved 0002–0009, with the amendments to 0005 and 0006 (#254) and to 0007 (#250) | 2026-10-26 |
| Zhang Yuan (`@volleyballkickedme`) | #132, #183, #218; Order owner | Approved | 2026-10-19 |
| Jonus (`@jonushzw`) | #132, #183 | Approved, with the amendments to 0005 and 0006 | 2026-10-20 |
| Anselm Long (`@anselmlong`) | #183, #218 | Approved 0002–0009, with the amendments to 0005 and 0006 (#254) and to 0007 (#250) | 2026-10-27 |
| Patrick Thomas (`@pastchum`) | #183 | Approved 0002–0009, with the amendments to 0005 and 0006 (#254) and to 0007 (#250) | 2026-10-29 |

At least one non-author must approve the pull request before merge. After all five members have read
the pack, replace each pending row with `Approved` and the approval date, then change ADRs 0002–0007
to `Accepted`.
