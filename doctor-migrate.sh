#!/bin/bash
# Repair persisted OpenClaw config before installing managed plugins or
# starting the gateway. Plugin package installation and state migration are
# separate passes so Doctor never migrates a plugin while rewriting its
# source config.

set -o pipefail

STATE_ROOT="${OPENCLAW_STATE_DIR:-${OPENCLAW_CONFIG_DIR:-/home/node/.openclaw}}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$STATE_ROOT/openclaw.json}"
DOCTOR_LOG="$STATE_ROOT/trooper-doctor.log"
CONFIG_STAGE_TOOL="/opt/openclaw-config-stage.mjs"
ACPX_VERSION="2026.11.1"
LOBSTER_VERSION="2026.11.1"
NEEDS_DOCTOR=0

run_as_node() {
  if [ "$(id -u)" = "0" ]; then
    su -s /bin/bash node -c "$1"
  else
    bash -lc "$1"
  fi
}

run_doctor() {
  run_as_node "cd /app && OPENCLAW_NO_RESPAWN=1 node dist/index.js doctor --fix --non-interactive" >>"$DOCTOR_LOG" 2>&1
}

config_is_valid() {
  run_as_node "cd /app && node dist/index.js config validate" >/dev/null 2>&1
}

if [ ! -f "$CONFIG_PATH" ]; then
  echo "[doctor-migrate] No persisted OpenClaw config yet; skipping config repair"
  exit 0
fi

if ! config_is_valid; then
  NEEDS_DOCTOR=1
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
  : >"$DOCTOR_LOG"

  PARKED_CONFIG="$BACKUP_DIR/managed-plugin-config.json"
  if ! run_as_node "node '$CONFIG_STAGE_TOOL' park '$CONFIG_PATH' '$PARKED_CONFIG'"; then
    echo "[doctor-migrate] Could not safely stage managed ACP/plugin config" >&2
    exit 1
  fi

  echo "[doctor-migrate] Repairing legacy config before restoring managed plugin settings"
  if ! run_doctor; then
    run_as_node "node '$CONFIG_STAGE_TOOL' restore '$CONFIG_PATH' '$PARKED_CONFIG'" >/dev/null 2>&1 || true
    echo "[doctor-migrate] OpenClaw config repair failed; private diagnostics are in the state volume" >&2
    exit 1
  fi
  if ! run_as_node "node '$CONFIG_STAGE_TOOL' restore '$CONFIG_PATH' '$PARKED_CONFIG'"; then
    echo "[doctor-migrate] Could not restore managed ACP/plugin config after repair" >&2
    exit 1
  fi
fi

# Doctor may have made the config valid but discovered missing external
# plugins. Install them against the now-valid config, then run Doctor once
# more so plugin state migrations see a converged package and config.
ensure_managed_plugin() {
  plugin_id="$1"
  package_name="$2"
  package_spec="$3"
  expected_version="$4"

  if ! run_as_node "node '$CONFIG_STAGE_TOOL' plugin-enabled '$CONFIG_PATH' '$plugin_id'"; then
    return 0
  fi

  actual_version="$(run_as_node "node '$CONFIG_STAGE_TOOL' plugin-version '$STATE_ROOT' '$package_name'")" || return 1
  if [ -z "$actual_version" ]; then
    echo "[doctor-migrate] Installing missing managed plugin '$plugin_id'"
    if ! run_as_node "cd /app && node dist/index.js plugins install '$package_spec'" >>"$DOCTOR_LOG" 2>&1; then
      echo "[doctor-migrate] Could not install managed plugin '$plugin_id'; private diagnostics are in the state volume" >&2
      return 1
    fi
    NEEDS_DOCTOR=1
  elif [ "$actual_version" != "$expected_version" ]; then
    echo "[doctor-migrate] Managed plugin '$plugin_id' version drift detected; asking Doctor to converge it"
    NEEDS_DOCTOR=1
  fi
}

touch "$DOCTOR_LOG" || exit 1
chown 1000:1000 "$DOCTOR_LOG" 2>/dev/null || true
chmod 600 "$DOCTOR_LOG" 2>/dev/null || true

if ! ensure_managed_plugin acpx @openclaw/acpx "npm:@openclaw/acpx@$ACPX_VERSION" "$ACPX_VERSION"; then
  exit 1
fi
if ! ensure_managed_plugin lobster @openclaw/lobster "npm:@openclaw/lobster@$LOBSTER_VERSION" "$LOBSTER_VERSION"; then
  exit 1
fi

if [ "$NEEDS_DOCTOR" = "1" ]; then
  echo "[doctor-migrate] Completing config and plugin migrations"
  if ! run_doctor; then
    echo "[doctor-migrate] OpenClaw migration failed; private diagnostics are in the state volume" >&2
    exit 1
  fi
fi

if ! config_is_valid; then
  echo "[doctor-migrate] Config remains invalid after repair; private diagnostics are in the state volume" >&2
  exit 1
fi

if ! run_as_node "node '$CONFIG_STAGE_TOOL' assert-plugin-version '$CONFIG_PATH' acpx '$ACPX_VERSION' '$STATE_ROOT'" \
  || ! run_as_node "node '$CONFIG_STAGE_TOOL' assert-plugin-version '$CONFIG_PATH' lobster '$LOBSTER_VERSION' '$STATE_ROOT'"; then
  echo "[doctor-migrate] Managed plugin versions did not converge; see private diagnostics in the state volume" >&2
  exit 1
fi

echo "[doctor-migrate] Persisted config and managed plugin migrations are ready"
