# Phase 6 — Pull backstop installation HOWTO

The three files committed alongside this doc are pure assets — they're
not wired into anything yet. They get installed onto each VPS during
the next snapshot bake (or fresh provision via setup-openclaw-full.sh).

## What ships in this commit

- `scripts/check-update.sh` — runs hourly, polls
  `$MISSION_CONTROL_URL/api/current-versions`, posts to `localhost:3002/upgrade`
  if drift.
- `scripts/openclaw-updater.service` — systemd oneshot.
- `scripts/openclaw-updater.timer` — hourly with 10-min jitter.

## How to wire into setup-openclaw-full.sh

Add these lines to phase 7 (systemd-units stage) of
`setup-openclaw-full.sh`, just after `openclaw-poller.service` is
installed:

```bash
# Phase 6 (W6): pull-based update backstop
curl -fsSL https://raw.githubusercontent.com/absurdfounder/openclawbridge/main/scripts/check-update.sh \
  -o /usr/local/bin/check-update.sh
chmod +x /usr/local/bin/check-update.sh

curl -fsSL https://raw.githubusercontent.com/absurdfounder/openclawbridge/main/scripts/openclaw-updater.service \
  -o /etc/systemd/system/openclaw-updater.service
curl -fsSL https://raw.githubusercontent.com/absurdfounder/openclawbridge/main/scripts/openclaw-updater.timer \
  -o /etc/systemd/system/openclaw-updater.timer

systemctl daemon-reload
systemctl enable --now openclaw-updater.timer
```

`boot.sh` (Phase 4 slim path) already references
`openclaw-updater.timer` in its `for unit in ...` enable loop, so once
the units exist on the snapshot they'll start automatically on every
fresh provision from that snapshot.

## How to verify on an existing VPS

```bash
systemctl list-timers openclaw-updater.timer
sudo systemctl start openclaw-updater.service   # one-shot run now
sudo journalctl -u openclaw-updater.service --since '5 min ago'
tail /var/log/openclaw-updater.log
```

Logs should show one of:
- `no drift; nothing to do` — happy path
- `bridge drift: local=abc1234 target=def5678` — followed by `/upgrade response:`
- `MISSION_CONTROL_URL unset; skipping` — snapshot-builder or unconfigured VPS

## Why pull AND push?

The push rollout (Phase 5) misses VPSes that:
- Were offline at rollout time (host network blip).
- Returned a transient 5xx that the circuit breaker counted as a failure
  and the operator never resumed.
- Had a corrupted `/upgrade` flow last time and crashed mid-restart.

The hourly pull catches all of those silently within 1 hour of recovery.
Worst-case fleet alignment time without any push at all is `1h + jitter`.
