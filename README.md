# 🦞 OpenClaw Bridge

A webhook bridge that allows Mission Control agents to delegate complex tasks to OpenClaw AI.

## How It Works

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│ Mission Control │  POST   │    OpenClaw     │  polls  │    OpenClaw     │
│     Agent       │ ──────► │     Bridge      │ ◄────── │   (AI Agent)    │
│  (uses tool)    │         │   (this app)    │ ──────► │  (does work)    │
└─────────────────┘         └─────────────────┘ result  └─────────────────┘
```

1. Mission Control agent calls `openclaw` tool with a task
2. Bridge receives the request and queues it
3. OpenClaw polls for pending requests
4. OpenClaw executes the task (browse, search, analyze, etc.)
5. OpenClaw submits result back to bridge
6. Bridge returns result to Mission Control agent

## Deployment

### Render (Recommended)

1. Create a new Web Service on Render
2. Connect this repository
3. Settings:
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
4. Environment Variables:
   - `OPENCLAW_WEBHOOK_SECRET` - Shared secret for auth (optional but recommended)

### Local Development

```bash
npm install
npm run dev
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard UI |
| `/health` | GET | Health check |
| `/webhook/mission-control` | POST | Receive tasks from Mission Control |
| `/requests/pending` | GET | OpenClaw polls for work |
| `/requests/:id` | GET | Get request details |
| `/requests/:id/result` | POST | OpenClaw submits results |
| `/api/memory/sources` | GET/POST | List or register synced memory sources |
| `/api/memory/sources/:sourceId/entries` | GET/POST | List or upsert synced memory entries |
| `/api/memory/search` | POST | Search synced memory entries |
| `/api/memory/sources/github/sync` | POST | Sync configured GitHub issues/PRs into memory |

## Synced Memory Sources

Native integrations can expose database sync as Memory without mixing synced
records into hand-authored long-term memories.

Example GitHub sync:

```bash
export TROOPER_GITHUB_REPOS=openclaw/crawlbar
export TROOPER_GITHUB_TOKEN=ghp_... # optional for public repos, required for private repos

curl -X POST -H "Authorization: Bearer $BRIDGE_TOKEN" \
  http://localhost:3002/api/memory/sources/github/sync

curl -H "Authorization: Bearer $BRIDGE_TOKEN" \
  http://localhost:3002/api/memory/sources

curl -X POST -H "Authorization: Bearer $BRIDGE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"menu bar","sources":["github"],"limit":5}' \
  http://localhost:3002/api/memory/search
```

Trooper-compatible org-prefixed aliases are also available under:

```text
/api/organizations/:orgId/memory/sources
/api/organizations/:orgId/memory/sources/:sourceId/entries
/api/organizations/:orgId/memory/search
```

## Mission Control Setup

Add to your Mission Control environment:

```env
OPENCLAW_WEBHOOK_URL=https://your-bridge.onrender.com/webhook/mission-control
OPENCLAW_WEBHOOK_SECRET=your_shared_secret
```

Your agents can now use these tools:
- `openclaw` - General task delegation
- `openclaw_browse` - Browse websites with full browser
- `openclaw_vision` - Analyze images
- `openclaw_research` - Deep research on topics

## OpenClaw Setup

Add a cron job or heartbeat check to poll for requests:

```
Check https://your-bridge.onrender.com/requests/pending
For each request, execute the task and POST result to /requests/:id/result
```

## License

MIT
