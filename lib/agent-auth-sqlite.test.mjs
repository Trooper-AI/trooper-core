import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  LOCAL_PROVIDER_AUTH_KEY,
  ensureLocalProvidersInAuthDoc,
  migrateAllAgentAuthJsonToSqlite,
  readAgentAuthProfileSqlitePrimary,
  agentAuthSqliteHasProvider,
  syncAgentAuthProfileSqlite,
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
