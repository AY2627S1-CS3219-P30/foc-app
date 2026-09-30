# Architecture decision record index

Architecture decisions are immutable history. A later decision amends or supersedes an earlier
record; it does not silently rewrite it.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-runtime-and-service-framework.md) | Runtime, framework and repository layout | Accepted |
| [0002](0002-asynchronous-order-credit-saga.md) | Asynchronous Order/Credit saga | Proposed; implementation basis |
| [0003](0003-service-boundaries-and-data-ownership.md) | Service boundaries and database ownership | Proposed; implementation basis |
| [0004](0004-authentication-and-trust.md) | Authentication, authorization and service trust | Proposed; implementation basis |
| [0005](0005-error-contract.md) | HTTP and event error contract | Proposed; implementation basis |
| [0006](0006-time-policy.md) | UTC time and timer ownership | Proposed; implementation basis |
| [0007](0007-credit-invariant-and-double-entry-ledger.md) | Credit invariant and double-entry ledger | Proposed; implementation basis |

“Proposed; implementation basis” means the repository uses the decision while the required human
review is collected. The author cannot record approval on another team member's behalf.

## Approval register

| Reviewer | Required by | Status | Date |
| --- | --- | --- | --- |
| Isaac Chua (`@isaacchua0309`) | #132, #183 | Authored; self-review pending | — |
| Zhang Yuan (`@volleyballkickedme`) | #132, #183; Order owner | Pending | — |
| Jonus (`@jonushzw`) | #132, #183 | Pending | — |
| Anselm Long (`@anselmlong`) | #183 | Pending | — |
| Patrick Thomas (`@pastchum`) | #183 | Pending | — |

At least one non-author must approve the pull request before merge. After all five members have read
the pack, replace each pending row with `Approved` and the approval date, then change ADRs 0002–0007
to `Accepted`.
