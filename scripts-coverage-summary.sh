#!/usr/bin/env bash
# Test coverage of one or more packages, as a Markdown table (NTH-04, #164; PL-NFR4.1.1).
#
#   ./scripts-coverage-summary.sh order-service platform ...
#
# Reads each package's `coverage/coverage-summary.json`, which its tests write when run with
# `npm test -w <package> -- --coverage --coverage.reporter=json-summary`. CI appends the table to
# the job's summary. It reports; it does not gate: no package has a coverage threshold. A package
# that wrote no summary is listed as such rather than left out.
set -euo pipefail
cd "$(dirname "$0")"

[[ $# -gt 0 ]] || { echo "usage: $0 PACKAGE..." >&2; exit 2; }

echo '| Package | Lines | Branches | Functions |'
echo '| --- | ---: | ---: | ---: |'
for package in "$@"; do
  summary="$package/coverage/coverage-summary.json"
  if [[ -f "$summary" ]]; then
    jq -r --arg package "$package" \
      '.total | "| `\($package)` | \(.lines.pct)% | \(.branches.pct)% | \(.functions.pct)% |"' "$summary"
  else
    echo "| \`$package\` | no summary | | |"
  fi
done
