#!/usr/bin/env bash
# Mirror a notarized Trooper.dmg to install / auto-update URLs.
# Intended for GitHub Actions (private-trooper working directory).
# After a successful notarized build this publishes:
#   macos-latest  → Trooper.dmg (install URL)
#   darwin-latest → latest.json + signed .app.tar.gz (Check for updates)
set -euo pipefail

if [ -z "${GH_TOKEN:-}" ]; then
  echo "::warning::PUBLIC_RELEASE_TOKEN missing; website/auto-update URLs stay on the last mirrored DMG."
  exit 0
fi

DMG="${1:?dmg path required}"
TROOPER_SHA="${TROOPER_SHA:-unknown}"
CHECKSUM="${DMG}.sha256"
SHORT_SHA="$(printf '%s' "$TROOPER_SHA" | cut -c1-12)"
VERSION="$(node -p "require('./package.json').version")"
NOTES="Trooper ${VERSION}. Latest signed and notarized Trooper macOS installer. Built from absurdfounder/Trooper@${TROOPER_SHA}."

if [ ! -f "$CHECKSUM" ]; then
  shasum -a 256 "$DMG" | sed "s#  .*#  Trooper.dmg#" > "$CHECKSUM"
fi

for repo in absurdfounder/Trooper absurdfounder/trooper_landing Trooper-AI/trooper-core; do
  gh release delete macos-latest --repo "$repo" --cleanup-tag --yes >/dev/null 2>&1 || true
  gh release create macos-latest "$DMG" "$CHECKSUM" \
    --repo "$repo" \
    --title "Trooper for macOS ${VERSION}" \
    --notes "$NOTES" \
    --latest
done

UPDATE_ARCHIVE="$(find src-tauri/target/universal-apple-darwin/release/bundle/macos -maxdepth 1 -name "*.app.tar.gz" | head -1 || true)"
if [ -z "${UPDATE_ARCHIVE:-}" ] || [ ! -f "${UPDATE_ARCHIVE}.sig" ]; then
  echo "::error::No Tauri updater archive. Check for updates will not move. Set TAURI_SIGNING_PRIVATE_KEY and do not disable createUpdaterArtifacts."
  exit 1
fi

mkdir -p release-update
cp "$UPDATE_ARCHIVE" release-update/Trooper-macOS-universal.app.tar.gz
cp "${UPDATE_ARCHIVE}.sig" release-update/Trooper-macOS-universal.app.tar.gz.sig
SIGNATURE="$(cat release-update/Trooper-macOS-universal.app.tar.gz.sig)"
URL="https://github.com/absurdfounder/trooper_landing/releases/download/darwin-latest/Trooper-macOS-universal.app.tar.gz"
PUB_DATE="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
python3 - "$VERSION" "$SHORT_SHA" "$PUB_DATE" "$SIGNATURE" "$URL" <<'PY'
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

for repo in absurdfounder/trooper_landing Trooper-AI/trooper-core; do
  gh release delete darwin-latest --repo "$repo" --cleanup-tag --yes >/dev/null 2>&1 || true
  gh release create darwin-latest release-update/* \
    --repo "$repo" \
    --title "Trooper macOS ${VERSION} auto-update feed" \
    --notes "Trooper ${VERSION}. Signed updater package for Trooper macOS built from absurdfounder/Trooper@${TROOPER_SHA}."
done

for alias in darwin-aarch64-latest darwin-x86_64-latest; do
  gh release delete "$alias" --repo absurdfounder/trooper_landing --cleanup-tag --yes >/dev/null 2>&1 || true
  gh release create "$alias" release-update/* \
    --repo absurdfounder/trooper_landing \
    --title "Trooper macOS auto-update feed ($alias)" \
    --notes "Alias of darwin-latest for Trooper ${VERSION}."
done

echo "Published Trooper ${VERSION} macOS installer and updater feed."
