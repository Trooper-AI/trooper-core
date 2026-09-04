#!/usr/bin/env bash
# Publish latest.json after a successful mobile (iOS / Android) build.
# Usage: publish-app-version-feed.sh <ios-latest|android-latest> <version>
# Env: GH_TOKEN required.
set -euo pipefail

TAG="${1:?tag required, for example ios-latest}"
VERSION="${2:?semver required}"

if [ -z "${GH_TOKEN:-}" ]; then
  echo "::warning::GH_TOKEN missing; skip ${TAG} version feed."
  exit 0
fi

STORE_URL="${STORE_URL:-}"
if [ -z "$STORE_URL" ]; then
  if [[ "$TAG" == android* ]]; then
    STORE_URL="https://play.google.com/store/apps/details?id=com.trooper.app"
  else
    STORE_URL="https://apps.apple.com/app/trooper"
  fi
fi

NOTES="${NOTES:-Trooper ${VERSION}. Published after a successful ${TAG} build.}"
TITLE="${TITLE:-Trooper ${TAG} ${VERSION}}"
PUB_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
REPOS="${REPOS:-Trooper-AI/trooper-core absurdfounder/trooper_landing}"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

python3 - "$VERSION" "$NOTES" "$PUB_DATE" "$TAG" "$STORE_URL" "$WORKDIR/latest.json" <<'PY'
import json, sys
version, notes, pub_date, tag, store_url, out = sys.argv[1:7]
platform = "android" if tag.startswith("android") else "ios"
payload = {
    "version": version,
    "notes": notes,
    "pub_date": pub_date,
    "platforms": {platform: {"url": store_url}},
}
with open(out, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2)
    fh.write("\n")
PY

for repo in $REPOS; do
  gh release delete "$TAG" --repo "$repo" --cleanup-tag --yes >/dev/null 2>&1 || true
  gh release create "$TAG" "$WORKDIR/latest.json" \
    --repo "$repo" \
    --title "$TITLE" \
    --notes "$NOTES"
done

echo "Published ${TAG} version feed ${VERSION}."
