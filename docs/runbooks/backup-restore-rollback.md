# Stack backup, restore and rollback (PLT-09, #284)

This is the restore contribution to REL-02 (#168). Four databases are the durable system of record;
RabbitMQ queues and the deployment's `.env` are separate. Keep backups encrypted/access-controlled
off the container host, with a separately protected copy of deployment credentials and signing keys.
The bundle includes account data, password hashes and message payloads. Never commit or publicly
upload it. Scripts use private directory/file permissions and no password in database arguments or
file names. `backups/` and `.recovery-results/` are ignored.

## Take a consistent backup

Arrange an exclusive maintenance window: no direct service-port clients or manual SQL writers.
From the repository root, with the stack healthy and its usual `.env` present:

```bash
./scripts-backup.sh /path/to/private-backups
```

The command stops edge/browser ingress, waits up to 90 seconds for RabbitMQ queues (normal,
retry and dead-letter queues) and unpublished outboxes to empty, then stops application writers.
It checks that boundary again. If work appeared during shutdown or cannot drain, it fails, removes
the partial bundle and resumes previously running applications; resolve the pending delivery first.
`BACKUP_DRAIN_TIMEOUT_SECONDS` can extend the wait. Supplier has no outbox because it publishes no
events. Services' shutdown hooks wait for in-flight local work before the final check.

With writers stopped, it dumps `foc_user`, `foc_supplier`, `foc_order`, `foc_credit` in custom format
using the Postgres container's local socket identity. A timestamped private directory contains four
`.dump` files and `manifest.json`: archive SHA-256, every table's row count and deterministic content
SHA-256, source commit/dirty state and the maintenance boundary. The last stdout line is the bundle
path. Applications previously running resume automatically. `--leave-stopped` is for an intentional
restore/drill; failure still resumes them.

Run at least once every 24 hours and copy the successful bundle off-host to meet RPO 24 h. A local
file on the same laptop is not disaster protection. The script does not install a scheduler or an
offsite storage policy; the deployment operator must arrange those and monitor backup failures.

## What RabbitMQ recovery means

RabbitMQ persists messages in its own volume, which is **not** in these dumps. Outbox rows persist
unpublished operations; inbox/operation keys make delivery replays harmless. However a published
outbox row can have been pruned, and separately timed database dumps can straddle consumer commits.
Therefore outbox alone cannot recover arbitrary lost broker contents or make a live four-DB dump
consistent. This procedure deliberately refuses a non-drained cut, including retry/DLQ messages.
At the accepted cut every queued message has been consumed/parked in its owner's durable DB and
every outbox has published. Restore into an empty broker; resumed services rebuild queue topology.
The ordinary outbox/inbox protections then cover new work/retries after startup. A parked dead
letter is restored in its database and remains available for the audited operator redrive.

## Restore into a fresh stack

Provision free ports and a matching private `.env` using the normal setup instructions. Keep the
original stack and volumes intact until recovery is proven. Pull/build the intended release images
first. Use the same code or a verified forward-compatible release; migrations run after import.

```bash
export COMPOSE_PROJECT_NAME=foc-restored
./scripts-restore.sh /path/to/private-backups/20261027T000000Z-example
```

The script verifies bundle structure/custom archive magic and checksums before importing. It refuses
running application writers, existing tables in any service DB, or a broker containing messages.
It starts only Postgres/RabbitMQ, restores each dump in a transaction as that DB's owning service
role, and compares **every table's exact row count and content fingerprint before startup**. Then
it starts the stack/migrations without rebuilding, waits for health, runs the complete smoke test
and `npm run audit:credits`. Restore is successful only if all of these pass. A partially failed
import is not usable: discard only the explicitly selected fresh target and retry from the backup.
The script never clears an existing DB or runs `down -v` itself.

Smoke deliberately adds fresh test records, and startup can append audit/operational rows. This is
why exact comparison occurs before startup and smoke. The financial audit must finish PASS/0.
Use the [financial audit runbook](credit-ledger-audit.md) if it reports a mismatch; do not repair
balances or remove immutable history to make the check pass.

## Roll back application images

Review migration changes between the target image's commit and the current deployment **before**
rollback. Release-to-release schema changes must be additive and older binaries must tolerate the
newer schema: no drops/renames/type narrowing, incompatible constraints or rewrites of historical
migrations. New nullable/defaulted fields, independent tables and indexes can be compatible, but
still inspect what old code reads/writes. Keep new features disabled until this is proven. A schema
change needing destructive cleanup must wait for a later release after the rollback window.

```bash
./scripts-rollback.sh sha-<full-40-character-previous-release-commit> --additive-migrations-reviewed
```

This pulls all five prior application images before stopping ingress, selects them through
`compose.images.yaml`, retains database/broker volumes, starts healthy and runs smoke plus credit
invariants. It never downgrades schema or fabricates a local image under a published tag. The
explicit flag records the caller's migration-compatibility check; it is not a SQL parser or an
automatic proof. The target image must actually be published and accessible. Private GHCR images
require a credential with `read:packages` (use `docker login --password-stdin`, never a token argument).
Prefer same-origin web builds compatible with the edge and configured ports; an older build with
compiled localhost service URLs may need its original deployment configuration.

If startup fails, retain logs and select the known working current image tag with the same procedure;
do not delete volumes as a rollback attempt. The edge/configuration and secrets must also be compatible
with the selected version. A deployment rollback is separate from an errand status transition.

## Rehearse without touching developer data

Configure `.env` for unused ports before running; the normal developer stack may remain on its own
ports. The drill generates its own `foc-recovery-drill-<timestamp>-<pid>` project, exercises real
reserve/transfer/release data, takes a quiet backup, destroys **only that project's volumes**, restores,
compares every table, smokes and audits. RTO is measured from the first destruction through successful
restore, health, smoke and audit; more than 3600 seconds fails. Teardown removes its own new project.

```bash
./scripts-recovery-drill.sh
# Once a real previous release tag is available and its migrations have been reviewed:
./scripts-recovery-drill.sh --rollback-tag sha-<full-previous-commit>
```

The private `.recovery-results/drill.json` records elapsed seconds, commit/dirty state and which
checks really ran. Without a tag it explicitly says rollback `NOT_RUN`; this is not complete #284
acceptance. Backups remain private there for inspection. CI's required Compose smoke job runs the
backup/restore drill and uploads only its summary JSON, never dumps. Dated reviewed evidence belongs
under `docs/reports/`; do not claim a rollback drill succeeded until it ran on published images.
