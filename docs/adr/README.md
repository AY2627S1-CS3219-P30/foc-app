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
| [0007](0007-credit-invariant-and-double-entry-ledger.md) | Credit invariant and double-entry ledger | Proposed; implementation basis |
| [0008](0008-controlling-administrators.md) | How administrators are controlled | Accepted |
| [0009](0009-messaging-rabbitmq-events-and-ordering.md) | Messaging: RabbitMQ, what a message is, and ordering | Proposed; implementation basis |
| [0010](0010-api-edge.md) | The API edge: one origin, routed and protected by nginx | Proposed; implementation basis |
| [0011](0011-live-updates.md) | Live updates: a nudge, not the data | Proposed; implementation basis |
| [0012](0012-participant-chat.md) | Participant chat: a fifth service that asks the Order Service | Proposed; implementation basis |

“Proposed; implementation basis” means the repository uses the decision while the required human
review is collected. The author cannot record approval on another team member's behalf.

## Approval register

| Reviewer | Required by | Status | Date |
| --- | --- | --- | --- |
| Isaac Chua (`@isaacchua0309`) | #132, #183 | Approved 0002–0009, with the amendments to 0005 and 0006 (#254) and to 0007 (#250) | 2026-10-26 |
| Zhang Yuan (`@volleyballkickedme`) | #132, #183, #218; Order owner | Approved 0002–0008 as reviewed in #246; confirmation of 0009 and the #250 amendment to 0007 pending | 2026-10-19 |
| Jonus (`@jonushzw`) | #132, #183 | Approved 0002–0009, with the amendments to 0005 and 0006 (#254) and to 0007 (#250) | 2026-10-29 |
| Anselm Long (`@anselmlong`) | #183, #218 | Approved 0002–0009, with the amendments to 0005 and 0006 (#254) and to 0007 (#250) | 2026-10-27 |
| Patrick Thomas (`@pastchum`) | #183 | Approved 0002–0009, with the amendments to 0005 and 0006 (#254) and to 0007 (#250) | 2026-10-29 |

At least one non-author must approve the pull request before merge. Accept each record only when
all five members' recorded approval covers that record and its amendments. ADRs 0002–0006 and
0008 are Accepted. ADR 0007's #250 amendment and ADR 0009 still need Zhang Yuan's explicit
confirmation; both records remain Proposed, so #238 remains open. ADRs 0010 and 0011 retain their
separate Proposed status.

Jonus's expanded approval and requested date are recorded in his
[PR #337 review](https://github.com/AY2627S1-CS3219-P30/foc-app/pull/337#pullrequestreview-5686104565).
Patrick records his own approval in #337. The outstanding scope of Zhang Yuan's approval is
also identified in [Anselm's review](https://github.com/AY2627S1-CS3219-P30/foc-app/pull/337#pullrequestreview-5693231613);
neither that review nor this register supplies his missing confirmation.
