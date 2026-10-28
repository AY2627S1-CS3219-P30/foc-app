#!/usr/bin/env bash
# Destructive ONLY to the fresh, uniquely named project created here. Never the user's project.
# Usage: ./scripts-recovery-drill.sh [--rollback-tag sha-<commit>] [--no-build]
set -euo pipefail
cd "$(dirname "$0")"
. ./scripts-env.sh
umask 077
rollback_tag=""
build=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --rollback-tag) rollback_tag="${2:?A previous published image tag is required}"; shift 2 ;;
    --no-build) build=0; shift ;;
    *) echo 'Usage: ./scripts-recovery-drill.sh [--rollback-tag sha-<commit>] [--no-build]' >&2; exit 2 ;;
  esac
done
[[ -z "$rollback_tag" || "$rollback_tag" =~ ^sha-[0-9a-f]{40}$ ]] || { echo 'Use an immutable sha-<commit> rollback tag.' >&2; exit 2; }
export COMPOSE_PROJECT_NAME="foc-recovery-drill-$(date -u +%Y%m%d%H%M%S)-$$"
project="$COMPOSE_PROJECT_NAME"
report_dir="${RECOVERY_REPORT_DIR:-.recovery-results}"
mkdir -p "$report_dir"
report_dir=$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve())' "$report_dir")
cleanup() {
  local status=$?
  trap - EXIT
  if [[ $status -ne 0 ]]; then docker compose logs --no-color --tail=80 >&2 || true; fi
  # This variable was created in this process, never taken from a caller's project setting.
  docker compose -p "$project" down -v >&2 || true
  exit "$status"
}
trap cleanup EXIT
if [[ $build -eq 1 ]]; then docker compose up -d --build --wait; else docker compose up -d --no-build --wait; fi
./scripts-demo-credits.sh
npm run audit:credits
bundle=$(./scripts-backup.sh --leave-stopped "$report_dir/backups")
start=$(date +%s)
docker compose -p "$project" down -v
./scripts-restore.sh "$bundle"
elapsed=$(($(date +%s) - start))
[[ $elapsed -le 3600 ]] || { echo "Restore took $elapsed seconds, exceeding RTO 60 minutes." >&2; exit 1; }
rollback=NOT_RUN
if [[ -n "$rollback_tag" ]]; then
  ./scripts-rollback.sh "$rollback_tag" --additive-migrations-reviewed
  rollback=PASS
fi
python3 - "$report_dir/drill.json" "$elapsed" "$project" "$bundle" "$rollback" "$rollback_tag" <<'PY'
import datetime,json,subprocess,sys
path,seconds,project,bundle,rollback,tag=sys.argv[1:]
report={"date":datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "commit":subprocess.check_output(["git","rev-parse","HEAD"],text=True).strip(),
        "workingTreeDirty":bool(subprocess.check_output(["git","status","--porcelain"],text=True).strip()),
        "project":project,"restoreSeconds":int(seconds),"rtoSeconds":3600,
        "exactTableFingerprints":"PASS","smoke":"PASS","financialAudit":"PASS",
        "rollback":rollback,"rollbackTag":tag or None,"backupBundle":bundle}
with open(path,"w") as stream: json.dump(report,stream,indent=2); stream.write("\n")
print(json.dumps(report,indent=2))
PY
