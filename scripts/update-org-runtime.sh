#!/usr/bin/env bash
set -euo pipefail

# Update the CrabsHQ org runtime on a VPS to the latest release.
# Downloads the latest bundle from the Crabs-HQ GitHub release,
# extracts it, installs dependencies, and restarts services.
#
# Usage: sudo ./scripts/update-org-runtime.sh

RELEASE_URL="${CRABHQ_RUNTIME_TARBALL_URL:-https://github.com/absurdfounder/Crabs-HQ/releases/download/org-runtime-latest/crabhq-org-runtime.tar.gz}"
INSTALL_DIR="/opt/crabhq-org-runtime"
TMP_TARBALL="/tmp/crabhq-org-runtime-update.tar.gz"

echo "[update-org-runtime] Downloading latest runtime bundle..."
curl -fsSL "$RELEASE_URL" -o "$TMP_TARBALL" || {
  echo "ERROR: failed to download runtime bundle from $RELEASE_URL" >&2
  exit 1
}

echo "[update-org-runtime] Extracting to $INSTALL_DIR..."
tar -xzf "$TMP_TARBALL" -C "$INSTALL_DIR" --strip-components=1 || {
  echo "ERROR: failed to extract runtime bundle" >&2
  exit 1
}
rm -f "$TMP_TARBALL"

echo "[update-org-runtime] Installing dependencies..."
cd "$INSTALL_DIR/server"
npm install --omit=dev 2>&1 | tail -5

echo "[update-org-runtime] Restarting services..."
systemctl restart crabhq-server 2>/dev/null && echo "  restarted crabhq-server" || echo "  crabhq-server not found (skipped)"
systemctl restart crabhq-org-runtime 2>/dev/null && echo "  restarted crabhq-org-runtime" || echo "  crabhq-org-runtime not found (skipped)"

echo "[update-org-runtime] Done. Runtime updated to latest."
