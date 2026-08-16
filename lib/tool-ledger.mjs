/**
 * Observe-only tool ledger.
 *
 * The bridge sees every tool call a run makes (via the normalized onEvent
 * stream in runAgentStreaming) but persists tool events only for the chat and
 * task lanes, batched after the run ends. When a run is retried, replayed, or
 * crashes mid-flight, nothing records that the same tool call may have run
 * twice. This ledger writes one row per observed tool call and one status
 * update per observed outcome, and warns when the same tool + identical args
 * were already seen inside a recent window.
 *
 * Hard rules:
 *   - NEVER blocks or modifies dispatch. It only records and logs.
 *   - NEVER throws into the event stream — observeBridgeEvent swallows all
 *     persistence errors (a ledger failure must not take a live run down).
 *   - Duplicate deliveries of the same event (live + history replay + SSE)
 *     are deduped by eventId and by tool_call_id, so a logical call is
 *     recorded once.
 *
 * Controlled by TROOPER_TOOL_LEDGER: 'observe' (default) records, 'off'
 * disables the tap entirely.
 *
 * The `sqlite` handle is injected (better-sqlite3, synchronous) so the module
 * can be tested against an in-memory database, same as lib/memory-sources.mjs.
 */

import { createHash, randomUUID } from 'crypto';

export const TOOL_LEDGER_DEFAULT_WINDOW_MS = 15 * 60_000;

// Bounded memory for eventId dedupe — enough to cover any realistic overlap
// between the live stream and a history replay of the same run.
const MAX_SEEN_EVENT_IDS = 4096;

/** 'observe' (default) | 'off'. Anything explicitly off-like disables. */
export function resolveToolLedgerMode(env = process.env) {
  const raw = String(env?.TROOPER_TOOL_LEDGER || '').trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'disabled') return 'off';
  return 'observe';
}

/**
 * Deterministic JSON: object keys sorted at every depth so hashing the same
 * logical args always yields the same string regardless of key order.
 * Non-JSON values (functions, symbols, cycles) degrade to placeholders rather
 * than throwing — the ledger must never fail a run over odd params.
 */
export function stableStringify(value) {
  const seen = new Set();
  const walk = (v) => {
    if (v === null) return 'null';
    const type = typeof v;
    if (type === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    if (type === 'boolean' || type === 'string') return JSON.stringify(v);
    if (type === 'bigint') return JSON.stringify(String(v));
    if (type === 'undefined' || type === 'function' || type === 'symbol') return 'null';
    if (Array.isArray(v)) {
      if (seen.has(v)) return '"[circular]"';
      seen.add(v);
      const out = `[${v.map(walk).join(',')}]`;
      seen.delete(v);
      return out;
    }
    if (type === 'object') {
      if (seen.has(v)) return '"[circular]"';
      seen.add(v);
      const keys = Object.keys(v).sort();
      const out = `{${keys.map((k) => `${JSON.stringify(k)}:${walk(v[k])}`).join(',')}}`;
      seen.delete(v);
      return out;
    }
    return 'null';
  };
  return walk(value);
}

export function hashToolArgs(args) {
  return createHash('sha256').update(stableStringify(args ?? {})).digest('hex');
}

/**
 * Build a ledger bound to an injected better-sqlite3 handle. The `tool_ledger`
 * table is created by db/migrate.mjs at boot; tests run migrate() themselves.
 */
export function createToolLedger({
  sqlite,
  now = Date.now,
  id = randomUUID,
  log = console,
  windowMs = TOOL_LEDGER_DEFAULT_WINDOW_MS,
} = {}) {
  if (!sqlite) throw new Error('createToolLedger requires a sqlite handle');

  const seenEventIds = new Set();
  const rememberEventId = (eventId) => {
    seenEventIds.add(eventId);
    if (seenEventIds.size > MAX_SEEN_EVENT_IDS) {
      // Sets iterate in insertion order — drop the oldest entries.
      const overflow = seenEventIds.size - MAX_SEEN_EVENT_IDS;
      let dropped = 0;
      for (const key of seenEventIds) {
        seenEventIds.delete(key);
        if (++dropped >= overflow) break;
      }
    }
  };

  const insertRow = sqlite.prepare(`INSERT INTO tool_ledger
    (id, created_at, session_key, run_id, tool_call_id, tool, args_hash, status, dup_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'observed', ?)`);
  const selectDuplicate = sqlite.prepare(`SELECT id, created_at, tool, args_hash, tool_call_id
    FROM tool_ledger WHERE tool = ? AND args_hash = ? AND created_at >= ?
    ORDER BY created_at DESC, id DESC LIMIT 1`);
  const selectByCallId = sqlite.prepare('SELECT id FROM tool_ledger WHERE tool_call_id = ? LIMIT 1');
  const updateOutcome = sqlite.prepare(`UPDATE tool_ledger SET status = ? WHERE id = (
    SELECT id FROM tool_ledger WHERE tool_call_id = ? AND status = 'observed'
    ORDER BY created_at DESC, id DESC LIMIT 1)`);

  /**
   * Look for an earlier call of the same tool with identical args inside the
   * window. Read-only; used by recordCall to stamp dup_of and warn.
   */
  function findRecentDuplicate({ tool, argsHash, windowMs: overrideWindowMs = windowMs } = {}) {
    if (!tool || !argsHash) return null;
    return selectDuplicate.get(String(tool), String(argsHash), now() - overrideWindowMs) || null;
  }

  /**
   * Record an observed tool call. Returns the inserted row's { id, dupOf }.
   * When toolCallId was already recorded (duplicate delivery of the same
   * logical call over a second lane) nothing is written.
   */
  function recordCall({ sessionKey = null, runId = null, toolCallId = null, tool = 'unknown', argsHash = '' } = {}) {
    const callId = toolCallId ? String(toolCallId) : null;
    if (callId && selectByCallId.get(callId)) return null; // same logical call, already recorded
    const duplicate = findRecentDuplicate({ tool, argsHash });
    const rowId = id();
    insertRow.run(rowId, now(), sessionKey || null, runId || null, callId, String(tool || 'unknown'), String(argsHash || ''), duplicate?.id || null);
    if (duplicate) {
      log.warn(`[tool-ledger] duplicate tool call observed tool=${tool} argsHash=${String(argsHash).slice(0, 12)} dupOf=${duplicate.id} ageMs=${Math.max(0, now() - duplicate.created_at)} run=${String(runId || '').slice(0, 8)}`);
    }
    return { id: rowId, dupOf: duplicate?.id || null };
  }

  /** Record the observed outcome for a call. Returns rows updated (0 or 1). */
  function recordOutcome(toolCallId, ok) {
    if (!toolCallId) return 0;
    return updateOutcome.run(ok ? 'succeeded' : 'failed', String(toolCallId)).changes;
  }

  /**
   * Tap entry for the normalized bridge event stream. Only tool_start /
   * tool_result are ledger-relevant; everything else returns immediately so
   * high-frequency text chunks never touch SQLite. Never throws.
   */
  function observeBridgeEvent(eventName, payload = {}) {
    try {
      if (eventName !== 'tool_start' && eventName !== 'tool_result') return;
      const eventId = payload?.eventId ? String(payload.eventId) : null;
      if (eventId) {
        if (seenEventIds.has(eventId)) return;
        rememberEventId(eventId);
      }
      if (eventName === 'tool_start') {
        recordCall({
          sessionKey: payload?.sessionKey || null,
          runId: payload?.runId || null,
          toolCallId: payload?.toolCallId || null,
          tool: payload?.tool || payload?.toolName || 'unknown',
          argsHash: hashToolArgs(payload?.params),
        });
        return;
      }
      recordOutcome(payload?.toolCallId || null, payload?.success !== false);
    } catch (err) {
      // Observe-only: the ledger must never take a live run down.
      try { log.warn(`[tool-ledger] observe failed: ${err?.message || err}`); } catch { /* ignore */ }
    }
  }

  return { recordCall, recordOutcome, findRecentDuplicate, observeBridgeEvent };
}
