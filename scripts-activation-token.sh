#!/usr/bin/env bash
# AI Assistance Disclosure:
# Tool: Claude Code (Claude Opus 5.5), dates: 2026-10-27 to 2026-11-05
# Scope: Generated the first version of this script for "real activation email, resend, and no token
#   on an open route" (USR-09, #309); later tooling and boilerplate.
# Author review: Anselm Long validated correctness and the implementation, and checked for fatal
#   errors and architectural conflicts, before committing.

# Prints the activation token from the newest email Mailpit holds for an address.
#
#   ./scripts-activation-token.sh e0123456@u.nus.edu
#
# The stack's User Service mails activation links to Mailpit (compose.yaml), whose
# inbox is on 127.0.0.1 only. Mail can trail the request that sent it by a moment,
# so this polls for a few seconds; it prints nothing and exits 1 if no email came.
# Reads the newest message for that address, so register or resend first. The token
# then goes to POST /auth/activate with the password the student chooses (#309).
# Links expire after ACTIVATION_TOKEN_TTL_MINUTES (30 by default).
set -euo pipefail

email="${1:?usage: $0 <email>}"
api="http://localhost:${MAILPIT_PORT:-8025}/api/v1"

python3 - "$api" "$email" <<'EOF'
import json, re, sys, time, urllib.parse, urllib.request

api, email = sys.argv[1], sys.argv[2]

def get(path):
    with urllib.request.urlopen(api + path, timeout=5) as res:
        return json.load(res)

query = urllib.parse.quote(f'to:"{email}"')
for _ in range(20):
    try:
        found = get(f"/search?query={query}&limit=1")["messages"]
        if found:
            text = get(f"/message/{found[0]['ID']}")["Text"]
            match = re.search(r"[?&]token=([A-Za-z0-9_-]+)", text)
            if match:
                print(match.group(1))
                sys.exit(0)
    except OSError:
        pass
    time.sleep(0.25)
sys.exit(1)
EOF
