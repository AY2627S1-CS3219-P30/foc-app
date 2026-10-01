# Domain glossary and credit-operation triggers

These terms are used consistently in requirements, code, contracts and user-facing documentation.

| Term | Definition |
| --- | --- |
| Errand / order | One requester instruction for items from a supplier, with a credit reward and lifecycle owned by Order Service. “Order” is the service/code term; “errand” is the product term. |
| Requester | The student who creates an errand and whose credits fund its reward. |
| Courier | A student other than the requester who accepts and performs the errand. |
| Wallet | Credit Service's aggregate for one user, holding non-negative available and reserved balances. |
| Available | Whole credits not committed to an order and usable for a new reservation. |
| Reserved | Whole credits held for an order and unavailable to spend until released or transferred. |
| Total | `available + reserved`; derived, never independently updated. |
| Reservation | The atomic move of a reward from the requester's available balance to reserved balance for one order. |
| Release | The atomic return of one live reservation from reserved to the same requester's available balance. |
| Transfer | The atomic consumption of one live requester reservation and credit of the courier's available balance. |
| Issuance | Creation of credits by the platform; the only operation that increases the sum of wallet totals. |
| Referral | Escalation of a disputed or timed-out order to an administrator; it is not a credit movement. |
| Atomicity | A credit operation either completes in full or leaves all relevant balances, ledger rows and outgoing events unchanged. |
| Idempotency | Processing the same operation again moves no additional credits and reproduces the recorded outcome. |

## Valid operation triggers

| Operation | Valid trigger | Initiating service | Request event | Credit reply |
| --- | --- | --- | --- | --- |
| ISSUE | User Service commits a user's first activation | User | `user.activated` | none |
| RESERVE | Order commits a private `PENDING_CREDIT` order and its reward request | Order | `order.reservation-requested` | `credit.reserved` or `credit.reservation-rejected` |
| RELEASE | Order enters `RELEASE_PENDING_CREDIT` after cancellation, expiry or admin resolution for requester | Order | `order.release-requested` | `credit.released` |
| TRANSFER | Order enters `COMPLETION_PENDING_CREDIT` after requester confirmation, auto-confirmation or admin resolution for courier | Order | `order.completion-requested` | `credit.transferred` |

Only creating an errand requires available credits. A zero-balance student can still browse, accept,
pick up and deliver errands as a courier.

