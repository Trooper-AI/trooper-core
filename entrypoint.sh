#!/bin/bash
# Root entrypoint wrapper: fix ownership then drop to node user via startup.sh
# docker-compose sets user: "0:0" so this runs as root initially

# Fix ownership of mounted volumes (may have been created as root)
chown -R 1000:1000 /home/node/.openclaw 2>/dev/null || true
chown -R 1000:1000 /home/node/.npm 2>/dev/null || true

# The gateway owns its state as uid 1000. The host bridge runs as root, so it
# can still maintain these files without exposing credentials to other users.
find /home/node/.openclaw -type d -exec chmod 700 {} \; 2>/dev/null || true
find /home/node/.openclaw -name '*.json' -exec chmod 600 {} \; 2>/dev/null || true

# Clear jiti cache — previous runs may have created files as root.
# Use chmod 1777 (world-writable + sticky) so both root and node can create/read files.
# chown alone doesn't work because the gateway bootstrap creates files as root
# before su takes effect (Xvnc + node startup race).
rm -rf /tmp/jiti 2>/dev/null || true
mkdir -p /tmp/jiti && chmod 1777 /tmp/jiti

# Device state contains operator credentials and must remain private.
chmod 700 /home/node/.openclaw/devices 2>/dev/null || true
chmod 600 /home/node/.openclaw/devices/*.json 2>/dev/null || true

# ── Persistent ACP CLI credential homes ──────────────────────────────────
# Vendor CLI logins (claude auth login, kimi login, copilot login, opencode
# auth login) write credentials under $HOME, but only /home/node/.openclaw is
# a mounted volume. Link each CLI state dir into the mounted ACP tree so a
# login survives container recreation AND so the login-time credential lands
# exactly where the acpx-spawned harness process reads it. Codex already has
# its own persistent CODEX_HOME under this tree.
link_persistent_cli_home() {
  target="$1"; link="$2"
  mkdir -p "$target" 2>/dev/null || return 0
  if [ -L "$link" ]; then
    [ "$(readlink "$link")" = "$target" ] || ln -sfn "$target" "$link" 2>/dev/null || true
    return 0
  fi
  if [ -e "$link" ]; then
    # One-time migration of an existing image-local credential dir; the
    # persisted copy wins on conflicts.
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
find "$ACPX_PERSIST_ROOT" -maxdepth 1 -type d -exec chmod 700 {} \; 2>/dev/null || true

# Identity dir: gateway creates device-auth.json as root during init — fix ownership
# so internal tool connections (cron, sessions_spawn) can read it as node user
chmod 700 /home/node/.openclaw/identity 2>/dev/null || true
chmod 600 /home/node/.openclaw/identity/*.json 2>/dev/null || true
chown -R 1000:1000 /home/node/.openclaw/identity 2>/dev/null || true

# The OpenClaw ACP backend is an external plugin, not a bundled executable.
# Install and verify it before startup so an ACP-enabled configuration cannot
# leave the gateway perpetually "installing" with a missing-plugin warning.
if ! /opt/acpx-bootstrap.sh; then
  echo "[entrypoint] FATAL: ACPX bootstrap failed; gateway will not start" >&2
  exit 1
fi
export TROOPER_ACPX_BOOTSTRAPPED=1

# Background: re-fix identity perms 30s after start (gateway may create files late)
(sleep 30 && chown -R 1000:1000 /home/node/.openclaw/identity 2>/dev/null && chmod 700 /home/node/.openclaw/identity 2>/dev/null && chmod 600 /home/node/.openclaw/identity/*.json 2>/dev/null) &

# Hand off to startup.sh (which drops to node for the gateway process)
exec /bin/bash /opt/startup.sh "$@"
