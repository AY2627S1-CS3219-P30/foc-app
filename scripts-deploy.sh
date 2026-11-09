#!/usr/bin/env bash
# AI Assistance Disclosure:
# Tool: Claude Code (Claude Opus 5.5), date: 2026-11-09
# Scope: Generated the deploy script for the AWS host (PLT-14, #357).
# Author review: TODO, to be filled in by the reviewing author before merge.

# Moves the hosted stack (PLT-14, #357) to the images CI published for a commit on main. Run it on
# the host, from its clone of the repository. The deploy workflow (.github/workflows/deploy.yml)
# runs it after every publish from main; docs/runbooks/aws-deploy.md says how to set the host up.
#
#   ./scripts-deploy.sh sha-<40 hex commit> | rc1-d4 | v1.0-d4
#
# It checks out that commit, so compose.yaml always matches the images it starts, pulls the six
# application images, starts them (each migrate container first), and runs the smoke test and the
# credit invariants. It builds nothing.
#
# Only moves forward: a commit that the deployed one already includes is skipped, as when two runs
# on main finish out of order. Going back is a rollback, which needs its migrations reviewed:
# ./scripts-rollback.sh. A failed deploy is left running for a person to look at, not rolled back.
#
# Exits 2 on a bad argument, 1 when it refuses or fails.
set -euo pipefail
cd "$(dirname "$0")"

# The checkout below replaces this file while it runs. Bash reads a function whole before calling
# it, so everything runs from main, and the exit keeps bash from reading on in the new file.
main() {
  local target="${1:-}"
  if [[ $# -ne 1 || ! "$target" =~ ^(sha-[0-9a-f]{40}|(rc[0-9]+|v[0-9]+\.[0-9]+)-d4)$ ]]; then
    echo "Usage: $0 sha-<40 hex commit> | rc1-d4 | v1.0-d4" >&2
    exit 2
  fi

  . ./scripts-env.sh
  # The images, and the host's own override (TLS in front of the edge) when it has one. A
  # COMPOSE_FILE in .env or the environment wins, as it does for every docker compose command.
  if [[ -z "${COMPOSE_FILE:-}" ]]; then
    COMPOSE_FILE=compose.yaml:compose.images.yaml
    [[ -f compose.aws.yaml ]] && COMPOSE_FILE+=:compose.aws.yaml
  fi
  export COMPOSE_FILE

  # One deploy at a time on this host, whoever started it.
  exec 9>.deploy.lock
  if ! flock -n 9; then
    echo "Another deploy is running on this host. Run this again once it has finished." >&2
    exit 1
  fi

  # Anything edited by hand here would be overwritten or block the checkout: say so instead.
  if ! git diff --quiet HEAD; then
    echo "This clone has local changes to tracked files; commit or discard them first:" >&2
    git status --short --untracked-files=no >&2
    exit 1
  fi

  git fetch --quiet --tags origin main
  local commit
  if [[ "$target" == sha-* ]]; then
    commit="${target#sha-}"
    git cat-file -e "$commit^{commit}" 2>/dev/null || {
      echo "There is no commit $commit on origin." >&2
      exit 1
    }
  elif ! commit="$(git rev-parse --verify --quiet "refs/tags/$target^{commit}")"; then
    echo "There is no tag $target on origin." >&2
    exit 1
  fi
  if ! git merge-base --is-ancestor "$commit" origin/main; then
    echo "$commit is not on main: CI publishes no images for it." >&2
    exit 1
  fi

  # The last deploy that passed, one line per deploy: "<UTC time> <tag> <commit>".
  local deployed=''
  [[ -s .deploy-history ]] && deployed="$(tail -n 1 .deploy-history | cut -d' ' -f3)"
  if [[ "$deployed" == "$commit" ]]; then
    echo "$commit is already deployed; starting its images again."
  elif [[ -n "$deployed" ]] && git merge-base --is-ancestor "$commit" "$deployed"; then
    echo "$deployed is deployed and already includes $commit: nothing to do."
    echo "To go back to $commit, review its migrations and use ./scripts-rollback.sh sha-$commit --additive-migrations-reviewed"
    exit 0
  fi

  echo "Deploying $target ($commit)${deployed:+, over $deployed}"
  git checkout --quiet --detach "$commit"
  export FOC_IMAGE_TAG="$target"

  # Pull first: an image that cannot be read must not stop what is running.
  docker compose pull user-service supplier-service order-service credit-service chat-service web-app
  local failed=''
  docker compose up -d --wait --no-build || failed='a container did not become healthy'
  if [[ -z "$failed" && "${DEPLOY_SMOKE:-1}" != 0 ]]; then
    ./scripts-smoke.sh || failed='the smoke test failed'
  fi
  if [[ -z "$failed" ]]; then
    docker compose exec -T credit-service node credit-service/dist/check-invariants.js ||
      failed='the credit invariants failed'
  fi

  if [[ -n "$failed" ]]; then
    echo "Deploy of $target FAILED: $failed. It is left running as it is." >&2
    docker compose ps >&2 || true
    if [[ -n "$deployed" ]]; then
      echo "To go back to what was running, once its migrations are reviewed (docs/runbooks/backup-restore-rollback.md):" >&2
      echo "  ./scripts-rollback.sh sha-$deployed --additive-migrations-reviewed" >&2
    fi
    exit 1
  fi

  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $target $commit" >>.deploy-history
  # Application images unused for three days. Any of them can be pulled again for a rollback.
  docker image prune -af --filter until=72h --filter "label=org.opencontainers.image.source" >/dev/null || true
  echo "Deployed $target ($commit): healthy, smoke test and credit invariants passed."
  exit 0
}

main "$@"
