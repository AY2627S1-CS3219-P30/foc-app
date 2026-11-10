#!/usr/bin/env bash
# AI Assistance Disclosure:
# Tool: Claude Code (Claude Opus 5.5), date: 2026-11-03
# Scope: Generated the first version of this script for "cut a release from a tag, without
#   rebuilding" (REL-03, #169).
# Author review: Jonus Ho validated correctness and the implementation, and checked for fatal errors
#   and architectural conflicts, before committing.

# Cuts a release candidate or the final release (REL-03, #169) from images CI already built and
# scanned. It builds nothing: each of the six images published as sha-<commit> also gets the
# release's tag, and a GitHub Release records the commit and their digests.
#
#   git tag rc1-d4 <commit on main> && git push origin rc1-d4
#
# That push runs .github/workflows/release.yml, which runs this on the tag. It needs a login to the
# registry that may write, and GH_TOKEN. docs/runbooks/release.md says when to cut one, and how to
# rehearse it and roll back.
#
#   ./scripts-release.sh rc1-d4 | rc2-d4 | v1.0-d4
#
# Exits 2 on a name that is not a release tag, and 1 when it refuses or fails. All six images are
# read before any is tagged, a re-run is safe, and a release tag never moves to other images.
set -euo pipefail
cd "$(dirname "$0")"

REGISTRY="${REGISTRY:-ghcr.io/ay2627s1-cs3219-p30}"
# What CI's publish job pushes; test-harness/test/release.test.ts holds the two together.
APPLICATIONS=(user-service supplier-service order-service credit-service chat-service web-app)

tag="${1:-}"
if [[ $# -ne 1 || ! "$tag" =~ ^(rc[0-9]+|v[0-9]+\.[0-9]+)-d4$ ]]; then
  echo "Usage: $0 <tag>, where the tag is like rc1-d4 or v1.0-d4." >&2
  exit 2
fi

if ! commit="$(git rev-parse --verify --quiet "refs/tags/$tag^{commit}")"; then
  echo "There is no tag $tag in this checkout." >&2
  exit 1
fi
if ! git merge-base --is-ancestor "$commit" origin/main; then
  echo "$tag is on $commit, which is not on main: CI scanned and published no images for it." >&2
  exit 1
fi

errors="$(mktemp)"
notes="$(mktemp)"
trap 'rm -f "$errors" "$notes"' EXIT

# Prints an image's digest. Otherwise fails, leaving what the registry said in $errors.
digest_of() {
  local manifest
  manifest="$(docker buildx imagetools inspect "$1" --format '{{json .Manifest}}' 2>"$errors")" || return 1
  python3 -c 'import json, sys; print(json.loads(sys.argv[1])["digest"])' "$manifest"
}

echo "Reading the images published for $commit"
digests=()
unpublished=0
for application in "${APPLICATIONS[@]}"; do
  if digest="$(digest_of "$REGISTRY/foc-$application:sha-$commit")"; then
    digests+=("$digest")
  else
    echo "foc-$application:sha-$commit: $(cat "$errors")" >&2
    unpublished=1
  fi
done
if [[ $unpublished -ne 0 ]]; then
  echo "Nothing was tagged. CI publishes a commit's images once its run on main has passed: run this again after that." >&2
  exit 1
fi

# A release tag says which images were rehearsed, so it never moves. Only "not found" means it is
# free: if the registry gave any other answer, nobody knows what the tag would overwrite.
for i in "${!APPLICATIONS[@]}"; do
  target="$REGISTRY/foc-${APPLICATIONS[$i]}:$tag"
  if existing="$(digest_of "$target")"; then
    if [[ "$existing" != "${digests[$i]}" ]]; then
      echo "$target is already $existing, not ${digests[$i]}. A release tag never moves: use the next one." >&2
      exit 1
    fi
  elif ! grep -q 'not found' "$errors"; then
    echo "Could not tell what $target names: $(cat "$errors")" >&2
    exit 1
  fi
done

for i in "${!APPLICATIONS[@]}"; do
  image="$REGISTRY/foc-${APPLICATIONS[$i]}"
  echo "Tagging $image:$tag"
  # An exact copy: by default buildx wraps one image in a new index, which changes its digest.
  docker buildx imagetools create --prefer-index=false --tag "$image:$tag" "$image@${digests[$i]}"
done

# What the tag names now is what gets recorded, so check it is what CI scanned.
for i in "${!APPLICATIONS[@]}"; do
  image="$REGISTRY/foc-${APPLICATIONS[$i]}"
  if ! tagged="$(digest_of "$image:$tag")"; then
    echo "Could not read $image:$tag back: $(cat "$errors")" >&2
    exit 1
  fi
  if [[ "$tagged" != "${digests[$i]}" ]]; then
    echo "$image:$tag is $tagged, not the ${digests[$i]} CI scanned. No Release was made." >&2
    exit 1
  fi
done

{
  echo "The images of \`$tag\`, from commit \`$commit\`. CI built and scanned them when that commit reached \`main\`; this added only the tag."
  echo
  echo '| Image | Digest |'
  echo '| --- | --- |'
  for i in "${!APPLICATIONS[@]}"; do
    echo "| \`$REGISTRY/foc-${APPLICATIONS[$i]}:$tag\` | \`${digests[$i]}\` |"
  done
  cat <<EOF

To start exactly these, from a checkout of the tag:

\`\`\`bash
git checkout $tag
./scripts-init-env.sh
FOC_IMAGE_TAG=$tag docker compose -f compose.yaml -f compose.images.yaml pull
FOC_IMAGE_TAG=$tag docker compose -f compose.yaml -f compose.images.yaml up -d --no-build
\`\`\`

To roll a stack back to them, once the migrations since this commit have been reviewed:

\`\`\`bash
./scripts-rollback.sh sha-$commit --additive-migrations-reviewed
\`\`\`
EOF
} >"$notes"

title="$tag"
release=(release create "$tag" --verify-tag --notes-file "$notes")
if [[ "$tag" == rc* ]]; then
  number="${tag#rc}"
  title="Release candidate ${number%-d4}"
  release+=(--prerelease)
fi
gh "${release[@]}" --title "$title"
echo "$tag is commit $commit, on all six images."
