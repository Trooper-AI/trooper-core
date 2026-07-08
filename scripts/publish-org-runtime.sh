#!/usr/bin/env bash
set -euo pipefail

cmd="${1:-}"
src="${2:-}"
out="${3:-}"

if [[ "$cmd" != "build" || -z "$src" || -z "$out" ]]; then
  echo "usage: $0 build <Trooper-server-dir> <out-tarball>" >&2
  exit 1
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

mkdir -p "$stage/trooper-org-runtime/server"

rsync -a --delete \
  --exclude 'node_modules' \
  --exclude '.env' \
  --exclude 'server.log' \
  --exclude '*.test.js' \
  --exclude 'test-data' \
  "$src/" "$stage/trooper-org-runtime/server/"

test -f "$stage/trooper-org-runtime/server/package.json"
test -f "$stage/trooper-org-runtime/server/package-lock.json"
test -f "$stage/trooper-org-runtime/server/org-runtime/index.js"
test -f "$stage/trooper-org-runtime/server/org-runtime/runtime-manifest.json"

if [ "${TROOPER_RUNTIME_BUNDLE_INCLUDE_NODE_MODULES:-1}" = "1" ]; then
  echo "installing production dependencies into runtime bundle"
  (
    cd "$stage/trooper-org-runtime/server"
    npm ci --omit=dev --no-audit --no-fund
    node - <<'NODE'
const fs = require('fs');
const required = [
  'express',
  'firebase-admin',
  '@google-cloud/firestore',
];
for (const name of required) {
  try {
    require.resolve(name);
  } catch {
    throw new Error(`Bundled runtime dependency is missing: ${name}`);
  }
}
fs.writeFileSync('.trooper-runtime-node-modules-bundled', '1\n');
NODE
  )
fi

rm -f "$out"
if tar --version 2>/dev/null | grep -q 'GNU tar'; then
  (cd "$stage" && tar \
    --sort=name \
    --mtime='@0' \
    --owner=0 \
    --group=0 \
    --numeric-owner \
    --format=gnu \
    -cf - trooper-org-runtime) | gzip -n > "$out"
else
  find "$stage/trooper-org-runtime" -exec touch -h -t 197001010000.00 {} +
  (cd "$stage" && COPYFILE_DISABLE=1 tar \
    --uid 0 \
    --gid 0 \
    --uname root \
    --gname root \
    -cf - trooper-org-runtime) | gzip -n > "$out"
fi

echo "built runtime bundle: $out"
tar -tzf "$out" | sed -n '1,40p'
