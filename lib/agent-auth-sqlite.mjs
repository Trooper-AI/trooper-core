import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * OpenClaw 2026.6+ reads per-agent auth from openclaw-agent.sqlite
 * (store_key/state_key = "primary"), not only auth-profiles.json.
 * Keep both in sync whenever Trooper writes synthetic local-provider keys.
 */
export function syncAgentAuthProfileSqlite(dbPath, authDoc = {}) {
  try {
    if (!dbPath) return false;
    mkdirSync(dirname(dbPath), { recursive: true });
    const storeJson = JSON.stringify({
      version: authDoc.version || 1,
      profiles: authDoc.profiles || {},
      lastGood: authDoc.lastGood || {},
    });
    const stateJson = JSON.stringify({
      version: 1,
      lastGood: authDoc.lastGood || {},
    });
    const script = `
import json, sqlite3, time
from pathlib import Path
db = Path(${JSON.stringify(dbPath)})
db.parent.mkdir(parents=True, exist_ok=True)
con = sqlite3.connect(str(db))
cur = con.cursor()
cur.executescript("""
CREATE TABLE IF NOT EXISTS auth_profile_store (
  store_key TEXT PRIMARY KEY NOT NULL,
  store_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_profile_state (
  state_key TEXT PRIMARY KEY NOT NULL,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
""")
now = int(time.time() * 1000)
store = ${JSON.stringify(storeJson)}
state = ${JSON.stringify(stateJson)}
cur.execute(
  "INSERT INTO auth_profile_store(store_key, store_json, updated_at) VALUES (?,?,?) "
  "ON CONFLICT(store_key) DO UPDATE SET store_json=excluded.store_json, updated_at=excluded.updated_at",
  ("primary", store, now),
)
cur.execute(
  "INSERT INTO auth_profile_state(state_key, state_json, updated_at) VALUES (?,?,?) "
  "ON CONFLICT(state_key) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at",
  ("primary", state, now),
)
con.commit()
con.close()
print("ok")
`;
    const out = execSync('python3 -', {
      input: script,
      encoding: 'utf8',
      timeout: 10000,
    });
    try {
      execSync(`chown 1000:1000 ${JSON.stringify(dbPath)} 2>/dev/null || true; chmod 600 ${JSON.stringify(dbPath)} 2>/dev/null || true`, {
        timeout: 3000,
        shell: '/bin/bash',
      });
    } catch {}
    return /ok/.test(String(out || ''));
  } catch (error) {
    console.warn(`[bridge] Failed to sync agent auth sqlite (${dbPath}): ${error.message}`);
    return false;
  }
}

export function agentAuthSqlitePath(openclawConfigPathFn, agentId = 'main') {
  return openclawConfigPathFn('agents', agentId, 'agent', 'openclaw-agent.sqlite');
}

export function agentAuthSqliteExists(openclawConfigPathFn, agentId = 'main') {
  return existsSync(agentAuthSqlitePath(openclawConfigPathFn, agentId));
}
