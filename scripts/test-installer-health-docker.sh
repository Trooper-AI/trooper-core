#!/usr/bin/env bash
# Prove installer /health on :3002 comes back after apt reinstalls python3.
# That is the bake failure: LXQt/noVNC apt replacing python3 kills the log server.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SETUP="$ROOT/setup-openclaw-full.sh"

if [ ! -f "$SETUP" ]; then
  echo "missing $SETUP" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 1
fi

bash -n "$SETUP"
grep -q '_ensure_installer_log_server' "$SETUP"
grep -q '_start_installer_log_server' "$SETUP"
grep -q 'TROOPER_INSTALLER_HEALTH_SELFTEST' "$SETUP"
if grep -n 'python3 python3-venv python3-pip' "$SETUP" | grep -v -- '--reinstall' >/dev/null; then
  echo "desktop apt still installs python3 (kills installer /health)" >&2
  grep -n 'python3 python3-venv python3-pip' "$SETUP" || true
  exit 1
fi

IMAGE="${INSTALLER_HEALTH_TEST_IMAGE:-ubuntu:24.04}"
echo "==> pulling $IMAGE"
docker pull "$IMAGE"

echo "==> running installer health selftest in $IMAGE"
docker run --rm \
  --name trooper-installer-health-selftest \
  -e DEBIAN_FRONTEND=noninteractive \
  -e GATEWAY_TOKEN=test-token \
  -e ORG_ID=snapshot-builder \
  -e BRIDGE_PORT=3002 \
  -e TROOPER_SNAPSHOT_BUILD=1 \
  -e TROOPER_INSTALLER_HEALTH_SELFTEST=1 \
  -e API_URL= \
  -v "$SETUP:/tmp/setup-openclaw-full.sh:ro" \
  "$IMAGE" \
  bash -lc '
    set -e
    apt-get update -qq
    apt-get install -y -qq python3 python3-venv python3-pip curl iproute2 ca-certificates procps >/dev/null
    bash /tmp/setup-openclaw-full.sh
  '
