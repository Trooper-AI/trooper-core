#!/usr/bin/env bash
set -u

SCOPE="${1:-bridge}"
OPERATION_ID="${2:-unknown}"
BRIDGE_DIR="${TROOPER_BRIDGE_DIR:-/opt/openclaw-bridge}"
JOURNAL="$BRIDGE_DIR/scripts/update-upgrade-journal.mjs"
ATTEMPTS="${TROOPER_UPGRADE_HEALTH_ATTEMPTS:-45}"
SLEEP_SECONDS="${TROOPER_UPGRADE_HEALTH_INTERVAL_SECONDS:-2}"

mark() {
  node "$JOURNAL" "$1" "${2:-$1}" "${3:-}" >/dev/null 2>&1 || true
}

healthy() {
  curl -fsS --max-time 3 http://127.0.0.1:3002/healthz >/dev/null 2>&1 \
    && curl -fsS --max-time 3 http://127.0.0.1:3101/health >/dev/null 2>&1 \
    && curl -fsS --max-time 3 http://127.0.0.1:3001/health >/dev/null 2>&1 \
    && curl -fsS --max-time 3 http://127.0.0.1:18789/health >/dev/null 2>&1
}

restart_managed_services() {
  # A previous crash burst may have tripped systemd's start limiter. An
  # operator-requested, bounded upgrade verification is an explicit retry and
  # should get one clean start window.
  systemctl reset-failed trooper-org-runtime trooper-server openclaw-bridge trooper-shared-node-manager >/dev/null 2>&1 || true
  systemctl restart trooper-org-runtime trooper-server openclaw-bridge trooper-shared-node-manager
}

mark restarting service_restart
if ! restart_managed_services; then
  mark rolling_back restart_failed "systemd could not restart the managed services"
else
  mark verifying health_checks
  for ((attempt=1; attempt<=ATTEMPTS; attempt++)); do
    if healthy; then
      rm -rf /opt/openclaw-bridge.previous /opt/trooper-org-runtime.previous
      mark completed verified
      logger -t trooper-upgrade "Upgrade $OPERATION_ID completed and verified"
      exit 0
    fi
    sleep "$SLEEP_SECONDS"
  done
  mark rolling_back health_timeout "managed services did not become healthy after upgrade"
fi

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
  for ((attempt=1; attempt<=ATTEMPTS; attempt++)); do
    if healthy; then
      mark rolled_back rollback_verified "upgrade failed health verification and was rolled back"
      logger -t trooper-upgrade "Upgrade $OPERATION_ID failed verification and was rolled back"
      exit 1
    fi
    sleep "$SLEEP_SECONDS"
  done
  rollback_error="${rollback_error:+$rollback_error; }rollback health verification failed"
else
  rollback_error="${rollback_error:+$rollback_error; }managed services failed to restart after rollback"
fi

mark rollback_failed rollback_failed "$rollback_error"
logger -t trooper-upgrade "Upgrade $OPERATION_ID rollback failed: $rollback_error"
exit 2
