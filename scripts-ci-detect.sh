#!/usr/bin/env bash
# Decide what CI needs to run, given a list of changed paths on stdin.
#
#   git diff --name-only BASE HEAD | ./scripts-ci-detect.sh
#
# Emits `key=value` lines suitable for $GITHUB_OUTPUT. Kept as a script rather
# than inline YAML so it can be tested without pushing a commit — see the
# self-test at the bottom of this file (`./scripts-ci-detect.sh --self-test`).
set -euo pipefail

# Shared code and root configuration can break any service, so a change to any
# of these fans out to all four.
SHARED_RE='^(platform/|package\.json|package-lock\.json|tsconfig\.base\.json|eslint\.config\.mjs|\.prettierrc|\.prettierignore|\.github/workflows/ci\.yml|\.nvmrc)'
SERVICE_RE='^(user|supplier|order|credit)-service/'
# Wiring between containers, as opposed to code inside one. `.env.example`
# belongs here because the smoke job copies it to `.env`.
STACK_RE='^(compose\.yaml|postgres-init\.sql|scripts-smoke\.sh|scripts-ci-detect\.sh|platform/|\.env\.example)|Dockerfile|\.dockerignore'
# Paths that cannot affect a build, a test or a container.
IGNORED_RE='^docs/|\.md$|^\.github/|^LICENSE$|^\.gitignore$|^\.(vscode|idea|claude)/'

# Everything else fails closed. A path none of the patterns above recognises — a
# new package such as auth-client/, seed data, a contract — is treated as
# shared and runs everything, rather than nothing. Otherwise a whole new package
# could merge with no job ever running its tests.
KNOWN_RE="$SHARED_RE|$SERVICE_RE|^web-app/|$STACK_RE|$IGNORED_RE"

detect() {
  local changed="$1" force_stack="${2:-false}"
  local matches services=() svc shared=false unrecognised=false

  matches() { printf '%s\n' "$changed" | grep -qE "$1"; }

  if printf '%s\n' "$changed" | grep -vE "$KNOWN_RE" | grep -q .; then
    unrecognised=true
  fi
  if [[ "$unrecognised" == "true" ]] || matches "$SHARED_RE"; then
    shared=true
  fi

  for svc in user-service supplier-service order-service credit-service; do
    if [[ "$shared" == "true" ]] || matches "^${svc}/"; then
      services+=("\"${svc}\"")
    fi
  done

  if [[ ${#services[@]} -eq 0 ]]; then
    echo 'services=[]'
  else
    echo "services=[$(
      IFS=,
      echo "${services[*]}"
    )]"
  fi

  matches '^web-app/' && echo 'web=true' || echo 'web=false'

  if [[ "$shared" == "true" ]] || matches "$SERVICE_RE"; then
    echo 'node=true'
  else
    echo 'node=false'
  fi

  if [[ "$force_stack" == "true" || "$unrecognised" == "true" ]] || matches "$STACK_RE"; then
    echo 'stack=true'
  else
    echo 'stack=false'
  fi
}

# ---- self-test ---------------------------------------------------------------
if [[ "${1:-}" == "--self-test" ]]; then
  FAILURES=0
  check() {
    local name="$1" input="$2" expect="$3"
    local got
    got=$(detect "$input" false | grep "^${expect%%=*}=")
    if [[ "$got" == "$expect" ]]; then
      printf '  \033[32mPASS\033[0m  %-46s %s\n' "$name" "$expect"
    else
      printf '  \033[31mFAIL\033[0m  %-46s expected %s, got %s\n' "$name" "$expect" "$got"
      FAILURES=$((FAILURES + 1))
    fi
  }

  check "one service -> only that service"      "supplier-service/src/app.module.ts" 'services=["supplier-service"]'
  check "one service -> node runs"              "supplier-service/src/app.module.ts" 'node=true'
  check "one service -> web skipped"            "supplier-service/src/app.module.ts" 'web=false'
  check "one service -> stack skipped"          "supplier-service/src/app.module.ts" 'stack=false'
  check "platform -> all four services"         "platform/src/env.ts" 'services=["user-service","supplier-service","order-service","credit-service"]'
  check "platform -> stack runs"                "platform/src/env.ts" 'stack=true'
  check "root config -> all four services"      "tsconfig.base.json" 'services=["user-service","supplier-service","order-service","credit-service"]'
  check "lockfile -> all four services"         "package-lock.json" 'services=["user-service","supplier-service","order-service","credit-service"]'
  check "web only -> no services"               "web-app/src/app/page.tsx" 'services=[]'
  check "web only -> web runs"                  "web-app/src/app/page.tsx" 'web=true'
  check "web only -> node skipped"              "web-app/src/app/page.tsx" 'node=false'
  check "docs only -> no services"              "docs/EXECUTION-PLAN.md" 'services=[]'
  check "docs only -> node skipped"             "docs/EXECUTION-PLAN.md" 'node=false'
  check "docs only -> stack skipped"            "docs/EXECUTION-PLAN.md" 'stack=false'
  check "README only -> nothing runs"           "README.md" 'services=[]'
  check "compose -> stack runs"                 "compose.yaml" 'stack=true'
  check "compose -> no services"                "compose.yaml" 'services=[]'
  check "a Dockerfile -> stack runs"            "order-service/Dockerfile" 'stack=true'
  check "a Dockerfile -> that service too"      "order-service/Dockerfile" 'services=["order-service"]'
  check "web Dockerfile -> stack and web"       "web-app/Dockerfile" 'web=true'
  check "two services -> both"                  "$(printf 'user-service/src/a.ts\ncredit-service/src/b.ts')" 'services=["user-service","credit-service"]'
  check "mixed web + service"                   "$(printf 'web-app/x.tsx\norder-service/src/y.ts')" 'services=["order-service"]'
  check "this workflow -> all four"             ".github/workflows/ci.yml" 'services=["user-service","supplier-service","order-service","credit-service"]'
  check "deploy workflow -> nothing"            ".github/workflows/deploy-web-app.yml" 'services=[]'
  check "issue template -> nothing"             ".github/ISSUE_TEMPLATE/config.yml" 'node=false'
  check "docs PDF -> nothing"                   "docs/CS3219-Instructions-MilestoneD2.pdf" 'node=false'
  check "gitignore -> nothing"                  ".gitignore" 'node=false'
  check "env example -> stack runs"             ".env.example" 'stack=true'
  check "env example -> no services"            ".env.example" 'services=[]'
  check "new package -> all four services"      "auth-client/src/token-verifier.ts" 'services=["user-service","supplier-service","order-service","credit-service"]'
  check "new package -> node runs"              "auth-client/src/token-verifier.ts" 'node=true'
  check "new package -> stack runs"             "auth-client/src/token-verifier.ts" 'stack=true'
  check "seed data -> all four services"        "data/csv/supplier-seed-data.csv" 'services=["user-service","supplier-service","order-service","credit-service"]'
  check "unrecognised + service -> all four"    "$(printf 'supplier-service/src/a.ts\ncontracts/x.yaml')" 'services=["user-service","supplier-service","order-service","credit-service"]'
  check "docs + service -> only that service"   "$(printf 'docs/notes.md\norder-service/src/y.ts')" 'services=["order-service"]'

  echo
  [[ $FAILURES -eq 0 ]] && echo "All detection checks passed." || {
    echo "$FAILURES failed."
    exit 1
  }
  exit 0
fi

# ---- normal use --------------------------------------------------------------
detect "$(cat)" "${FORCE_STACK:-false}"
