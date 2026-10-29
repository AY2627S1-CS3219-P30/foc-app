#!/usr/bin/env bash
# Restore ONLY into empty service databases with no running application writers.
# Usage: COMPOSE_PROJECT_NAME=foc-restored ./scripts-restore.sh BACKUP_BUNDLE
set -euo pipefail
cd "$(dirname "$0")"
. ./scripts-env.sh
. ./scripts-recovery-lib.sh
[[ $# -eq 1 ]] || { echo 'Usage: COMPOSE_PROJECT_NAME=<fresh-project> ./scripts-restore.sh BACKUP_BUNDLE' >&2; exit 2; }
: "${COMPOSE_PROJECT_NAME:?Select an explicit fresh Compose project for restore}"
bundle=$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve(strict=True))' "$1")
python3 scripts-recovery.py verify "$bundle"
recovery_apps_stopped
docker compose up -d --wait postgres rabbitmq >&2
python3 scripts-recovery.py empty
recovery_broker_empty || { recovery_error 'Target broker contains messages; restore requires a fresh broker too.'; exit 1; }

for name in user supplier order credit; do
  echo "Restoring foc_$name..." >&2
  docker compose exec -T postgres sh -ec \
    'exec pg_restore -U "$POSTGRES_USER" --exit-on-error --single-transaction --no-owner --no-acl --role "$1" -d "$2"' \
    -- "${name}_service" "foc_$name" <"$bundle/foc_$name.dump"
done
# Compare BEFORE startup, migrations, seeding and smoke can append new rows.
python3 scripts-recovery.py compare "$bundle"
docker compose up -d --wait --no-build >&2
./scripts-smoke.sh
npm run audit:credits
echo 'Restore complete: exact table contents verified, stack healthy, smoke and financial audit passed.'
