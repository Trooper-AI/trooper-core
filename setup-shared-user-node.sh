#!/bin/bash
set -euo pipefail

# Shared-user node bootstrap.
# This intentionally does not modify setup-openclaw-full.sh; dedicated org VPS
# provisioning continues to use that script unchanged.

MANAGER_PORT="${SHARED_NODE_MANAGER_PORT:-3100}"
WORKSPACES_ROOT="${TROOPER_SHARED_WORKSPACES_ROOT:-/opt/trooper-workspaces}"
STATE_DIR="${TROOPER_SHARED_STATE_DIR:-/opt/trooper-workspaces/state}"
BRIDGE_DIR="${TROOPER_BRIDGE_DIR:-/opt/openclaw-bridge}"
ENV_FILE="${TROOPER_SHARED_NODE_ENV_FILE:-/etc/trooper-shared-node.env}"

mkdir -p "${WORKSPACES_ROOT}" "${STATE_DIR}"
chmod 750 "${WORKSPACES_ROOT}" "${STATE_DIR}" 2>/dev/null || true

if ! id -u node >/dev/null 2>&1; then
  useradd -r -m -s /bin/bash node 2>/dev/null || true
fi

if getent group docker >/dev/null 2>&1; then
  usermod -aG docker node 2>/dev/null || true
fi

chown -R node:node "${WORKSPACES_ROOT}" "${STATE_DIR}" 2>/dev/null || true

if [ ! -f "${ENV_FILE}" ]; then
  cat > "${ENV_FILE}" << ENV
# Optional shared-node manager settings. Keep this file private.
# SHARED_NODE_MANAGER_AUTH_TOKEN=
# TROOPER_SHARED_NODE_PUBLIC_URL=
# RUNTIME_AUTH_SECRET=
# MISSION_CONTROL_URL=
# OPENCLAW_DOCKER_IMAGE=ghcr.io/trooper-ai/trooper-gateway:latest
ENV
fi
chmod 600 "${ENV_FILE}" 2>/dev/null || true

cat > /etc/systemd/system/trooper-shared-node-manager.service << SERVICE
[Unit]
Description=Trooper shared user runtime node manager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=node
WorkingDirectory=${BRIDGE_DIR}
Environment=SHARED_NODE_MANAGER_PORT=${MANAGER_PORT}
Environment=TROOPER_SHARED_WORKSPACES_ROOT=${WORKSPACES_ROOT}
Environment=TROOPER_SHARED_STATE_DIR=${STATE_DIR}
Environment=NODE_ENV=production
EnvironmentFile=-${ENV_FILE}
ExecStart=/usr/bin/node ${BRIDGE_DIR}/shared-node-manager.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable trooper-shared-node-manager
systemctl restart trooper-shared-node-manager

echo "Trooper shared node manager started on port ${MANAGER_PORT}"
