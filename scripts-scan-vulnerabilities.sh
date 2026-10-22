#!/usr/bin/env bash
# Vulnerability scan of the dependencies and of the images this repository builds
# (NTH-04, #164; PL-NFR4.1.2).
#
#   ./scripts-scan-vulnerabilities.sh --lockfile          package-lock.json's production dependencies
#   ./scripts-scan-vulnerabilities.sh --image NAME...     images you have built
#
# Trivy lists every HIGH and CRITICAL vulnerability that has a fixed version, and the
# scan fails when any of them is CRITICAL: a critical hole that an upgrade closes is
# closed before the change merges. HIGH ones are listed, not gated. One with no fix
# yet is left out of both, as nothing here can resolve it. This Trivy does not read
# the web app's bun.lock; the web app's production dependencies are in its image,
# which is scanned instead.
#
# Fails loudly with a non-zero exit code, so CI can gate on it.
set -euo pipefail
cd "$(dirname "$0")"

# Pinned like every other image: see the README's table of pre-built images.
TRIVY='aquasec/trivy:0.58.1@sha256:ab70a02200597efa04748f210f793936eb647cbcdb0ea69cc30b226d6f5a22c7'
# Trivy's vulnerability database, kept between runs on this machine. A CI job starts
# with none and downloads it (from mirror.gcr.io, falling back to ghcr.io).
CACHE="${TRIVY_CACHE:-$HOME/.cache/foc-trivy}"
mkdir -p "$CACHE"

pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
FAILURES=0

usage() {
  echo "usage: $0 --lockfile | --image NAME..." >&2
  exit 2
}

# The Docker socket lets Trivy read a local image; the checkout is read-only.
trivy() {
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$CACHE:/root/.cache/trivy" \
    -v "$PWD:/repo:ro" "$TRIVY" "$@"
}

# scan WHAT COMMAND TARGET [FLAG...]: list what can be fixed, then gate on the critical.
scan() {
  local what="$1" command="$2" target="$3"
  shift 3
  echo "Scanning $what..."
  trivy "$command" --quiet --scanners vuln --ignore-unfixed --severity HIGH,CRITICAL \
    --exit-code 0 "$@" "$target"
  local status=0
  # 3 means a finding; anything else non-zero means Trivy itself failed.
  trivy "$command" --quiet --scanners vuln --ignore-unfixed --severity CRITICAL \
    --exit-code 3 --format json "$@" "$target" >/dev/null || status=$?
  case $status in
    0) pass "$what: no critical vulnerability with a fix" ;;
    3) fail "$what: a critical vulnerability with a fix (listed above); upgrade it" ;;
    *) fail "$what: Trivy did not run (exit $status)" ;;
  esac
}

case "${1:-}" in
  --lockfile)
    scan "package-lock.json (production dependencies)" fs /repo --skip-dirs '**/node_modules'
    ;;
  --image)
    shift
    [[ $# -gt 0 ]] || usage
    for image in "$@"; do scan "$image" image "$image"; done
    ;;
  *) usage ;;
esac

echo
if [[ $FAILURES -eq 0 ]]; then
  echo "No critical vulnerability with a fix."
else
  echo "$FAILURES scan(s) failed."
  exit 1
fi
