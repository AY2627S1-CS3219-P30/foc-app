#!/usr/bin/env bash
# Creates or completes `.env` from `.env.example` (PLT-06; PL-NFR2.1.1).
#
#   ./scripts-init-env.sh           create .env, or add what a newer .env.example needs
#   ./scripts-init-env.sh --check   exit 1 if .env is missing something; change nothing
#
# No password, key or token is in source control. `.env.example` lists every
# variable and gives a secret no value, only a marker:
#
#   NAME=<generated>            a random value, made here, different for every variable
#   NAME=<generated:ed25519>    a signing key (base64 of a PKCS#8 PEM)
#   NAME=<from:...{OTHER}...>   built from other variables, such as a list of keys or a URL
#
# A value that is already set is never changed and never printed. Running this
# again after pulling adds whatever a newer `.env.example` introduced. `.env` is
# git-ignored and readable by you alone.
#
# The values live in two places: this file, and the volumes of a stack started
# with it (Postgres stores its role passwords). Delete `.env` and the next one
# will not match those volumes: `docker compose down -v` starts both afresh.
set -euo pipefail
cd "$(dirname "$0")"

EXAMPLE=.env.example
TARGET=.env
CHECK=0
[[ "${1:-}" == "--check" ]] && CHECK=1

ASSIGNMENT='^([A-Za-z_][A-Za-z0-9_]*)=(.*)$'
DERIVED='^<from:(.*)>$'
REFERENCE='\{([A-Za-z_][A-Za-z0-9_]*)\}'

random_hex() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

ed25519_key() {
  local pem
  if pem=$(openssl genpkey -algorithm ed25519 2>/dev/null) && [[ "$pem" == *"PRIVATE KEY"* ]]; then
    printf '%s\n' "$pem" | base64 | tr -d '\n'
  elif command -v node >/dev/null 2>&1; then
    node -e "const{generateKeyPairSync:g}=require('crypto');process.stdout.write(Buffer.from(g('ed25519').privateKey.export({type:'pkcs8',format:'pem'})).toString('base64'))"
  else
    echo "Cannot generate a signing key: this needs OpenSSL 1.1.1 or later, or Node.js." >&2
    return 1
  fi
}

# A marker's value, made now. Fails for anything that is not a generated marker.
generate() {
  case "$1" in
    '<generated>') random_hex ;;
    '<generated:ed25519>') ed25519_key ;;
    *) return 1 ;;
  esac
}

# The value NAME has in FILE (its last assignment), or nothing.
value_of() {
  awk -v name="$1" 'index($0, name "=") == 1 { v = substr($0, length(name) + 2) } END { printf "%s", v }' "$2"
}

work=$(mktemp)
done_file=$(mktemp)
trap 'rm -f "$work" "$done_file"' EXIT
changed=""
note() { changed="$changed $1"; }

# Pass 1: the file as it is (or the example, for a first run), with every
# generated marker replaced. A value that is already there is copied untouched.
base="$EXAMPLE"
[[ -f "$TARGET" ]] && base="$TARGET"
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" =~ $ASSIGNMENT ]]; then
    name="${BASH_REMATCH[1]}"
    if made=$(generate "${BASH_REMATCH[2]}"); then
      line="$name=$made"
      note "$name"
    fi
  fi
  printf '%s\n' "$line" >>"$work"
done <"$base"

# What a newer .env.example has that an existing .env does not.
if [[ "$base" == "$TARGET" ]]; then
  header=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ $ASSIGNMENT ]] || continue
    name="${BASH_REMATCH[1]}"
    value="${BASH_REMATCH[2]}"
    grep -q "^$name=" "$work" && continue
    if [[ $header -eq 0 ]]; then
      printf '\n# ---- Added by scripts-init-env.sh: new in .env.example ----\n' >>"$work"
      header=1
    fi
    if made=$(generate "$value"); then value="$made"; fi
    printf '%s=%s\n' "$name" "$value" >>"$work"
    note "$name"
  done <"$EXAMPLE"
fi

# Pass 2: values built from others, now that those exist.
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" =~ $ASSIGNMENT ]] && [[ "${BASH_REMATCH[2]}" =~ $DERIVED ]]; then
    name="${line%%=*}"
    value="${BASH_REMATCH[1]}"
    while [[ "$value" =~ $REFERENCE ]]; do
      ref="${BASH_REMATCH[1]}"
      ref_value=$(value_of "$ref" "$work")
      if [[ -z "$ref_value" || "$ref_value" == \<* ]]; then
        echo "$EXAMPLE: $name is built from $ref, which has no value." >&2
        exit 1
      fi
      value="${value//\{$ref\}/$ref_value}"
    done
    line="$name=$value"
    [[ " $changed " == *" $name "* ]] || note "$name"
  fi
  printf '%s\n' "$line" >>"$done_file"
done <"$work"

# An .env from before this script: every secret it marks must be long, the file's own, and
# not shared between variables. The old example gave three services one key and wrote short
# default passwords; a copy of it is still "complete", and must not pass for safe.
if [[ -f "$TARGET" ]]; then
  unsafe=""
  seen=$(mktemp)
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ $ASSIGNMENT ]] || continue
    name="${BASH_REMATCH[1]}"
    marker="${BASH_REMATCH[2]}"
    value=$(value_of "$name" "$done_file")
    case "$marker" in
      '<generated>')
        if [[ ${#value} -lt 24 || "$value" == *change-me || "$value" == \<* ]]; then unsafe="$unsafe $name"; fi
        printf '%s\t%s\n' "$value" "$name" >>"$seen"
        ;;
      '<generated:ed25519>')
        if [[ ${#value} -lt 100 ]]; then unsafe="$unsafe $name"; fi
        ;;
    esac
  done <"$EXAMPLE"
  # A value two variables share: one key for several services.
  shared=$(cut -f1 "$seen" | sort | uniq -d)
  if [[ -n "$shared" ]]; then
    while IFS= read -r value; do
      unsafe="$unsafe $(awk -F'\t' -v v="$value" '$1 == v { printf "%s ", $2 }' "$seen")"
    done <<<"$shared"
  fi
  rm -f "$seen"
  if [[ -n "$unsafe" ]]; then
    echo "$TARGET has values that are not safe to keep:"
    printf '%s\n' $unsafe | sort -u | sed 's/^/  /'
    echo "Each is short, shared with another variable, or left over from the defaults that used"
    echo "to be in this repository. Nothing was changed. Delete those lines, or the whole file,"
    echo "run this again, and start the stack afresh, because its volumes hold the old values:"
    echo "  docker compose down -v && docker compose up -d --build"
    exit 1
  fi
fi

if [[ $CHECK -eq 1 ]]; then
  if [[ ! -f "$TARGET" ]]; then
    echo "There is no $TARGET. Run ./scripts-init-env.sh to create it."
    exit 1
  fi
  if [[ -n "$changed" ]]; then
    echo "$TARGET is missing:$changed"
    echo "Run ./scripts-init-env.sh to add them."
    exit 1
  fi
  echo "$TARGET has every variable $EXAMPLE lists."
  exit 0
fi

if [[ -z "$changed" ]]; then
  echo "$TARGET is complete; nothing changed."
  exit 0
fi

created=1
[[ -f "$TARGET" ]] && created=0
umask 077
cat "$done_file" >"$TARGET.tmp"
mv "$TARGET.tmp" "$TARGET"
chmod 600 "$TARGET"

count=$(printf '%s\n' $changed | wc -l | tr -d ' ')
if [[ $created -eq 1 ]]; then
  echo "Created $TARGET: $count values made on this machine. It is git-ignored; do not share it."
  echo "If you ran a stack before this file existed, its volumes hold other passwords:"
  echo "run 'docker compose down -v' once, then 'docker compose up -d --build'."
else
  echo "Updated $TARGET, adding:$changed"
  if [[ "$changed" == *_DB_PASSWORD* || "$changed" == *POSTGRES_PASSWORD* ]]; then
    echo "A database password is new. A stack started before has volumes with other passwords:"
    echo "run 'docker compose down -v' once, then 'docker compose up -d --build'."
  fi
fi
