/**
 * TAPE — gateway-frame record/replay.
 *
 * ⚠ SECURITY: a real recording captures EVERY inbound frame VERBATIM — device
 * auth handshakes (connect.challenge nonces, auth res payloads), exec-approval
 * payloads, and all agent/user content. Nothing is redacted. Treat a tape of
 * real traffic like a credentials file: never commit one, never share one
 * outside the org, and delete it when the investigation ends. The committed
 * test fixture is synthetic and secret-free by construction.
 *
 * The bridge's behavior is driven by the JSON frames the OpenClaw gateway
 * sends over its WebSocket. Today the only record of them is a 200-entry,
 * truncated debug ring buffer — a bug seen once in production cannot be
 * replayed. This module records frames untruncated as JSONL and replays them
 * in order, so a captured session can be driven back through the event
 * pipeline offline.
 *
 * OFF by default: index.mjs wraps the gateway's `_handleFrame` only when
 * TROOPER_TAPE_DIR is set — with it unset nothing is wrapped and the hot path
 * is untouched. `_handleFrame` (not ws.on('message')) is the wrap point
 * because the ws object is destroyed and recreated on every reconnect, while
 * the instance method survives. Frames are JSON by construction on this
 * socket (inbound is JSON.parse of wire text; binary never appears).
 *
 * Caveat: recording is inbound-only. Outbound sends have no single choke
 * point (8 separate `this.ws.send(...)` sites in index.mjs) and rewriting
 * them is out of scope for an additive change; the JSONL format carries a
 * `dir` field ('in'/'out') so an outbound tap can join later.
 *
 * Line format: {"seq":N,"dir":"in","t":<epoch-ms>,"frame":{...}}
 */

import { appendFileSync, mkdirSync, readFileSync } from 'fs';
import path from 'path';

/** TROOPER_TAPE_DIR, or null when recording is off (the default). */
export function resolveTapeDir(env = process.env) {
  const raw = String(env?.TROOPER_TAPE_DIR || '').trim();
  return raw || null;
}

/**
 * Create a recorder appending JSONL to a fresh file in `dir`. The dir is
 * created eagerly so a bad path fails at creation time (callers disable the
 * recorder), while record() itself never throws — a tape write must never
 * take a live gateway frame down.
 */
export function createTapeRecorder({ dir, now = Date.now, name = null } = {}) {
  if (!dir) throw new Error('createTapeRecorder requires a dir');
  mkdirSync(dir, { recursive: true });
  const fileName = name
    || `tape-${new Date(now()).toISOString().replace(/[:.]/g, '-')}-${process.pid}.jsonl`;
  const filePath = path.join(dir, fileName);

  let seq = 0;
  let warned = false;

  function record(direction, frame) {
    seq += 1;
    try {
      appendFileSync(filePath, `${JSON.stringify({ seq, dir: direction, t: now(), frame })}\n`);
    } catch (err) {
      if (!warned) {
        warned = true;
        try { console.warn(`[tape] record failed (further failures muted): ${err?.message || err}`); } catch { /* ignore */ }
      }
    }
    return seq;
  }

  return { record, path: filePath };
}

/**
 * Replay a tape file: feed every recorded frame, in file order, to
 * handler(frame, { seq, dir, t }). Unparseable lines (e.g. a partial final
 * line from a tape cut mid-write) are skipped and counted, not fatal.
 * Returns { fed, skipped }.
 */
export function replayTape(tapePath, handler) {
  if (typeof handler !== 'function') throw new Error('replayTape requires a handler function');
  const lines = readFileSync(tapePath, 'utf8').split('\n');
  let fed = 0;
  let skipped = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    handler(entry.frame, { seq: entry.seq, dir: entry.dir, t: entry.t });
    fed += 1;
  }
  return { fed, skipped };
}

/**
 * Replay helper mirroring how OpenClawGateway._handleFrame dispatches agent
 * event frames to a run listener (index.mjs — the `frame.event === 'agent'`
 * branch, including the native `tool` stream → tool_use/tool_result rewrite).
 * index.mjs is the source of truth for this contract; keep the two in sync.
 * Returns true when the frame was dispatched, false for non-agent frames.
 */
export function dispatchAgentFrameToListener(frame, listener) {
  if (!frame || frame.type !== 'event' || frame.event !== 'agent') return false;
  const { runId, stream, data } = frame.payload || {};
  if (stream === 'tool' && data) {
    const phase = data.phase || data.event;
    if (phase === 'start' || phase === 'call') {
      listener('tool_use', { name: data.name || data.tool, input: data.args || data.input || data.params || {}, ...data }, runId);
      return true;
    }
    if (phase === 'end' || phase === 'result') {
      listener('tool_result', { name: data.name || data.tool, content: data.result || data.output || data.summary || '', is_error: !!data.error, ...data }, runId);
      return true;
    }
  }
  listener(stream, data, runId);
  return true;
}
