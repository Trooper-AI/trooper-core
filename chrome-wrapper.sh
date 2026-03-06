#!/bin/bash
# Ensure Xvnc is running, then launch Chrome on the virtual display
if ! pgrep -f "Xvnc :99" >/dev/null 2>&1; then
  Xvnc :99 -geometry 1920x1080 -depth 24 -rfbport 5999 -localhost \
    -SecurityTypes None -AlwaysShared -AcceptKeyEvents -AcceptPointerEvents &
  sleep 0.5
fi
export DISPLAY=:99
exec /usr/bin/google-chrome-stable --disable-blink-features=AutomationControlled "$@"
