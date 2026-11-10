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
| [0010](0010-api-edge.md) | The API edge: one origin, routed and protected by nginx | Accepted |
| [0011](0011-live-updates.md) | Live updates: a nudge, not the data | Accepted |
| [0012](0012-participant-chat.md) | Participant chat: a fifth service that asks the Order Service | Accepted |

“Proposed; implementation basis” meant the repository used a decision while the required human
review was collected. No record is Proposed now. Each member records their own approval, or asks
another member to record it for them, as the notes below say.

## Approval register

| Reviewer | Required by | Status | Date |
| --- | --- | --- | --- |
| Isaac Chua (`@isaacchua0309`) | #132, #183 | Approved 0002–0012, with the amendments to 0005 and 0006 (#254) and to 0007 (#250) | 2026-11-06 |
| Zhang Yuan (`@volleyballkickedme`) | #132, #183, #218; Order owner | Approved 0002–0012, with the amendments to 0005 and 0006 (#254) and to 0007 (#250) | 2026-11-04 |
| Jonus (`@jonushzw`) | #132, #183 | Approved 0002–0012, with the amendments to 0005 and 0006 (#254) and to 0007 (#250) | 2026-11-03 |
| Anselm Long (`@anselmlong`) | #183, #218 | Approved 0002–0012, with the amendments to 0005 and 0006 (#254) and to 0007 (#250) | 2026-11-03 |
| Patrick Thomas (`@pastchum`) | #183 | Approved 0002–0012, with the amendments to 0005 and 0006 (#254) and to 0007 (#250) | 2026-11-03 |

Accept each record only when all five members' recorded approval covers that record and its
amendments. Every row now covers
0002–0012, so all twelve records are Accepted.

Jonus's expanded approval and requested date are recorded in his
[PR #337 review](https://github.com/AY2627S1-CS3219-P30/foc-app/pull/337#pullrequestreview-5686104565).
Patrick records his own approval in #337.

Approvals of 0010, 0011 and 0012, as each member gave them:

- Jonus, Anselm and Patrick each replied “Approved 0010, 0011, 0012” on #238:
  [Jonus](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/238#issuecomment-6594413902),
  [Anselm](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/238#issuecomment-6596080723),
  [Patrick](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/238#issuecomment-6596180287).
- Zhang Yuan updated their own row in #366.
- Isaac read the three records and gave his approval to Jonus on 2026-11-06, while away from his
  computer, and asked Jonus to record it here on his behalf. He will confirm it on
  [#238](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/238) when he is back.
