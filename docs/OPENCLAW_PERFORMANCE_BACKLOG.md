# OpenClaw Performance Backlog

**Principle:** OpenClaw is the execution engine. Trooper is the visual/control layer.  
**Rule:** For agent speed, reliability, and cost — fix OpenClaw + this bridge (`trooper-core`), not the React app.

Last updated: 2026-07-21

---

## Status

| ID | Item | Sev | Status |
|----|------|-----|--------|
| OC-01 | Tiered video completion contracts (draft / standard / production) | P0 | **Done** (2026-07-21) |
| OC-02 | Sub-agent spawn metadata queue + stop clearing all children on first `sessions_spawn` result | P0 | **Done** (2026-07-21) |
| OC-03 | Disable control-plane `callAI` sub-agents (OpenClaw only) | P1 | **Done** (2026-07-21, Trooper `subagent-tool.js`) |
| OC-04 | Native video finalize tool (collapse multi-tool ritual) | P0 | Backlog — gateway/plugin |
| OC-05 | Guaranteed terminal events on timeout/OOM/cancel | P0 | Backlog — OpenClaw gateway |
| OC-06 | Zero docker-shell media path (shared FS or gateway RPC) | P1 | Backlog |
| OC-07 | Stable pairing without gateway restart loops | P0 | Backlog — gateway |
| OC-08 | True parallel `sessions_spawn` join API + child hard timeouts | P1 | Backlog — gateway |
| OC-09 | Plugin hot-reload without full gateway restart | P1 | Backlog — gateway |
| OC-10 | Atomic supervisor (gateway + bridge + org-runtime) | P1 | Backlog — VPS units |
| OC-11 | Per-child workspace isolation (worktrees) | P2 | Backlog |
| OC-12 | Structured run states (`awaiting_user`, `blocked`, …) | P1 | Backlog — gateway |
| OC-13 | Finish direct-to-VPS for all agent I/O | P2 | Partial (media/streams) |

---

## Wave 1 (ship in trooper-core now)

### OC-01 — Video contract tiers

**Problem:** Platform words (`tiktok`, `reel`, `draft`) force full production QA + render completion + up to 2 full LLM continuations.

**Fix:**
- `draft` — mutation only; ≤1 continuation
- `standard` — mutation + completed render; ≤1 continuation; no forced brand/perception/frames/lint
- `production` — full checklist; ≤2 continuations (explicit production/post-ready/publish/final)

### OC-02 — Parallel sub-agent association

**Problem:** Single `pendingSubAgentSpawn` slot; `sessions_spawn` tool_result clears **all** active children (kills parallel work metadata and can mark live children done).

**Fix:** FIFO pending queue; only complete children on lifecycle/task_completion (drain timeout remains safety net).

### OC-03 — OpenClaw-only sub-agents

**Problem:** Trooper `spawn_subagent` can fall back to control-plane `callAI` (no real tools, no VPS parallelism).

**Fix:** Require bridge/OpenClaw execution path.

---

## Wave 2 (OpenClaw gateway / plugins)

Prefer upstream OpenClaw or gateway plugins over more bridge prose contracts.

1. **OC-04** `video_finalize` (or equivalent) — one tool with internal steps  
2. **OC-05** Durable `lifecycle:end` for every runId on kill/timeout  
3. **OC-07** Trusted bridge device that survives gateway restart without docker restart loops  
4. **OC-08** Parent join: wait for N children with per-child timeout  
5. **OC-09** Hot-reload extensions without process restart  
6. **OC-12** First-class run status in protocol (stop scraping `?` from text)

---

## Wave 3 (VPS / infra)

1. **OC-06** Shared volume or gateway file API — eliminate `docker exec … base64` on media  
2. **OC-10** One systemd target restarts gateway + bridge + org-runtime with ordered health  
3. **OC-11** Session worktrees for parallel implement agents  
4. **OC-13** No Railway hop for agent bytes

---

## Non-goals (Trooper UI)

- Indicator polish (“Working…” zombies) without fixing terminal events  
- More control-plane orchestration that reimplements OpenClaw  
- Growing `server/store.js` for execution semantics  

---

## Definition of done (performance)

For a typical “make a draft TikTok cut” request:

- ≤1 agent pass after first finalization attempt in common case  
- No forced brand/perception/frames/lint unless production language  
- Parallel `sessions_spawn` ×2 keeps both children live until each ends  
- Sub-agents always hit OpenClaw, never control-plane chat completion  
