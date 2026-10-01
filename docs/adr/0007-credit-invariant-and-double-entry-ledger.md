# ADR 0007 — Credit invariant and double-entry ledger

- **Status:** Proposed; implementation basis
- **Date:** 2026-10-01
- **Deciders:** Group 30; approvals tracked in [the ADR index](README.md)
- **Ticket:** [CRD-00 #132](https://github.com/AY2627S1-CS3219-P30/foc-app/issues/132)

## Context

Issuance, reservation, release and transfer must remain atomic, replay-safe and explainable under
concurrency. A single mutable balance cannot distinguish spendable credit from an amount already
committed to an order.

## Decision

Each `wallets` row has whole-number `available` and `reserved` columns, both constrained non-negative.
`total` is derived as `available + reserved`, never stored. New reservations spend only `available`;
a zero-available student can still browse, accept and deliver errands to earn credits.

The transaction types are `ISSUE`, `RESERVE`, `RELEASE` and `TRANSFER`. A successful movement creates
one immutable `credit_transactions` row and linked immutable `ledger_entries`: equal positive debit
and credit amounts across named accounts. ISSUE debits the platform issuance account and credits the
wallet's available account; RESERVE debits available and credits reserved; RELEASE reverses that;
TRANSFER debits the requester's reserved account and credits the courier's available account.

For every committed non-issuance transaction `t`:

```text
sum(wallet.available + wallet.reserved after t)
  = sum(wallet.available + wallet.reserved before t)
sum(ledger debit amounts for t) = sum(ledger credit amounts for t)
```

For ISSUE, the wallet-side total increases by exactly the issued amount while ledger debits still
equal credits because the platform issuance account supplies it. Initial issuance is exactly 10.

Business idempotency is enforced by a unique `(order_id, transaction_type)` key for order movements,
in addition to the event inbox. A duplicate with the same requester/amount returns or republishes the
recorded outcome. Reusing an order ID with different facts is terminal: no balance changes, an audit
alert is appended, and a conflict rejection is emitted. A missing wallet is retryable because
activation may still be in flight. Invalid amount and insufficient funds are terminal business
rejections. Infrastructure/database errors are retryable.

Every mutation, its business outcome, ledger entries and reply outbox row share one database
transaction. A debit is one conditional statement:

```sql
UPDATE wallets
SET available = available - :amount, reserved = reserved + :amount
WHERE user_id = :user_id AND available >= :amount;
```

Zero affected rows means missing wallet or insufficient funds, distinguished inside the same
transaction. This prevents two concurrent read-then-write reservations from both spending the same
balance. Transfer consumes the matching reservation; it never debits available again. The unique key
prevents a replay from paying twice.

## Alternatives considered

- **One balance plus reservation rows:** derives availability through aggregation and makes every
  spend depend on correctly filtering reservation state.
- **Application read/check/write:** races under concurrent requests.
- **Single audit row per movement:** easier to display but cannot mechanically prove balanced entries.

## Consequences

Column and constraint names above are the persistence contract for Sprint 2. Read APIs group the
wallet's linked ledger entries into one immutable activity item with resulting balances.

## Revisit if

Fractional credits, negative/admin adjustments, expiry, multiple currencies, or external monetary
value are introduced. Each requires a new ADR and migration rather than weakening these constraints.

