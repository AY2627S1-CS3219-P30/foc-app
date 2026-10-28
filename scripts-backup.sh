#!/usr/bin/env bash
# A quiescent four-database backup outside Docker volumes; output is a private timestamped bundle.
# Usage: ./scripts-backup.sh [--leave-stopped] [BACKUP_PARENT]
set -euo pipefail
cd "$(dirname "$0")"
. ./scripts-env.sh
. ./scripts-recovery-lib.sh
umask 077

leave_stopped=0
[[ "${1:-}" == --leave-stopped ]] && { leave_stopped=1; shift; }
[[ $# -le 1 && "${1:-}" != --* ]] || { echo 'Usage: ./scripts-backup.sh [--leave-stopped] [BACKUP_PARENT]' >&2; exit 2; }
parent=$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "${1:-backups}")
mkdir -p "$parent"
bundle=$(mktemp -d "$parent/$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")
running=()
while IFS= read -r service; do
  [[ "$service" =~ ^(edge|web-app|user-service|supplier-service|order-service|credit-service)$ ]] && running+=("$service")
done < <(docker compose ps --status running --services)
stopped=0
complete=0
cleanup() {
  local status=$?
  trap - EXIT
  if [[ $stopped -eq 1 && ( $leave_stopped -eq 0 || $complete -eq 0 ) && ${#running[@]} -gt 0 ]]; then
    echo 'Resuming the application containers that were running before backup...' >&2
    docker compose up -d --wait --no-build "${running[@]}" >&2 || status=1
  fi
  [[ $complete -eq 1 ]] || rm -rf -- "$bundle"
  exit "$status"
}
trap cleanup EXIT

echo 'Maintenance backup: stop ingress, drain messages, then stop writers.' >&2
stopped=1
docker compose stop edge web-app >&2
deadline=$((SECONDS + ${BACKUP_DRAIN_TIMEOUT_SECONDS:-90}))
until recovery_drained; do
  if [[ $SECONDS -ge $deadline ]]; then
    recovery_error 'Queues/outboxes did not drain. No usable backup was created; resolve delivery failures first.'
    exit 1
  fi
  sleep 2
done
docker compose stop user-service supplier-service order-service credit-service >&2
recovery_apps_stopped
recovery_drained || { recovery_error 'Messages appeared while stopping writers; retry in an exclusive maintenance window.'; exit 1; }

for db in foc_user foc_supplier foc_order foc_credit; do
  # The container-local socket uses the existing Postgres identity; no password in argv or names.
  docker compose exec -T postgres sh -ec 'exec pg_dump -U "$POSTGRES_USER" --format=custom --no-owner --no-acl "$1"' -- "$db" >"$bundle/$db.dump"
done
python3 scripts-recovery.py manifest "$bundle"
complete=1
echo "Backup complete; keep it and its deployment credentials outside the container volumes." >&2
printf '%s\n' "$bundle"
