#!/bin/bash
# Root entrypoint wrapper: fix ownership then drop to node user via startup.sh
# docker-compose sets user: "0:0" so this runs as root initially

# Fix ownership of mounted volumes (may have been created as root)
chown -R 1000:1000 /home/node/.openclaw 2>/dev/null || true
chown -R 1000:1000 /home/node/.npm 2>/dev/null || true

# Clear jiti cache — previous runs (or Xvnc startup as root) may have created
# cache files owned by root in /tmp/jiti, which the node user can't read/write.
# This causes ALL plugins to fail with EACCES on gateway restart.
rm -rf /tmp/jiti 2>/dev/null || true
mkdir -p /tmp/jiti && chown 1000:1000 /tmp/jiti

# Hand off to startup.sh (which drops to node for the gateway process)
exec /bin/bash /opt/startup.sh "$@"
