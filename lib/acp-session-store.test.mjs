import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PERSISTED_FIELDS,
  RESTORED_UNKNOWN_STATUS,
  deserializeSession,
  ensureAcpSessionTable,
  loadSessions,
  restoreRegistry,
  saveSessions,
  serializeSession,
  snapshotRegistry,
} from './acp-session-store.mjs';

// Minimal stand-in for the better-sqlite3 handle, so the SQL-shaped logic (upsert plus deleting
// rows for sessions no longer in the registry) is covered without a database.
function fakeDb(initialRows = []) {
  const rows = new Map(initialRows.map((r) => [r.session_id, r]));
  const calls = { exec: 0 };
  return {
    rows,
    calls,
    exec() { calls.exec += 1; },
    prepare(sql) {
      if (sql.startsWith('INSERT INTO acp_sessions')) {
        return { run: (id, data, updatedAt) => rows.set(id, { session_id: id, data, updated_at: updatedAt }) };
      }
      if (sql.startsWith('SELECT session_id')) {
        return { all: () => [...rows.values()].map((r) => ({ session_id: r.session_id })) };
      }
      if (sql.startsWith('DELETE FROM acp_sessions')) {
        return { run: (id) => rows.delete(id) };
      }
      if (sql.startsWith('SELECT data')) {
        return { all: (cutoff) => [...rows.values()].filter((r) => r.updated_at >= cutoff) };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  };
}

function liveEntry(overrides = {}) {
  return {
    sessionId: 'agent:main:acp:abc',
    sessionKey: 'agent:main:acp:abc',
    agent: 'claude',
    provider: 'anthropic',
    status: 'working',
    connectionStatus: 'connected',
    spawnedAt: 1000,
    lastActivity: 2000,
    permissions: 'approve-reads',
    cwd: '/work',
    output: 'partial',
    // Non-serializable / ephemeral state that must not reach the snapshot:
    transcript: [{ id: 'x', content: 'hello' }],
    events: [{ seq: 1 }],
    artifacts: [{ path: 'a.txt' }],
    _historyKeys: new Set(['k']),
    _eventSequence: 7,
    _steerPending: true,
    ...overrides,
  };
}

test('serialization keeps identity and state, drops ephemeral and non-JSON fields', () => {
  const out = serializeSession(liveEntry());
  assert.equal(out.sessionId, 'agent:main:acp:abc');
  assert.equal(out.agent, 'claude');
  assert.equal(out.status, 'working');
  for (const dropped of ['transcript', 'events', 'artifacts', '_historyKeys', '_eventSequence', '_steerPending']) {
    assert.equal(out[dropped], undefined, `${dropped} must not be persisted`);
  }
});

test('a snapshot is JSON-serializable', () => {
  // The Set in _historyKeys would survive a naive spread and break JSON.stringify round-tripping.
  const out = serializeSession(liveEntry());
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(out)));
});

test('every persisted field is carried when present', () => {
  const entry = liveEntry();
  for (const field of PERSISTED_FIELDS) entry[field] ??= `v-${field}`;
  const out = serializeSession(entry);
  for (const field of PERSISTED_FIELDS) {
    assert.notEqual(out[field], undefined, `${field} should round-trip`);
  }
});

test('entries without a session id are rejected', () => {
  for (const entry of [null, undefined, {}, { sessionId: '' }, { sessionId: '   ' }, 'nope']) {
    assert.equal(serializeSession(entry), null);
  }
});

test('a session that was live is restored as unknown, not as still working', () => {
  // Restoring "working" would show a phantom active session for a child the bridge cannot see.
  for (const status of ['working', 'running', 'spawning', 'starting', 'streaming']) {
    const restored = deserializeSession(serializeSession(liveEntry({ status })));
    assert.equal(restored.status, RESTORED_UNKNOWN_STATUS);
    assert.equal(restored.connectionStatus, RESTORED_UNKNOWN_STATUS);
    assert.equal(restored.restoredFromStatus, status);
  }
});

test('a terminal status is restored unchanged', () => {
  for (const status of ['completed', 'failed', 'cancelled', 'idle']) {
    const restored = deserializeSession(serializeSession(liveEntry({ status })));
    assert.equal(restored.status, status);
    assert.equal(restored.restoredFromStatus, null);
  }
});

test('restored entries carry a restore marker and empty ephemeral collections', () => {
  const restored = deserializeSession(serializeSession(liveEntry()));
  assert.ok(restored.restoredAt > 0);
  assert.deepEqual(restored.transcript, []);
  assert.deepEqual(restored.events, []);
  assert.deepEqual(restored.artifacts, []);
});

test('snapshotRegistry skips unusable entries rather than failing the whole snapshot', () => {
  const rows = snapshotRegistry([liveEntry(), null, {}, liveEntry({ sessionId: 'b' })]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.sessionId).sort(), ['agent:main:acp:abc', 'b']);
});

test('restoreRegistry parses stored JSON rows', () => {
  const stored = [{ data: JSON.stringify(serializeSession(liveEntry())) }];
  const restored = restoreRegistry(stored);
  assert.equal(restored.length, 1);
  assert.equal(restored[0].sessionId, 'agent:main:acp:abc');
});

test('restoreRegistry skips corrupt rows instead of throwing', () => {
  const restored = restoreRegistry([
    { data: '{not json' },
    { data: JSON.stringify(serializeSession(liveEntry())) },
    { data: 'null' },
    null,
  ]);
  assert.equal(restored.length, 1);
});

test('restoreRegistry tolerates non-array input', () => {
  for (const input of [undefined, null, 'nope', 42]) {
    assert.deepEqual(restoreRegistry(input), []);
  }
});

test('a full save/load round trip preserves identity and downgrades live status', () => {
  const rows = snapshotRegistry([liveEntry({ status: 'working' }), liveEntry({ sessionId: 'b', status: 'completed' })]);
  const restored = restoreRegistry(rows.map((r) => ({ data: JSON.stringify(r) })));
  assert.deepEqual(restored.map((r) => r.sessionId).sort(), ['agent:main:acp:abc', 'b']);
  const byId = Object.fromEntries(restored.map((r) => [r.sessionId, r]));
  assert.equal(byId['agent:main:acp:abc'].status, RESTORED_UNKNOWN_STATUS);
  assert.equal(byId.b.status, 'completed');
});

test('ensureAcpSessionTable issues its DDL', () => {
  const db = fakeDb();
  ensureAcpSessionTable(db);
  assert.equal(db.calls.exec, 1);
});

test('saveSessions writes every current session', () => {
  const db = fakeDb();
  const written = saveSessions(db, [liveEntry(), liveEntry({ sessionId: 'b' })]);
  assert.equal(written, 2);
  assert.deepEqual([...db.rows.keys()].sort(), ['agent:main:acp:abc', 'b']);
});

test('a session removed from the registry is deleted from the snapshot', () => {
  // Otherwise a closed session would reappear as live after the next restart.
  const db = fakeDb();
  saveSessions(db, [liveEntry(), liveEntry({ sessionId: 'b' })]);
  saveSessions(db, [liveEntry()]);
  assert.deepEqual([...db.rows.keys()], ['agent:main:acp:abc']);
});

test('saving an empty registry clears the snapshot entirely', () => {
  const db = fakeDb();
  saveSessions(db, [liveEntry()]);
  assert.equal(saveSessions(db, []), 0);
  assert.equal(db.rows.size, 0);
});

test('loadSessions restores what was saved, with live status downgraded', () => {
  const db = fakeDb();
  saveSessions(db, [liveEntry({ status: 'working' })]);
  const [restored] = loadSessions(db);
  assert.equal(restored.sessionId, 'agent:main:acp:abc');
  assert.equal(restored.status, RESTORED_UNKNOWN_STATUS);
});

test('loadSessions drops snapshots older than the age cutoff', () => {
  // A session from a week-old process is noise, not state worth showing.
  const db = fakeDb([
    { session_id: 'old', data: JSON.stringify({ sessionId: 'old' }), updated_at: 0 },
  ]);
  assert.deepEqual(loadSessions(db, { maxAgeMs: 1000 }), []);
  assert.equal(loadSessions(db, { maxAgeMs: Date.now() + 1000 }).length, 1);
});
