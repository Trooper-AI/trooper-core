#!/bin/bash
# Ensure Xvnc is running, then launch Chrome on the virtual display
if ! pgrep -f "Xvnc :99" >/dev/null 2>&1 && [ -f /tmp/.X99-lock ]; then
  rm -f /tmp/.X99-lock || true
fi
if ! pgrep -f "Xvnc :99" >/dev/null 2>&1; then
  Xvnc :99 -geometry 1920x1080 -depth 24 -rfbport 5999 -localhost \
    -SecurityTypes None -AlwaysShared -AcceptKeyEvents -AcceptPointerEvents >/tmp/xvnc.log 2>&1 &
  sleep 1
fi
export DISPLAY=:99
mkdir -p /home/node/.cache/openclaw-chrome-profile /home/node/.cache/google-chrome /tmp/openclaw-crashpad
chown -R 1000:1000 /home/node/.cache/openclaw-chrome-profile /home/node/.cache/google-chrome /tmp/openclaw-crashpad 2>/dev/null || true
export CHROME_LOG_FILE=/tmp/openclaw-chrome.log
CHROME_BIN=/usr/bin/google-chrome-stable
if [ ! -x "$CHROME_BIN" ]; then
  CHROME_BIN=/usr/bin/google-chrome
fi
exec "$CHROME_BIN" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --disable-crashpad \
  --disable-crash-reporter \
  --no-first-run \
  --no-default-browser-check \
  --user-data-dir=/home/node/.cache/openclaw-chrome-profile \
  --disable-blink-features=AutomationControlled \
  "$@"
