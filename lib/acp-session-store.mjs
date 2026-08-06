// Durable snapshot of the in-memory ACP session registry.
//
// `acpSessionRegistry` is a plain Map in the bridge process, so every ACP session is lost on
// restart — the UI shows nothing, and a task that is still running inside the gateway becomes
// invisible. This module lets the registry be snapshotted to SQLite and rehydrated on boot.
//
// Design constraint: the registry is read and *mutated in place* at roughly twenty sites
// (`registry.get(id).lastActivity = Date.now()`). Rewriting those into a persistent store would
// be a large change to live code. Instead the Map stays exactly as it is and this is a sidecar:
// the caller snapshots periodically and on shutdown, and restores at boot. Nothing at the
// existing call sites changes.
//
// Two things are deliberately not persisted:
//   - Internal fields (`_historyKeys` is a Set, `_eventSequence`, `_steerPending`) — not JSON,
//     and meaningless across a restart.
//   - `transcript`, `events`, `artifacts` — unbounded, and recoverable from the gateway. A
//     snapshot must stay small enough to write often.
//
// Pure except for the two functions that take an injected db handle, so the serialization rules
// can be tested without SQLite.

// Fields worth carrying across a restart: identity, routing, and last-known state.
export const PERSISTED_FIELDS = Object.freeze([
  'sessionId', 'sessionKey', 'runId', 'parentSessionKey', 'bindMode',
  'agent', 'provider', 'workerModel', 'workerModelLabel', 'modelSource',
  'connectionStatus', 'status', 'spawnedAt', 'lastActivity', 'permissions',
  'cwd', 'channel', 'projectRef', 'parentRunId', 'parentMessageId', 'output',
]);

// Statuses that describe a session actively doing something. After a restart the bridge has no
// idea whether the child is still alive, so these are restored as `unknown` rather than replayed
// as-is — showing a phantom "working" session is worse than admitting the state is unverified.
const LIVE_STATUSES = Object.freeze(new Set(['working', 'running', 'spawning', 'starting', 'streaming']));

export const RESTORED_UNKNOWN_STATUS = 'unknown';

export function serializeSession(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = String(entry.sessionId || '').trim();
  if (!id) return null;

  const out = {};
  for (const field of PERSISTED_FIELDS) {
    const value = entry[field];
    if (value === undefined) continue;
    // Guard against anything non-JSON sneaking into a persisted field later.
    if (typeof value === 'function' || value instanceof Set || value instanceof Map) continue;
    out[field] = value;
  }
  out.sessionId = id;
  return out;
}

// Rebuilds a registry entry. `status` is downgraded when it claimed to be live, and the entry is
// marked so callers can tell a restored session from one this process actually started.
export function deserializeSession(data) {
  if (!data || typeof data !== 'object') return null;
  const id = String(data.sessionId || '').trim();
  if (!id) return null;

  const wasLive = LIVE_STATUSES.has(String(data.status || '').toLowerCase());
  return {
    ...data,
    sessionId: id,
    status: wasLive ? RESTORED_UNKNOWN_STATUS : data.status,
    connectionStatus: wasLive ? RESTORED_UNKNOWN_STATUS : data.connectionStatus,
    restoredAt: Date.now(),
    restoredFromStatus: wasLive ? data.status : null,
    // Ephemeral state the snapshot deliberately drops, restored empty so consumers that read
    // these without checking do not hit undefined.
    transcript: [],
    events: [],
    artifacts: [],
  };
}

export function snapshotRegistry(entries = []) {
  const out = [];
  for (const entry of entries) {
    const serialized = serializeSession(entry);
    if (serialized) out.push(serialized);
  }
  return out;
}

export function restoreRegistry(rows = []) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    let data = row;
    if (typeof row?.data === 'string') {
      try { data = JSON.parse(row.data); } catch { continue; }
    }
    const entry = deserializeSession(data);
    if (entry) out.push(entry);
  }
  return out;
}

// --- SQLite side. `db` is injected so the rules above stay testable without a database. ---

export function ensureAcpSessionTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS acp_sessions (
    session_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )`);
}

// Replaces the stored set with the current one. A session gone from the registry is gone from the
// snapshot, so a closed session cannot reappear after a restart.
export function saveSessions(db, entries = []) {
  const rows = snapshotRegistry(entries);
  const now = Date.now();
  const upsert = db.prepare(
    `INSERT INTO acp_sessions (session_id, data, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
  );
  const keep = new Set(rows.map((r) => r.sessionId));
  for (const row of rows) upsert.run(row.sessionId, JSON.stringify(row), now);

  for (const existing of db.prepare('SELECT session_id FROM acp_sessions').all()) {
    if (!keep.has(existing.session_id)) {
      db.prepare('DELETE FROM acp_sessions WHERE session_id = ?').run(existing.session_id);
    }
  }
  return rows.length;
}

// Drops snapshots older than `maxAgeMs` on load: a session from a week-old process is noise, not
// state worth showing.
export function loadSessions(db, { maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  const cutoff = Date.now() - maxAgeMs;
  const rows = db.prepare('SELECT data, updated_at FROM acp_sessions WHERE updated_at >= ?').all(cutoff);
  return restoreRegistry(rows);
}
