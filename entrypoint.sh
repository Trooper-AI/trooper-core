#!/bin/bash
# Root entrypoint wrapper: fix ownership then drop to node user via startup.sh
# docker-compose sets user: "0:0" so this runs as root initially

# Fix ownership of mounted volumes (may have been created as root)
chown -R 1000:1000 /home/node/.openclaw 2>/dev/null || true
chown -R 1000:1000 /home/node/.npm 2>/dev/null || true

# OpenClaw's bundled plugins install/mirror runtime deps below /var/lib/openclaw
# during validation. If this path is root-owned after a reinstall, the gateway
# comes up with 0 plugins and bridge verification correctly reports degraded.
mkdir -p /var/lib/openclaw/plugin-runtime-deps 2>/dev/null || true
chown -R 1000:1000 /var/lib/openclaw 2>/dev/null || true
chmod -R u+rwX,go+rX /var/lib/openclaw 2>/dev/null || true

# CRITICAL: chown -R sets directories to 700 (only uid 1000 can enter).
# The bridge runs as the HOST's node user (uid may differ, e.g. 996).
# All config dirs MUST be 755 so both UIDs can access files.
find /home/node/.openclaw -type d -exec chmod 755 {} \; 2>/dev/null || true
# Config files readable by everyone (secrets protected by container isolation)
find /home/node/.openclaw -name '*.json' -exec chmod 664 {} \; 2>/dev/null || true
chmod 666 /home/node/.openclaw/openclaw.json /home/node/.openclaw/auth-profiles.json /home/node/.openclaw/agents/main/agent/auth-profiles.json 2>/dev/null || true

# Clear jiti cache — previous runs may have created files as root.
# Use chmod 1777 (world-writable + sticky) so both root and node can create/read files.
# chown alone doesn't work because the gateway bootstrap creates files as root
# before su takes effect (Xvnc + node startup race).
rm -rf /tmp/jiti 2>/dev/null || true
mkdir -p /tmp/jiti && chmod 1777 /tmp/jiti

# Devices dir must be writable by host bridge process (different UID)
chmod 777 /home/node/.openclaw/devices 2>/dev/null || true
chmod 666 /home/node/.openclaw/devices/*.json 2>/dev/null || true

# Identity dir: gateway creates device-auth.json as root during init — fix ownership
# so internal tool connections (cron, sessions_spawn) can read it as node user
chmod 755 /home/node/.openclaw/identity 2>/dev/null || true
chmod 644 /home/node/.openclaw/identity/*.json 2>/dev/null || true
chown -R 1000:1000 /home/node/.openclaw/identity 2>/dev/null || true

# Background: re-fix identity perms 30s after start (gateway may create files late)
(sleep 30 && chown -R 1000:1000 /home/node/.openclaw/identity 2>/dev/null && chmod 644 /home/node/.openclaw/identity/*.json 2>/dev/null) &

# Hand off to startup.sh (which drops to node for the gateway process)
exec /bin/bash /opt/startup.sh "$@"
