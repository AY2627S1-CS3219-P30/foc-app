# Runbooks

What an operator does when something needs a person: what the alert or symptom means, what to check,
what to do, and what never to do.

| Runbook                                       | For                                                                              |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| [The edge](edge.md)                           | the one origin: its answers, following a request, changing its configuration     |
| [Dead letters](dead-letters.md)               | `DeadLetterWaiting` and `DeadLetterNotParked`: find, decide, fix, redrive, check |
| [Credit ledger audit](credit-ledger-audit.md) | the daily wallet-versus-ledger reconciliation and its alerts                     |
| [Backup, restore and rollback](backup-restore-rollback.md) | a consistent four-database backup, verified fresh-stack restore, timed recovery and prior-image rollback |

Alerts show on the Grafana dashboard's **Firing alerts** panel and at <http://localhost:9090/alerts>;
the README's [Observability](../../README.md#observability) section lists them all.
