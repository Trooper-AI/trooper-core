import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LOCAL_PROVIDER_AUTH_KEY,
  ensureLocalProvidersInAuthDoc,
  migrateAllAgentAuthJsonToSqlite,
  readAgentAuthProfileSqlitePrimary,
  agentAuthSqliteHasProvider,
  syncAgentAuthProfileSqlite,
  readSharedAuthProfileSqlite,
  syncSharedAuthProfileSqlite,
} from './agent-auth-sqlite.mjs';

test('ensureLocalProvidersInAuthDoc adds synthetic local-llamacpp key', () => {
  const { authDoc, changed } = ensureLocalProvidersInAuthDoc({}, ['local-llamacpp']);
  assert.equal(changed, true);
  assert.deepEqual(authDoc.profiles['local-llamacpp:default'], {
    type: 'api_key',
    provider: 'local-llamacpp',
    key: LOCAL_PROVIDER_AUTH_KEY,
  });
  assert.equal(authDoc.lastGood['local-llamacpp'], 'local-llamacpp:default');
});

test('sync + migrate write sqlite primary store for main agent', () => {
  const root = mkdtempSync(join(tmpdir(), 'trooper-auth-'));
  try {
    const agentDir = join(root, 'main', 'agent');
    mkdirSync(agentDir, { recursive: true });
    const authDoc = {
      version: 1,
      profiles: {
        'local-llamacpp:default': {
          type: 'api_key',
          provider: 'local-llamacpp',
          key: LOCAL_PROVIDER_AUTH_KEY,
        },
      },
      lastGood: { 'local-llamacpp': 'local-llamacpp:default' },
    };
    writeFileSync(join(agentDir, 'auth-profiles.json'), JSON.stringify(authDoc));
    const dbPath = join(agentDir, 'openclaw-agent.sqlite');
    assert.equal(syncAgentAuthProfileSqlite(dbPath, authDoc), true);
    assert.equal(agentAuthSqliteHasProvider(dbPath, 'local-llamacpp'), true);
    const store = readAgentAuthProfileSqlitePrimary(dbPath);
    assert.equal(store.profiles['local-llamacpp:default'].key, LOCAL_PROVIDER_AUTH_KEY);

    const migrated = migrateAllAgentAuthJsonToSqlite({
      agentsRoot: root,
      providers: ['local-llamacpp'],
    });
    assert.ok(migrated.some((row) => row.agentId === 'main' && row.synced));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shared auth store is read and synced without dropping usage stats', () => {
  const root = mkdtempSync(join(tmpdir(), 'trooper-shared-auth-'));
  try {
    const dbPath = join(root, 'openclaw.sqlite');
    execFileSync('python3', ['-c', `
import sqlite3, sys, json
con=sqlite3.connect(sys.argv[1])
con.execute('CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at_ms INTEGER NOT NULL)')
rows={
 'auth.sharedStore': {'location':'state-db'},
 'authProfiles.store': {'version':1,'profiles':{'openrouter:default':{'type':'api_key','provider':'openrouter','key':'redacted-test-secret'}},'lastGood':{}},
 'authProfiles.state': {'version':1,'lastGood':{'openrouter':'openrouter:default'},'usageStats':{'openrouter:default':{'errorCount':2}}},
}
for key, value in rows.items(): con.execute('INSERT INTO config_machine_state VALUES (?,?,1)', (key,json.dumps(value)))
con.commit(); con.close()
`, dbPath]);

    const initial = readSharedAuthProfileSqlite(dbPath);
    assert.equal(initial.location, 'state-db');
    assert.equal(initial.store.profiles['openrouter:default'].provider, 'openrouter');
    assert.deepEqual(initial.store.lastGood, { openrouter: 'openrouter:default' });

    const next = {
      version: 1,
      profiles: {
        'openai-codex:default': {
          type: 'oauth',
          provider: 'openai-codex',
          access: 'test-access-token',
          refresh: 'test-refresh-token',
        },
      },
      lastGood: { 'openai-codex': 'openai-codex:default' },
    };
    assert.equal(syncSharedAuthProfileSqlite(dbPath, next), true);
    const after = readSharedAuthProfileSqlite(dbPath);
    assert.deepEqual(after.store.profiles, next.profiles);
    assert.deepEqual(after.state.lastGood, next.lastGood);
    assert.deepEqual(after.state.usageStats, {
      'openrouter:default': { errorCount: 2 },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
