#!/bin/bash
# Migrate invalid persisted OpenClaw config before plugins or the gateway read it.
# Credentials and config backups remain private to the node-owned state volume.

STATE_ROOT="${OPENCLAW_STATE_DIR:-${OPENCLAW_CONFIG_DIR:-/home/node/.openclaw}}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$STATE_ROOT/openclaw.json}"
DOCTOR_LOG="$STATE_ROOT/trooper-doctor.log"

run_as_node() {
  if [ "$(id -u)" = "0" ]; then
    su -s /bin/bash node -c "$1"
  else
    bash -lc "$1"
  fi
}

if [ ! -f "$CONFIG_PATH" ]; then
  echo "[doctor-migrate] No persisted OpenClaw config yet; skipping migration"
  exit 0
fi

if run_as_node "node dist/index.js config validate" >/dev/null 2>&1; then
  echo "[doctor-migrate] Persisted OpenClaw config is valid"
  exit 0
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_DIR="$STATE_ROOT/.trooper-doctor-backups/$STAMP"
mkdir -p "$BACKUP_DIR" || exit 1
chmod 700 "$STATE_ROOT/.trooper-doctor-backups" "$BACKUP_DIR" 2>/dev/null || true
cp -p "$CONFIG_PATH" "$BACKUP_DIR/openclaw.json" || exit 1

if [ -f "$STATE_ROOT/auth-profiles.json" ]; then
  cp -p "$STATE_ROOT/auth-profiles.json" "$BACKUP_DIR/auth-profiles.json" || exit 1
fi
if [ -d "$STATE_ROOT/agents" ]; then
  find "$STATE_ROOT/agents" -type f -name auth-profiles.json -print0 \
    | while IFS= read -r -d '' profile_file; do
        relative_path="${profile_file#"$STATE_ROOT"/}"
        mkdir -p "$BACKUP_DIR/$(dirname "$relative_path")" || exit 1
        cp -p "$profile_file" "$BACKUP_DIR/$relative_path" || exit 1
      done || exit 1
fi
chown -R 1000:1000 "$STATE_ROOT/.trooper-doctor-backups" 2>/dev/null || true
find "$STATE_ROOT/.trooper-doctor-backups" -type d -exec chmod 700 {} \; 2>/dev/null || true
find "$STATE_ROOT/.trooper-doctor-backups" -type f -exec chmod 600 {} \; 2>/dev/null || true

touch "$DOCTOR_LOG" || exit 1
chown 1000:1000 "$DOCTOR_LOG" 2>/dev/null || true
chmod 600 "$DOCTOR_LOG" 2>/dev/null || true
echo "[doctor-migrate] Invalid persisted config detected; applying OpenClaw's non-interactive repairs"
if ! run_as_node "node dist/index.js doctor --fix --non-interactive" >"$DOCTOR_LOG" 2>&1; then
  echo "[doctor-migrate] OpenClaw doctor failed; private diagnostics are in the state volume" >&2
  exit 1
fi

if ! run_as_node "node dist/index.js config validate" >>"$DOCTOR_LOG" 2>&1; then
  echo "[doctor-migrate] Config remains invalid after repair; private diagnostics are in the state volume" >&2
  exit 1
fi

echo "[doctor-migrate] Config migration and validation succeeded"
