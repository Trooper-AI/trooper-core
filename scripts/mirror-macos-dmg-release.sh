#!/usr/bin/env bash
# Mirror a notarized Trooper.dmg and the signed updater package.
# The Mac app reads latest.json. A new DMG does not show an Update button
# until this feed version is higher than the version already installed.
#
# Publishes with the workflow token to Trooper-AI/trooper-core:
#   macos-latest  → Trooper.dmg
#   darwin-latest → latest.json + signed .app.tar.gz
# Mirrors the same assets to the landing repo when PUBLIC_RELEASE_TOKEN is set.
set -euo pipefail

if [ -z "${GH_TOKEN:-}" ]; then
  echo "::error::GH_TOKEN missing. The notarized workflow must pass github.token so the updater feed can publish."
  exit 1
fi

DMG="${1:?dmg path required}"
TROOPER_SHA="${TROOPER_SHA:-unknown}"
CHECKSUM="${DMG}.sha256"
SHORT_SHA="$(printf '%s' "$TROOPER_SHA" | cut -c1-12)"
VERSION="$(node -p "require('./package.json').version")"
NOTES="Trooper ${VERSION}. Latest signed and notarized Trooper macOS installer. Built from absurdfounder/Trooper@${TROOPER_SHA}."
CORE_REPO="Trooper-AI/trooper-core"
CORE_TOKEN="$GH_TOKEN"
PUBLIC_TOKEN="${PUBLIC_RELEASE_TOKEN:-}"
UPDATER_URL="https://github.com/${CORE_REPO}/releases/download/darwin-latest/Trooper-macOS-universal.app.tar.gz"

if [ ! -f "$CHECKSUM" ]; then
  shasum -a 256 "$DMG" | sed "s#  .*#  Trooper.dmg#" > "$CHECKSUM"
fi

publish_release() {
  local token="$1"
  local repo="$2"
  local tag="$3"
  shift 3
  GH_TOKEN="$token" gh release delete "$tag" --repo "$repo" --cleanup-tag --yes >/dev/null 2>&1 || true
  GH_TOKEN="$token" gh release create "$tag" "$@" \
    --repo "$repo" \
    --title "Trooper for macOS ${VERSION}" \
    --notes "$NOTES" \
    --latest
}

publish_release "$CORE_TOKEN" "$CORE_REPO" macos-latest "$DMG" "$CHECKSUM"

UPDATE_ARCHIVE="$(find src-tauri/target/universal-apple-darwin/release/bundle/macos -maxdepth 1 -name "*.app.tar.gz" | head -1 || true)"
if [ -z "${UPDATE_ARCHIVE:-}" ] || [ ! -f "${UPDATE_ARCHIVE}.sig" ]; then
  echo "::error::No Tauri updater archive. Check for updates will not move. Set TAURI_SIGNING_PRIVATE_KEY on Trooper-AI/trooper-core and do not disable createUpdaterArtifacts."
  exit 1
fi

mkdir -p release-update
cp "$UPDATE_ARCHIVE" release-update/Trooper-macOS-universal.app.tar.gz
cp "${UPDATE_ARCHIVE}.sig" release-update/Trooper-macOS-universal.app.tar.gz.sig
SIGNATURE="$(cat release-update/Trooper-macOS-universal.app.tar.gz.sig)"
PUB_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
python3 - "$VERSION" "$SHORT_SHA" "$PUB_DATE" "$SIGNATURE" "$UPDATER_URL" <<'PY'
import json
import sys

version, short_sha, pub_date, signature, url = sys.argv[1:6]
payload = {
    "version": version,
    "notes": f"Trooper {version}. Latest signed Trooper desktop update ({short_sha}).",
    "pub_date": pub_date,
    "platforms": {
        "darwin-aarch64": {"signature": signature, "url": url},
        "darwin-x86_64": {"signature": signature, "url": url},
    },
}
with open("release-update/latest.json", "w", encoding="utf-8") as fh:
    json.dump(payload, fh, indent=2)
    fh.write("\n")
PY

publish_updater() {
  local token="$1"
  local repo="$2"
  local tag="$3"
  local title="$4"
  GH_TOKEN="$token" gh release delete "$tag" --repo "$repo" --cleanup-tag --yes >/dev/null 2>&1 || true
  GH_TOKEN="$token" gh release create "$tag" release-update/* \
    --repo "$repo" \
    --title "$title" \
    --notes "Trooper ${VERSION}. Signed updater package for Trooper macOS built from absurdfounder/Trooper@${TROOPER_SHA}."
}

publish_updater "$CORE_TOKEN" "$CORE_REPO" darwin-latest "Trooper macOS ${VERSION} auto-update feed"
for alias in darwin-aarch64-latest darwin-x86_64-latest; do
  publish_updater "$CORE_TOKEN" "$CORE_REPO" "$alias" "Trooper macOS auto-update feed ($alias)"
done

if [ -z "$PUBLIC_TOKEN" ]; then
  echo "::warning::PUBLIC_RELEASE_TOKEN missing. Updater feed published to ${CORE_REPO} only."
  exit 0
fi

for repo in absurdfounder/Trooper absurdfounder/trooper_landing; do
  publish_release "$PUBLIC_TOKEN" "$repo" macos-latest "$DMG" "$CHECKSUM" || \
    echo "::warning::Could not mirror the DMG to ${repo}."
done

publish_updater "$PUBLIC_TOKEN" absurdfounder/trooper_landing darwin-latest "Trooper macOS ${VERSION} auto-update feed" || \
  echo "::warning::Could not mirror the updater feed to absurdfounder/trooper_landing."
