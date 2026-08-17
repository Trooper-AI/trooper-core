#!/usr/bin/env bash
set -u

SCOPE="${1:-bridge}"
OPERATION_ID="${2:-unknown}"
BRIDGE_DIR="${TROOPER_BRIDGE_DIR:-/opt/openclaw-bridge}"
JOURNAL="$BRIDGE_DIR/scripts/update-upgrade-journal.mjs"
# 45 * 2s = 90s used to pass on a quiet VPS. After an upgrade the bridge unit
# often needs ~90s just to SIGKILL, then another minute before :3002 listens
# (plugin install). Blocking on `systemctl restart` ate the whole health window.
ATTEMPTS="${TROOPER_UPGRADE_HEALTH_ATTEMPTS:-150}"
SLEEP_SECONDS="${TROOPER_UPGRADE_HEALTH_INTERVAL_SECONDS:-2}"

mark() {
  node "$JOURNAL" "$1" "${2:-$1}" "${3:-}" >/dev/null 2>&1 || true
}

required_health_endpoints() {
  printf '%s\n' \
    'bridge|http://127.0.0.1:3002/healthz' \
    'gateway|http://127.0.0.1:18789/health'

  # A bridge-only deployment must not be rolled back because an unrelated
  # Trooper application service is degraded. Full upgrades still verify the
  # complete managed runtime before promotion is accepted.
  if [[ "$SCOPE" != "bridge" ]]; then
    printf '%s\n' \
      'org-runtime|http://127.0.0.1:3101/health' \
      'trooper-server|http://127.0.0.1:3001/health'
  fi
}

healthy() {
  local name url
  while IFS='|' read -r name url; do
    curl -fsS --max-time 3 "$url" >/dev/null 2>&1 || return 1
  done < <(required_health_endpoints)
}

failed_health_endpoints() {
  local name url
  local failed=()
  while IFS='|' read -r name url; do
    curl -fsS --max-time 3 "$url" >/dev/null 2>&1 || failed+=("$name")
  done < <(required_health_endpoints)
  local IFS=,
  printf '%s' "${failed[*]}"
}

restart_managed_services() {
  # A previous crash burst may have tripped systemd's start limiter. An
  # operator-requested, bounded upgrade verification is an explicit retry and
  # should get one clean start window.
  systemctl reset-failed trooper-org-runtime trooper-server openclaw-bridge trooper-shared-node-manager >/dev/null 2>&1 || true
  # --no-block: do not wait for TimeoutStopSec (~90s SIGKILL) before health
  # polling. The poll loop is the wait.
  systemctl restart --no-block trooper-org-runtime trooper-server openclaw-bridge trooper-shared-node-manager
}

wait_until_healthy() {
  local attempt
  for ((attempt=1; attempt<=ATTEMPTS; attempt++)); do
    if healthy; then
      return 0
    fi
    sleep "$SLEEP_SECONDS"
  done
  return 1
}

mark restarting service_restart
if ! restart_managed_services; then
  mark rolling_back restart_failed "systemd could not restart the managed services"
else
  mark verifying health_checks
  if wait_until_healthy; then
    rm -rf /opt/openclaw-bridge.previous /opt/trooper-org-runtime.previous
    mark completed verified
    logger -t trooper-upgrade "Upgrade $OPERATION_ID completed and verified"
    exit 0
  fi
  failed_endpoints="$(failed_health_endpoints)"
  mark rolling_back health_timeout "${SCOPE} health checks failed after upgrade: ${failed_endpoints:-unknown}"
fi

failed_endpoints="${failed_endpoints:-unknown}"
rollback_error=""
if [[ -x "$BRIDGE_DIR/scripts/update-bridge.sh" ]]; then
  bash "$BRIDGE_DIR/scripts/update-bridge.sh" rollback >/dev/null 2>&1 || rollback_error="bridge rollback failed"
fi
if [[ -d /opt/trooper-org-runtime.previous ]]; then
  rm -rf /opt/trooper-org-runtime.failed
  mv /opt/trooper-org-runtime /opt/trooper-org-runtime.failed 2>/dev/null || true
  mv /opt/trooper-org-runtime.previous /opt/trooper-org-runtime || rollback_error="${rollback_error:+$rollback_error; }runtime rollback failed"
fi

if restart_managed_services; then
  if wait_until_healthy; then
    mark rolled_back rollback_verified "upgrade failed health verification (${failed_endpoints}) and was rolled back"
    logger -t trooper-upgrade "Upgrade $OPERATION_ID failed verification (${failed_endpoints}) and was rolled back"
    exit 1
  fi
  rollback_error="${rollback_error:+$rollback_error; }rollback health verification failed (${failed_endpoints})"
else
  rollback_error="${rollback_error:+$rollback_error; }managed services failed to restart after rollback"
fi

mark rollback_failed rollback_failed "$rollback_error"
logger -t trooper-upgrade "Upgrade $OPERATION_ID rollback failed: $rollback_error"
exit 2
