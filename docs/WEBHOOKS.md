# Inbound Webhooks

Webhooks are the event-driven counterpart to cron. A cron job wakes an agent
on a clock ("every morning at 9"); a webhook wakes an agent the moment the
outside world sends an event — a form submission, a payment, a CI result, a
CRM update. The external system POSTs to a per-hook URL on the bridge, the
bridge wakes the configured agent with the payload, the agent does the work
(and can reply by email, post to a channel, update a task — anything its
tools allow).

```
Form provider ──POST──▶ /webhook/in/<hookId>   (bridge, per-hook secret)
                              │
                              ▼
                    OpenClaw gateway wake        (WebSocket, or /hooks/agent fallback)
                              │
                              ▼
                    Agent session runs the event (sessionKey ties everything together)
                              │
                              ▼
                    Delivery receipt updated     (accepted → completed/failed)
```

Everything below talks to the bridge. `$BRIDGE` is your bridge base URL
(e.g. `https://<your-vps-host>`), `$BRIDGE_TOKEN` is the bridge auth token
(management calls only — external callers never hold it).

## 1. Create a webhook

Management endpoints live under `/webhook/manage` and require bridge auth
(the Settings → Webhooks UI in Mission Control talks to these).

```bash
curl -sS -X POST "$BRIDGE/webhook/manage" \
  -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Website leads form",
    "agent": "Jordan",
    "instructions": "A lead submitted our contact form. Draft and send a warm welcome email to the submitter, then add a row to the leads task list.",
    "sessionMode": "isolated"
  }'
```

Response (`201`):

```json
{
  "webhook": {
    "id": "wh_9f2c1a8e77b04d31",
    "name": "Website leads form",
    "agent": "jordan",
    "instructions": "A lead submitted our contact form. …",
    "sessionMode": "isolated",
    "enabled": true,
    "path": "/webhook/in/wh_9f2c1a8e77b04d31",
    "token": "whsec_5b0f…e2d9",
    "tokenPreview": "whsec_…e2d9",
    "fireCount": 0,
    "lastFiredAt": null,
    "createdAt": 1765900000000,
    "updatedAt": 1765900000000
  }
}
```

Fields:

| Field | Meaning |
| --- | --- |
| `agent` | Registered agent (name or slug) that handles events. Must exist on the bridge. |
| `instructions` | Standing prompt prefixed to every event — this is where "what to do when this fires" lives. |
| `sessionMode` | `isolated` (default): every event runs in a fresh session. `shared`: all events for this hook land in one continuous session so the agent keeps context across deliveries. |
| `token` | The `whsec_…` secret external callers must present. Shown in full on the management surface only. |

Other management calls:

```bash
curl -sS "$BRIDGE/webhook/manage" -H "Authorization: Bearer $BRIDGE_TOKEN"          # list
curl -sS "$BRIDGE/webhook/manage/wh_…" -H "Authorization: Bearer $BRIDGE_TOKEN"     # detail + last 20 deliveries
curl -sS -X PATCH "$BRIDGE/webhook/manage/wh_…" -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" -d '{"enabled": false}'                       # pause (also: name/agent/instructions/sessionMode)
curl -sS -X POST "$BRIDGE/webhook/manage/wh_…/rotate" -H "Authorization: Bearer $BRIDGE_TOKEN"  # new token
curl -sS -X DELETE "$BRIDGE/webhook/manage/wh_…" -H "Authorization: Bearer $BRIDGE_TOKEN"       # delete + its receipts
```

## 2. Send an event

The inbound endpoint is `POST /webhook/in/<hookId>`. It is exempt from
bridge auth; it authenticates with the hook's own token, presented any of
three ways (checked in this order):

1. `Authorization: Bearer whsec_…`
2. `X-Webhook-Token: whsec_…`
3. `?token=whsec_…` in the URL — for providers that only let you paste a URL

JSON body:

```bash
curl -sS -X POST "$BRIDGE/webhook/in/wh_9f2c1a8e77b04d31" \
  -H "Authorization: Bearer whsec_5b0f…e2d9" \
  -H "Content-Type: application/json" \
  -d '{"name": "Jane Doe", "email": "jane@example.com", "message": "Interested in the pro plan"}'
```

Form-encoded bodies work too (plain HTML forms, many older providers):

```html
<form action="https://your-bridge.example.com/webhook/in/wh_9f2c1a8e77b04d31?token=whsec_5b0f…e2d9"
      method="POST">
  <input name="email" type="email" required />
  <textarea name="message"></textarea>
  <button type="submit">Send</button>
</form>
```

From JavaScript:

```js
await fetch('https://your-bridge.example.com/webhook/in/wh_9f2c1a8e77b04d31', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer whsec_5b0f…e2d9',
    'X-Idempotency-Key': submission.id,   // optional replay guard, see below
  },
  body: JSON.stringify(submission),
});
```

## 3. What response you receive

**Async (default) — `202 Accepted`.** The agent run starts in the
background; the HTTP call returns immediately:

```json
{
  "status": "accepted",
  "eventId": "evt_c3a94d1b20f8e657",
  "sessionKey": "agent:main:hook:trooper:jordan:webhook:wh_9f2c1a8e77b04d31:evt_c3a94d1b20f8e657",
  "via": "websocket"
}
```

**Sync — `200 OK` with the agent's answer.** Append `?sync=1` (optionally
`&timeout=<seconds>`, clamped to 5–300, default 120) and the call blocks
until the run finishes:

```json
{
  "status": "completed",
  "eventId": "evt_c3a94d1b20f8e657",
  "sessionKey": "agent:main:hook:trooper:jordan:webhook:wh_9f2c1a8e77b04d31:evt_c3a94d1b20f8e657",
  "via": "websocket",
  "response": "Sent Jane a welcome email and added her to the leads list."
}
```

If the sync timeout is reached the run keeps going and you get a `202` with a
note — poll the delivery receipt for the result. Most form providers time out
in 5–30 s, so leave those on the async default. Sync waiting is only
available on the WebSocket transport; when the bridge falls back to the
gateway's `/hooks/agent` HTTP API you always get `202` with
`"via": "hook-fallback"`.

**Duplicate — `200`** with `"status": "duplicate"` and the original
`eventId` (see idempotency below). No second run starts.

**Errors:**

| Status | Body | Meaning |
| --- | --- | --- |
| `401` | `invalid_webhook_or_token` | Unknown hook id **or** wrong token (deliberately indistinguishable). |
| `409` | `webhook_disabled` | Hook exists but is paused. |
| `502` | `{"status":"failed", "error":…}` | The wake or run failed — the delivery receipt has the same error. |
| `503` | `agent_not_registered` / gateway unavailable | The target agent left the bridge, or no transport to the gateway. |

## 4. How a run gets associated with your request

Every accepted event gets two identifiers, both returned in the response:

- **`eventId`** (`evt_…`) — the delivery receipt's primary key. The receipt
  is stored in the bridge DB (`webhook_deliveries`, newest 50 per hook) and
  moves `accepted → completed` / `failed` when the run ends, capturing a
  result excerpt or the error. Read it back with
  `GET /webhook/manage/<hookId>` (bridge auth) — this is what the Settings →
  Webhooks "recent deliveries" list renders.
- **`sessionKey`** — the OpenClaw session the wake landed in, following the
  same convention as email threads:
  `agent:<gatewayAgentId>:hook:trooper:<agentSlug>:webhook:<hookId>[:<eventId>]`.
  In `isolated` mode the `eventId` suffix makes each event its own session;
  in `shared` mode the suffix is dropped, so every event continues one
  long-running conversation and the agent remembers previous deliveries.
  Anything else that reads gateway sessions (runs views, logs, the tool
  ledger) can join on this key.

Retries: send the provider's delivery id as `X-Idempotency-Key` (or
`?event=…`). A retry with a key the hook has already seen returns
`status: "duplicate"` with the original `eventId` instead of waking the
agent twice.

## 5. Security notes

- The hook token authorizes exactly one thing: firing that one hook. It is
  not the bridge token; external systems never see bridge auth.
- Token checks are constant-time, and unknown-id vs bad-token are the same
  `401`, so hook ids can't be enumerated.
- Rotate a leaked token with `POST /webhook/manage/<id>/rotate`; pause a
  noisy source with `PATCH {"enabled": false}`.
- Payloads are untrusted input: they are rendered into the wake message as
  data (fenced, truncated at 6 000 chars), and the hook's stored
  `instructions` — written by you, not the caller — carry the authority on
  what to do.
- The gateway keeps the same guardrails as every other wake: session keys
  stay inside the `hook:trooper:` prefix allowed in `openclaw.json`.
