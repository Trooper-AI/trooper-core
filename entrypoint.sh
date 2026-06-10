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

# Identity dir: gateway creates device-auth.json as root during init — fix ownership
# so internal tool connections (cron, sessions_spawn) can read it as node user
chmod 700 /home/node/.openclaw/identity 2>/dev/null || true
chmod 600 /home/node/.openclaw/identity/*.json 2>/dev/null || true
chown -R 1000:1000 /home/node/.openclaw/identity 2>/dev/null || true

# Background: re-fix identity perms 30s after start (gateway may create files late)
(sleep 30 && chown -R 1000:1000 /home/node/.openclaw/identity 2>/dev/null && chmod 700 /home/node/.openclaw/identity 2>/dev/null && chmod 600 /home/node/.openclaw/identity/*.json 2>/dev/null) &

# Hand off to startup.sh (which drops to node for the gateway process)
exec /bin/bash /opt/startup.sh "$@"
