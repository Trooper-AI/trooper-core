#!/bin/bash
# Install the pinned ACPX plugin before the gateway starts. Do not run
# `plugins inspect --runtime` here: inspection loads ACPX's long-lived runtime
# and can leave the startup process waiting on plugin cleanup.

set -o pipefail

ACPX_PLUGIN_VERSION="2026.11.1"
ACPX_PLUGIN_SPEC="npm:@openclaw/acpx@$ACPX_PLUGIN_VERSION"
ACPX_STATE_DIR="${OPENCLAW_STATE_DIR:-${OPENCLAW_CONFIG_DIR:-/home/node/.openclaw}}"
CONFIG_STAGE_TOOL="/opt/openclaw-config-stage.mjs"

run_as_node() {
  if [ "$(id -u)" = "0" ]; then
    su -s /bin/bash node -c "$1"
  else
    bash -lc "$1"
  fi
}

acpx_package_version() {
  run_as_node "node '$CONFIG_STAGE_TOOL' plugin-version '$ACPX_STATE_DIR' '@openclaw/acpx'"
}

installed_version="$(acpx_package_version)" || {
  echo "[acpx-bootstrap] FATAL: could not inspect the installed ACPX package metadata" >&2
  exit 1
}

if [ "$installed_version" = "$ACPX_PLUGIN_VERSION" ]; then
  echo "[acpx-bootstrap] Pinned ACPX package is installed; continuing to gateway startup"
  exit 0
fi

if [ -n "$installed_version" ]; then
  echo "[acpx-bootstrap] FATAL: installed ACPX version does not match the gateway image pin; run OpenClaw Doctor to converge plugin versions" >&2
  exit 1
fi

echo "[acpx-bootstrap] Installing required @openclaw/acpx runtime plugin..."
if ! run_as_node "cd /app && node dist/index.js plugins install '$ACPX_PLUGIN_SPEC'"; then
  echo "[acpx-bootstrap] FATAL: could not install @openclaw/acpx; refusing to start an ACP-enabled gateway" >&2
  exit 1
fi

installed_version="$(acpx_package_version)" || installed_version=""
if [ "$installed_version" != "$ACPX_PLUGIN_VERSION" ]; then
  echo "[acpx-bootstrap] FATAL: @openclaw/acpx did not converge to the image-pinned version" >&2
  exit 1
fi

echo "[acpx-bootstrap] ACPX package is installed at the gateway-pinned version"
