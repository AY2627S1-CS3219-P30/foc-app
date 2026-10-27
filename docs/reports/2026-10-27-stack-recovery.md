# Stack recovery evidence — 27 October 2026

Status: **backup/restore proved locally; published-image rollback NOT RUN**. This is partial #284
evidence, not a claim that the issue's complete Definition of Done has been met.

The development version of `scripts-backup.sh` / `scripts-restore.sh`, based on commit `0956860`
(worktree dirty with #284 scripts), ran on a disposable `foc-ledger-audit` Compose stack. Its own
ports were 13000–13005, PostgreSQL 55483, RabbitMQ 55683/15683 and Prometheus 19083. The developer's
`foc` project/volumes were not targeted. PostgreSQL 17 and the repository's pinned service images
built locally from #283 were used; no published-image claim is made.

The stack contained the smoke fixtures plus a real requester/courier lifecycle: reserve 3, transfer
3, reserve 2, release 2. Its scheduled, CLI and manual financial audit results were clean.

| Database | Tables compared | Rows before import/startup |
| --- | ---: | ---: |
| `foc_user` | 11 | 83 |
| `foc_supplier` | 3 | 35 |
| `foc_order` | 10 | 88 |
| `foc_credit` | 12 | 115 |

Backup stopped ingress, drained queues/outboxes, stopped writers and rechecked the boundary. Four
custom-format dumps and a private SHA-256 manifest were created outside volumes. The test then ran
`docker compose down -v` for that disposable project and restored into its fresh volumes.
Every table's row count **and content SHA-256** matched before application startup. Full smoke and
the new wallet-versus-ledger audit then passed; the audit reported PASS/0.

Measured restore interval (destruction through fresh infrastructure, import, health, full smoke and
financial audit): **71 seconds**, below RTO 3600 seconds. This is one local, warm-image drill; it
does not establish cold-download performance, production data-size performance or offsite RPO.
Private manifests/logs remain with the operator; no account data, dumps or credentials are in this
report.

The repeatable `scripts-recovery-drill.sh` also passed on its own uniquely created project at
07:49 UTC: exact table fingerprints, smoke and financial audit PASS; restore **55 seconds**.
Its JSON correctly records rollback `NOT_RUN`. The normal backup resumed the original test
application, and an attempted restore into non-empty test databases was refused before import.

Remaining evidence: run required CI, obtain an accessible prior
published release set, review migration compatibility, actually start those prior images and smoke
them, then update this report. At verification time main run `40458490320` passed CI but its
Publish images job was skipped. The current local GitHub token lacks `read:packages`; authenticated
inspection of the expected Credit tag returned `manifest unknown`. Those observations do not prove
that a previous usable release set exists. #284 must remain open until rollback is demonstrated.
