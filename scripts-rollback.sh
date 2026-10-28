#!/usr/bin/env bash
# Uses prior published images against the current schema. Never downgrades a database.
# Usage: ./scripts-rollback.sh sha-<40 hex commit> --additive-migrations-reviewed
set -euo pipefail
cd "$(dirname "$0")"
[[ $# -eq 2 && "$1" =~ ^sha-[0-9a-f]{40}$ && "$2" == --additive-migrations-reviewed ]] || {
  echo 'Usage: ./scripts-rollback.sh sha-<40 hex commit> --additive-migrations-reviewed' >&2
  echo 'First review the migration diff: older binaries must remain compatible with the current schema.' >&2
  exit 2
}
. ./scripts-env.sh
export FOC_IMAGE_TAG="$1"
export COMPOSE_FILE=compose.yaml:compose.images.yaml
# Pull first: a missing/private image must not stop the running application.
docker compose pull user-service supplier-service order-service credit-service web-app
docker compose stop edge
docker compose up -d --wait --no-build
./scripts-smoke.sh
docker compose exec -T credit-service node credit-service/dist/check-invariants.js
echo "Rollback to $FOC_IMAGE_TAG passed health, smoke and credit invariants; database volumes retained."
