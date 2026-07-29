#!/bin/bash
# The ACP backend is provided by OpenClaw's external @openclaw/acpx plugin.
# It must be installed before the gateway reads a config that enables
# plugins.entries.acpx, otherwise OpenClaw remains in its "installing" state.

set -o pipefail

# Managed OpenClaw npm plugins live under the state/config root. The official
# image runs the gateway as uid 1000 (`node`), so this script deliberately
# leaves that tree node-owned instead of trying to make the plugin root-owned.
ACPX_STATE_DIR="${OPENCLAW_STATE_DIR:-${OPENCLAW_CONFIG_DIR:-/home/node/.openclaw}}"

run_as_node() {
  if [ "$(id -u)" = "0" ]; then
    su -s /bin/bash node -c "$1"
  else
    bash -lc "$1"
  fi
}

acpx_package_present() {
  # npm installs the official package inside a managed per-plugin project.
  # Do not use the persisted install record alone: a prior failed upgrade can
  # leave that record behind after its package payload has disappeared.
  find "$ACPX_STATE_DIR/npm/projects" -type f \
    -path '*/node_modules/@openclaw/acpx/package.json' \
    -print -quit 2>/dev/null | grep -q .
}

inspect_acpx_runtime() {
  # `plugins inspect` itself reports a JSON error record with exit code zero in
  # some failure cases, so require the runtime-loaded plugin status explicitly.
  local inspect_json
  inspect_json="$(run_as_node "cd /app && node dist/index.js plugins inspect acpx --runtime --json" 2>/dev/null)" || return 1
  printf '%s' "$inspect_json" | node -e '
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const report = JSON.parse(input);
        const plugin = report?.plugin;
        process.exit(plugin?.id === "acpx" && plugin?.status === "loaded" ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  '
}

if inspect_acpx_runtime; then
  echo "[acpx-bootstrap] @openclaw/acpx is already installed and runtime-ready"
  exit 0
fi

# `openclaw plugins install` is intentionally not an update command. Calling
# it over an existing payload is non-idempotent, so only use it for the actual
# missing-package case and surface a broken installed payload clearly.
if acpx_package_present; then
  echo "[acpx-bootstrap] FATAL: @openclaw/acpx exists but failed runtime inspection; run 'openclaw plugins inspect acpx --runtime --json' as node to diagnose it" >&2
  exit 1
fi

echo "[acpx-bootstrap] Installing required @openclaw/acpx runtime plugin..."
if ! run_as_node "cd /app && node dist/index.js plugins install @openclaw/acpx"; then
  echo "[acpx-bootstrap] FATAL: could not install @openclaw/acpx; refusing to start an ACP-enabled gateway" >&2
  exit 1
fi

if ! acpx_package_present; then
  echo "[acpx-bootstrap] FATAL: @openclaw/acpx did not create its managed npm package payload" >&2
  exit 1
fi

if ! inspect_acpx_runtime; then
  echo "[acpx-bootstrap] FATAL: @openclaw/acpx failed runtime inspection after installation" >&2
  exit 1
fi

echo "[acpx-bootstrap] ACPX runtime plugin is ready"
