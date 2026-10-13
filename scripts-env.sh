#!/usr/bin/env bash
# Sourced by the stack scripts (smoke, failure demo, restart check): reads `.env`.
#
# Ports, logins and tokens come from the same git-ignored `.env` that Compose
# reads, so no script carries a default password (PL-NFR2.1.1). As with Compose,
# a variable already set in the environment wins over the file.
if [[ ! -f .env ]]; then
  echo "There is no .env here. Create it with ./scripts-init-env.sh, from the repository root." >&2
  exit 1
fi
while IFS= read -r __line || [[ -n "$__line" ]]; do
  [[ "$__line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
  [[ -n "${!BASH_REMATCH[1]+set}" ]] || export "${BASH_REMATCH[1]}=${BASH_REMATCH[2]}"
done <.env
unset __line
