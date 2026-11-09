#!/bin/bash
# Simplified startup — Chrome + TigerVNC are pre-installed in the image
GATEWAY_PORT="${1:-18789}"
GATEWAY_PORT="$(printf '%s' "$GATEWAY_PORT" | tr -cd '0-9')"
if [ -z "$GATEWAY_PORT" ] || [ "$GATEWAY_PORT" -lt 1 ] || [ "$GATEWAY_PORT" -gt 65535 ]; then
  echo "[startup] Invalid gateway port '${1:-}', falling back to 18789"
  GATEWAY_PORT=18789
fi

# Start Xvnc on :99 for live browser view
if command -v Xvnc &>/dev/null; then
  if ! pgrep -f "Xvnc :99" >/dev/null 2>&1 && [ -f /tmp/.X99-lock ]; then
    echo "[startup] Removing stale /tmp/.X99-lock"
    rm -f /tmp/.X99-lock || true
  fi
  if ! pgrep -f "Xvnc :99" >/dev/null 2>&1; then
    echo "[startup] Starting Xvnc on :99 (port 5999)..."
    Xvnc :99 -geometry 1920x1080 -depth 24 -rfbport 5999 -localhost \
      -SecurityTypes None -AlwaysShared -AcceptKeyEvents -AcceptPointerEvents >/tmp/xvnc.log 2>&1 &
    sleep 1
  fi
  if DISPLAY=:99 xdpyinfo >/dev/null 2>&1; then
    echo "[startup] Xvnc ready on :99"
  else
    echo "[startup] WARNING: Xvnc failed to become ready on :99"
  fi
fi

# Belt-and-suspenders: keep runtime permissions aligned with entrypoint.sh.
# IMPORTANT (local Mac / Colima + amd64 image): full-tree `chown -R` / `find -exec chmod`
# over ~/.openclaw can take many minutes (thousands of agent workspace files) and blocks
# the gateway from binding :18789, which makes Trooper loop on "OpenClaw is restarting".
# Only fix the security-sensitive roots here; avoid recursive walks at boot.
echo "[startup] Applying fast permission pass (sensitive dirs only)..."
for d in \
  /home/node/.openclaw \
  /home/node/.openclaw/devices \
  /home/node/.openclaw/identity \
  /home/node/.openclaw/config \
  /home/node/.openclaw/agents \
  /home/node/.openclaw/credentials \
  /home/node/.openclaw/auth-profile-secrets
do
  chown 1000:1000 "$d" 2>/dev/null || true
  chmod 700 "$d" 2>/dev/null || true
done
chmod 600 /home/node/.openclaw/devices/*.json 2>/dev/null || true
chmod 600 /home/node/.openclaw/identity/*.json 2>/dev/null || true
chmod 600 /home/node/.openclaw/*.json 2>/dev/null || true
chown 1000:1000 /home/node/.npm 2>/dev/null || true
echo "[startup] Permission pass complete"

# Persistent ACP CLI credential homes (see entrypoint.sh). Local-Mac launches
# bypass the image entrypoint, so repeat the idempotent link pass here; a
# non-root run simply skips chown.
link_persistent_cli_home() {
  target="$1"; link="$2"
  mkdir -p "$target" 2>/dev/null || return 0
  if [ -L "$link" ]; then
    [ "$(readlink "$link")" = "$target" ] || ln -sfn "$target" "$link" 2>/dev/null || true
    return 0
  fi
  if [ -e "$link" ]; then
    cp -an "$link"/. "$target"/ 2>/dev/null || true
    rm -rf "$link" 2>/dev/null || true
  fi
  mkdir -p "$(dirname "$link")" 2>/dev/null || true
  ln -sfn "$target" "$link" 2>/dev/null || true
}
ACPX_PERSIST_ROOT=/home/node/.openclaw/acpx
link_persistent_cli_home "$ACPX_PERSIST_ROOT/claude-home"   /home/node/.claude
link_persistent_cli_home "$ACPX_PERSIST_ROOT/kimi-home"     /home/node/.kimi-code
link_persistent_cli_home "$ACPX_PERSIST_ROOT/copilot-home"  /home/node/.copilot
link_persistent_cli_home "$ACPX_PERSIST_ROOT/data/opencode" /home/node/.local/share/opencode
chown -R 1000:1000 "$ACPX_PERSIST_ROOT" /home/node/.local 2>/dev/null || true
chown -h 1000:1000 /home/node/.claude /home/node/.kimi-code /home/node/.copilot /home/node/.local/share/opencode 2>/dev/null || true

# Startup optimizations (recommended by openclaw doctor)
export NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache
export JITI_CACHE_DIR=/var/tmp/jiti
export OPENCLAW_TMPDIR=/home/node/.cache/openclaw/tmp
export OPENCLAW_NATIVE_HOOK_RELAY_DIR=/home/node/.cache/openclaw/native-hook-relays
export TMPDIR="$OPENCLAW_TMPDIR"
export TMP="$OPENCLAW_TMPDIR"
export TEMP="$OPENCLAW_TMPDIR"
mkdir -p /var/tmp/openclaw-compile-cache /var/tmp/jiti "$OPENCLAW_TMPDIR" "$OPENCLAW_NATIVE_HOOK_RELAY_DIR" 2>/dev/null || true
chown -R 1000:1000 /var/tmp/openclaw-compile-cache /var/tmp/jiti /home/node/.cache/openclaw 2>/dev/null || true
chmod 755 /var/tmp/openclaw-compile-cache /var/tmp/jiti "$OPENCLAW_TMPDIR" "$OPENCLAW_NATIVE_HOOK_RELAY_DIR" 2>/dev/null || true
export OPENCLAW_NO_RESPAWN=1

run_as_node() {
  if [ "$(id -u)" = "0" ]; then
    su -s /bin/bash node -c "$1"
  else
    bash -lc "$1"
  fi
}

# OpenClaw validates persisted configuration during plugin install. Migrate
# old config schemas first, or ACPX bootstrap will refuse to run and the
# gateway will enter a restart loop before the previous post-start repair can
# execute. This helper also validates the repaired config and fails closed.
if ! /opt/doctor-migrate.sh; then
  echo "[startup] FATAL: persisted OpenClaw config migration failed; gateway will not start" >&2
  exit 1
fi

# Local launches and the production image share the same ordered bootstrap:
# config migration first, then ACPX installation/verification, then gateway.
if [ "${TROOPER_ACPX_BOOTSTRAPPED:-0}" != "1" ]; then
  if ! /opt/acpx-bootstrap.sh; then
    echo "[startup] FATAL: ACPX bootstrap failed; gateway will not start" >&2
    exit 1
  fi
fi

# Start gateway as node user
if [ "$(id -u)" = "0" ]; then
  exec su -s /bin/bash node -c "DISPLAY=:99 NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache JITI_CACHE_DIR=/var/tmp/jiti TMPDIR=/home/node/.cache/openclaw/tmp TMP=/home/node/.cache/openclaw/tmp TEMP=/home/node/.cache/openclaw/tmp OPENCLAW_TMPDIR=/home/node/.cache/openclaw/tmp OPENCLAW_NATIVE_HOOK_RELAY_DIR=/home/node/.cache/openclaw/native-hook-relays OPENCLAW_NO_RESPAWN=1 node dist/index.js gateway --allow-unconfigured --bind lan --port '$GATEWAY_PORT'"
else
  exec bash -lc "DISPLAY=:99 NODE_COMPILE_CACHE=/var/tmp/openclaw-compile-cache JITI_CACHE_DIR=/var/tmp/jiti TMPDIR=/home/node/.cache/openclaw/tmp TMP=/home/node/.cache/openclaw/tmp TEMP=/home/node/.cache/openclaw/tmp OPENCLAW_TMPDIR=/home/node/.cache/openclaw/tmp OPENCLAW_NATIVE_HOOK_RELAY_DIR=/home/node/.cache/openclaw/native-hook-relays OPENCLAW_NO_RESPAWN=1 node dist/index.js gateway --allow-unconfigured --bind lan --port '$GATEWAY_PORT'"
fi
