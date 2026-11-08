import test from 'node:test';
import assert from 'node:assert/strict';
import { addCanonicalOpenAiOAuthProfiles } from './canonical-openai-auth.mjs';

test('adds a canonical OAuth profile without replacing the OpenAI API-key profile', () => {
  const auth = {
    version: 1,
    profiles: {
      'openai:default': { type: 'api_key', provider: 'openai', key: 'keep-me' },
      'openai-codex:default': { type: 'oauth', provider: 'openai-codex', access: 'access', refresh: 'refresh', email: 'person@example.com' },
    },
    lastGood: { openai: 'openai:default', 'openai-codex': 'openai-codex:default' },
  };

  const result = addCanonicalOpenAiOAuthProfiles(auth);
  assert.equal(result.changed, true);
  assert.deepEqual(result.migrated, [{ from: 'openai-codex:default', to: 'openai:codex-default' }]);
  assert.deepEqual(result.authDoc.profiles['openai:default'], auth.profiles['openai:default']);
  assert.equal(result.authDoc.profiles['openai:codex-default'].provider, 'openai');
  assert.equal(result.authDoc.profiles['openai:codex-default'].email, 'person@example.com');
  assert.equal(result.authDoc.profiles['openai-codex:default'].provider, 'openai-codex');
  assert.equal(result.authDoc.lastGood.openai, 'openai:codex-default');
});

test('is idempotent and does not replace a canonical OAuth profile on later restarts', () => {
  const auth = {
    profiles: {
      'openai-codex:default': { type: 'oauth', provider: 'openai-codex', access: 'old-access', refresh: 'old-refresh', email: 'person@example.com' },
      'openai:codex-default': { type: 'oauth', provider: 'openai', access: 'refreshed-access', refresh: 'refreshed-refresh', email: 'person@example.com' },
    },
    lastGood: { openai: 'openai:codex-default' },
  };

  const result = addCanonicalOpenAiOAuthProfiles(auth);
  assert.equal(result.changed, false);
  assert.equal(result.authDoc.profiles['openai:codex-default'].access, 'refreshed-access');
});

test('migrates OAuth saved at openai:default while leaving an API-key default untouched', () => {
  const auth = {
    profiles: {
      'openai:default': { type: 'oauth', provider: 'openai', access: 'access', refresh: 'refresh', email: 'person@example.com' },
    },
    lastGood: { openai: 'openai:default' },
  };
  const result = addCanonicalOpenAiOAuthProfiles(auth);
  assert.deepEqual(result.migrated, [{ from: 'openai:default', to: 'openai:codex-default' }]);
  assert.equal(result.authDoc.lastGood.openai, 'openai:codex-default');
  assert.equal(result.authDoc.profiles['openai:default'].type, 'oauth');
});

test('keeps an existing canonical profile when a different OAuth identity collides', () => {
  const auth = {
    profiles: {
      'openai-codex:default': { type: 'oauth', provider: 'openai-codex', access: 'other', refresh: 'other', email: 'other@example.com' },
      'openai:codex-default': { type: 'oauth', provider: 'openai', access: 'current', refresh: 'current', email: 'current@example.com' },
    },
    lastGood: { openai: 'openai-codex:default', 'openai-codex': 'openai-codex:default' },
  };
  const result = addCanonicalOpenAiOAuthProfiles(auth);
  assert.equal(result.authDoc.profiles['openai:codex-default'].email, 'current@example.com');
  const migratedId = result.migrated[0].to;
  assert.match(migratedId, /^openai:codex-default-[a-f0-9]{10}$/);
  assert.equal(result.authDoc.profiles[migratedId].email, 'other@example.com');
  assert.equal(result.authDoc.lastGood.openai, migratedId);
  assert.equal(result.authDoc.lastGood['openai-codex'], undefined);
});
