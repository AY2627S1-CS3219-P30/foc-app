# Verified stack recovery and published-image rollback — 28 October 2026

**PASS.** [PR #314](https://github.com/AY2627S1-CS3219-P30/foc-app/pull/314) merged at
`e5da74ae4fac5e9cf17483d3e7f687ac1fdc1a84`, closing #284. The owner authorized the internal
review/merge pipeline; no teammate approval is claimed.

[CI run 40631924720](https://github.com/AY2627S1-CS3219-P30/foc-app/actions/runs/40631924720)
passed all required checks on feature head `8f2e1c707277938e30d225fe55b2f6af6d002ec1`.
GitHub checked out its integration merge ref `ef640a9e6f4283ab7807cb9e2e90f9379e1dd9e7`.
The real Compose job ran `scripts-recovery-drill.sh` on its own generated project, with no
developer/production volumes targeted.

The script seeded actual reserve/transfer/release activity, quiesced ingress and application
writers, verified empty broker queues/unpublished outboxes, and dumped all four service databases
in custom format outside their volumes. It then destroyed only that disposable project's volumes,
restored into new volumes as each database's owning role and compared every table's row count and
canonical-row SHA-256 before startup. The full stack, smoke test and financial audit passed.

| Check | Observed result |
| --- | --- |
| Exact table contents after restore, before application startup | PASS |
| Full stack health and smoke after restore | PASS |
| CRD-10 wallet-versus-ledger financial audit | PASS |
| Restore interval, including destruction, infrastructure, import, health, smoke and audit | **105 seconds** |
| RTO threshold | 3600 seconds; met |
| Rollback to all five actual prior published images | PASS |
| Prior release tag | `sha-3560f4d7da1e647617d9b3d3d6113122e7e9c7ee` |
| Prior image health, complete smoke and credit invariants | PASS |

The `recovery-drill` summary artifact (ID `12792800858`) was downloaded and inspected. Its fields
were `exactTableFingerprints: PASS`, `smoke: PASS`, `financialAudit: PASS`, `rollback: PASS`,
`restoreSeconds: 105`, `rtoSeconds: 3600`, `workingTreeDirty: false`. It completed at
`2026-10-28T04:37:43.983611+00:00` on project `foc-recovery-drill-20261028043326-61258`.
Only the summary was uploaded; dumps, account data and credentials were excluded. This report
preserves its result after the short-lived CI artifact expires.

The prerequisite publisher was fixed in Jonus's merged #315. Prior main run `40493541331` for
`3560f4d` successfully built, scanned and pushed every application image. The rollback pulled those
registry images using CI's read-only package token; it did not substitute locally tagged builds.
#284 introduces no service schema changes relative to that release. Its documented compatibility
rule keeps older binaries on the current additive schema; the drill never downgrades the database.

The [27 October local report](2026-10-27-stack-recovery.md) remains historical evidence of the
earlier 71-second manual and 55-second repeatable restore drills, before registry rollback was
available. Their former release blocker is now resolved.

This is a real CI-sized, warm-image drill. It does not establish cold-download or production-sized
restore performance. Meeting RPO 24 hours operationally still requires daily successful backups
and protected off-host storage; the scripts do not install that schedule. RabbitMQ is not in the
database dumps: the [runbook](../runbooks/backup-restore-rollback.md) requires the verified quiet
boundary rather than claiming outbox alone can recover an arbitrary lost broker snapshot.
