#!/usr/bin/env bash
# Secret scan of the repository and of the images it builds (PLT-06; PL-NFR2.1.1).
#
#   ./scripts-scan-secrets.sh                  the repository, then the images
#   ./scripts-scan-secrets.sh --repo           the repository only (no build)
#   ./scripts-scan-secrets.sh --image NAME     one image you have built, and nothing else
#
# The repository: gitleaks over every file git tracks or would track, as it is on
# disk now. Your git-ignored `.env` is not one of them and is never read by the
# scanner. Rules and the three allowed kinds of value are in `.gitleaks.toml`.
#
# The images: each image this repository builds must hold no `.env` file, no
# secret-named variable in its configuration, and none of the values in your
# `.env` anywhere in its history or its application files. A secret reaches a
# container only when it runs, from the environment.
#
# Fails loudly with a non-zero exit code, so CI can gate on it.
set -euo pipefail
cd "$(dirname "$0")"

# Pinned like every other image: see the README's table of pre-built images.
GITLEAKS='ghcr.io/gitleaks/gitleaks:v8.30.0@sha256:691af3c7c5a48b16f187ce3446d5f194838f91238f27270ed36eef6359a574d9'

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
FAILURES=0

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

if [[ "${1:-}" != "--image" ]]; then
  # ---- the repository -----------------------------------------------------------
  echo "Scanning the repository..."
  mkdir "$work/tree" "$work/report"
  git ls-files -z --cached --others --exclude-standard |
    while IFS= read -r -d '' file; do
      # Listed but deleted on disk: nothing to scan. (Not `[[ ]] &&`: as the loop's last
      # command a false test would fail the pipeline and end the run without a word.)
      if [[ -f "$file" ]]; then printf '%s\0' "$file"; fi
    done |
    tar --null -T - -cf - | tar -xf - -C "$work/tree"
  if [[ -e "$work/tree/.env" ]]; then
    fail ".env is tracked by git, or not ignored: it must never be committed"
  fi
  status=0
  docker run --rm -v "$work/tree:/scan:ro" -v "$work/report:/report" -v "$PWD/.gitleaks.toml:/gitleaks.toml:ro" \
    "$GITLEAKS" dir /scan --config /gitleaks.toml --no-banner --redact \
    --report-format json --report-path /report/findings.json >"$work/gitleaks.log" 2>&1 || status=$?
  files=$(find "$work/tree" -type f | wc -l | tr -d ' ')
  if [[ $status -eq 0 ]]; then
    pass "gitleaks finds no secret in the $files files git tracks or would track"
  elif [[ -s "$work/report/findings.json" ]]; then
    fail "gitleaks found what looks like a secret (values are not shown):"
    python3 - "$work/report/findings.json" <<'PY'
import json, sys
for f in json.load(open(sys.argv[1])):
    print(f"          {f['File'].replace('/scan/', '')}:{f['StartLine']}  ({f['RuleID']})")
PY
  else
    fail "gitleaks did not run (exit $status): $(tail -1 "$work/gitleaks.log")"
  fi

  if [[ "${1:-}" == "--repo" ]]; then
    echo
    [[ $FAILURES -eq 0 ]] && echo "The repository holds no secret." && exit 0
    echo "$FAILURES check(s) failed."
    exit 1
  fi
fi

# ---- the images -----------------------------------------------------------------
if [[ ! -f .env ]]; then
  echo "There is no .env here, so there are no values to look for in the images."
  echo "Create it with ./scripts-init-env.sh, or scan the repository alone with --repo."
  exit 1
fi

# The values to look for: every secret in .env, one per line. They go to the
# containers below as a read-only file and are never printed.
{ grep -E '^[A-Z0-9_]*(PASSWORD|KEY|TOKEN|SECRET)=.{16,}$' .env || true; } | cut -d= -f2- | sort -u >"$work/values"
[[ -s "$work/values" ]] || {
  echo ".env has no secret to look for; has it been generated?"
  exit 1
}

check_image() { # image
  local image=$1 problems="" named inside
  docker image inspect "$image" >/dev/null 2>&1 || {
    fail "$image: no such image"
    return
  }

  named=$(docker image inspect "$image" --format '{{range .Config.Env}}{{println .}}{{end}}' |
    cut -d= -f1 | grep -E '(PASSWORD|KEY|TOKEN|SECRET)$' | tr '\n' ' ' || true)
  [[ -z "$named" ]] || problems="$problems; its configuration sets ${named% }"

  # Read whole, then searched: `grep -q` stops at its first match, and under pipefail the command
  # it cut off would make a match look like no match.
  local history config
  history=$(docker image history --no-trunc --format '{{.CreatedBy}}' "$image")
  config=$(docker image inspect "$image")
  if grep -qFf "$work/values" <<<"$history"; then
    problems="$problems; a value from .env is in its build history"
  fi
  if grep -qFf "$work/values" <<<"$config"; then
    problems="$problems; a value from .env is in its configuration"
  fi

  # The last line it prints says the look inside happened. Without it (the image has no shell,
  # or the container did not start) the image was not scanned, and that is a failure, not a pass.
  inside=$(docker run --rm --network none --entrypoint sh -v "$work/values:/values:ro" "$image" -c '
    find /app /home /tmp /root \( -name ".env" -o -name ".env.*" \) ! -name ".env.example" 2>/dev/null | head -3
    grep -rlFf /values /app 2>/dev/null | head -3
    echo scanned-to-the-end' 2>/dev/null || true)
  if [[ "$(tail -1 <<<"$inside")" != "scanned-to-the-end" ]]; then
    problems="$problems; its files could not be read, so it was not scanned"
  else
    inside=$(sed '$d' <<<"$inside" | sort -u | tr '\n' ' ')
    [[ -z "$inside" ]] || problems="$problems; in its files: ${inside% }"
  fi

  [[ -z "$problems" ]] && pass "$image holds no .env file, no secret variable and none of the values in .env" ||
    fail "$image${problems}"
}

if [[ "${1:-}" == "--image" ]]; then
  check_image "${2:?give the image to scan}"
else
  echo "Building the images..."
  docker compose build -q >/dev/null
  # Every image this repository builds, by the name Compose gives it. A migrate job runs its
  # service's image under another name, so the service's own is the one to scan.
  images=$(docker compose config --format json | python3 -c '
import json, sys
config = json.load(sys.stdin)
for name, service in config["services"].items():
    if "build" in service and not name.endswith("-migrate"):
        print(service.get("image") or "%s-%s" % (config["name"], name))') || images=""
  [[ -n "$images" ]] || fail "found no image to scan: the Compose file lists none that it builds"
  for image in $images; do
    check_image "$image"
  done
fi

echo
if [[ $FAILURES -eq 0 ]]; then
  echo "No secret in the repository or in the images."
else
  echo "$FAILURES check(s) failed."
  exit 1
fi
