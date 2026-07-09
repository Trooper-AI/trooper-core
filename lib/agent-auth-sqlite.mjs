import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LOCAL_PROVIDER_AUTH_KEY = 'trooper-local-provider-no-api-key';
const LOCAL_AUTH_PROVIDERS = new Set(['local-llamacpp', 'ollama']);

/**
 * OpenClaw 2026.6+ reads per-agent auth from openclaw-agent.sqlite
 * (store_key/state_key = "primary"), not only auth-profiles.json.
 * Keep both in sync whenever Trooper writes synthetic local-provider keys.
 *
 * Why this exists product-wide:
 * Users hit "No API key found for provider local-llamacpp" with Auth store
 * openclaw-agent.sqlite even when auth-profiles.json was correct. Every
 * Trooper VPS must auto-heal that gap so local models work without support.
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
      execSync(
        `chown 1000:1000 ${JSON.stringify(dbPath)} 2>/dev/null || true; chmod 600 ${JSON.stringify(dbPath)} 2>/dev/null || true`,
        { timeout: 3000, shell: '/bin/bash' },
      );
    } catch {}
    return /ok/.test(String(out || ''));
  } catch (error) {
    console.warn(`[bridge] Failed to sync agent auth sqlite (${dbPath}): ${error.message}`);
    return false;
  }
}

export function readAgentAuthProfileSqlitePrimary(dbPath) {
  try {
    if (!dbPath || !existsSync(dbPath)) return null;
    const script = `
import json, sqlite3
from pathlib import Path
db = Path(${JSON.stringify(dbPath)})
if not db.exists():
  print("")
  raise SystemExit(0)
con = sqlite3.connect(str(db))
row = con.execute("SELECT store_json FROM auth_profile_store WHERE store_key='primary'").fetchone()
con.close()
print(row[0] if row and row[0] else "")
`;
    const out = execSync('python3 -', {
      input: script,
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    if (!out) return null;
    return JSON.parse(out);
  } catch {
    return null;
  }
}

export function agentAuthSqliteHasProvider(dbPath, provider) {
  const store = readAgentAuthProfileSqlitePrimary(dbPath);
  if (!store?.profiles || typeof store.profiles !== 'object') return false;
  const want = String(provider || '').trim().toLowerCase();
  return Object.values(store.profiles).some(
    (profile) => profile
      && typeof profile === 'object'
      && String(profile.provider || '').toLowerCase() === want
      && String(profile.key || profile.token || '').trim(),
  );
}

/**
 * Merge local provider placeholder keys into an auth-profiles document.
 */
export function ensureLocalProvidersInAuthDoc(authDoc = {}, providers = []) {
  const next = authDoc && typeof authDoc === 'object' ? { ...authDoc } : { version: 1 };
  next.version = next.version || 1;
  next.profiles = next.profiles && typeof next.profiles === 'object' ? { ...next.profiles } : {};
  next.lastGood = next.lastGood && typeof next.lastGood === 'object' ? { ...next.lastGood } : {};
  let changed = false;
  for (const raw of providers) {
    const provider = String(raw || '').trim().toLowerCase();
    if (!LOCAL_AUTH_PROVIDERS.has(provider)) continue;
    const profileId = `${provider}:default`;
    const desired = {
      type: 'api_key',
      provider,
      key: LOCAL_PROVIDER_AUTH_KEY,
    };
    if (JSON.stringify(next.profiles[profileId] || null) !== JSON.stringify(desired)) {
      next.profiles[profileId] = desired;
      changed = true;
    }
    if (next.lastGood[provider] !== profileId) {
      next.lastGood[provider] = profileId;
      changed = true;
    }
  }
  return { authDoc: next, changed };
}

/**
 * Import auth-profiles.json → openclaw-agent.sqlite for every agent dir under agentsRoot.
 * Call on every bridge boot so upgrades to OpenClaw 2026.6+ never leave users stuck.
 */
export function migrateAllAgentAuthJsonToSqlite({
  agentsRoot,
  providers = [],
  readJson = (p) => JSON.parse(readFileSync(p, 'utf8')),
} = {}) {
  const results = [];
  if (!agentsRoot || !existsSync(agentsRoot)) return results;

  let agentIds = [];
  try {
    agentIds = readdirSync(agentsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    agentIds = ['main'];
  }
  if (!agentIds.includes('main')) agentIds.unshift('main');

  for (const agentId of [...new Set(agentIds)]) {
    const agentDir = join(agentsRoot, agentId, 'agent');
    const jsonPath = join(agentDir, 'auth-profiles.json');
    const dbPath = join(agentDir, 'openclaw-agent.sqlite');
    let authDoc = { version: 1, profiles: {}, lastGood: {} };
    try {
      if (existsSync(jsonPath)) authDoc = readJson(jsonPath) || authDoc;
    } catch {}
    const { authDoc: merged, changed } = ensureLocalProvidersInAuthDoc(authDoc, providers);
    const needsSqlite = providers.some((p) => !agentAuthSqliteHasProvider(dbPath, p))
      || !existsSync(dbPath)
      || !readAgentAuthProfileSqlitePrimary(dbPath);
    if (changed || needsSqlite || providers.length > 0) {
      const ok = syncAgentAuthProfileSqlite(dbPath, merged);
      results.push({ agentId, synced: ok, changed, needsSqlite });
    }
  }
  return results;
}
