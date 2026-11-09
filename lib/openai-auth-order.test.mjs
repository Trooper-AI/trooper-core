import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOpenAiAuthOrder } from './openai-auth-order.mjs';

const oauth = (email) => ({ type: 'oauth', provider: 'openai', access: `token-${email}`, email });

test('places the selected Codex account first and retains usable account failover', () => {
  const authDoc = {
    lastGood: { openai: 'openai:codex-new' },
    profiles: {
      'openai:codex-old': oauth('old@example.test'),
      'openai:codex-new': oauth('new@example.test'),
      'openai:codex-third': oauth('third@example.test'),
    },
  };

  assert.deepEqual(
    buildOpenAiAuthOrder(authDoc, ['openai:codex-old', 'openai:codex-removed']),
    ['openai:codex-new', 'openai:codex-old', 'openai:codex-third'],
  );
});

test('repairs a stale explicit order by including newly saved OAuth profiles', () => {
  const authDoc = {
    lastGood: { openai: 'openai-codex:fresh' },
    profiles: {
      'openai:codex-fresh': oauth('fresh@example.test'),
      'openai:codex-backup': oauth('backup@example.test'),
    },
  };

  assert.deepEqual(
    buildOpenAiAuthOrder(authDoc, ['openai:codex-deleted']),
    ['openai:codex-fresh', 'openai:codex-backup'],
  );
});

test('does not add an API key that is absent from the configured route', () => {
  const authDoc = {
    lastGood: { openai: 'openai:codex-active' },
    profiles: {
      'openai:codex-active': oauth('active@example.test'),
      'openai:codex-backup': oauth('backup@example.test'),
      'openai:default': { type: 'api_key', provider: 'openai', key: 'secret' },
    },
  };

  assert.deepEqual(
    buildOpenAiAuthOrder(authDoc, ['openai:codex-active']),
    ['openai:codex-active', 'openai:codex-backup'],
  );
});

test('keeps a configured API key after subscription accounts', () => {
  const authDoc = {
    lastGood: { openai: 'openai:codex-active' },
    profiles: {
      'openai:codex-active': oauth('active@example.test'),
      'openai:codex-backup': oauth('backup@example.test'),
      'openai:default': { type: 'api_key', provider: 'openai', key: 'secret' },
    },
  };

  assert.deepEqual(
    buildOpenAiAuthOrder(authDoc, ['openai:default', 'openai:codex-active']),
    ['openai:codex-active', 'openai:codex-backup', 'openai:default'],
  );
});

test('keeps the actual legacy key when no canonical auth profile exists', () => {
  const authDoc = {
    lastGood: { openai: 'openai-codex:legacy' },
    profiles: {
      'openai-codex:legacy': { ...oauth('legacy@example.test'), provider: 'openai-codex' },
    },
  };

  assert.deepEqual(buildOpenAiAuthOrder(authDoc, ['openai-codex:legacy']), ['openai-codex:legacy']);
});

test('does not route the legacy duplicate when its canonical account exists', () => {
  const legacy = { ...oauth('same@example.test'), provider: 'openai-codex', accountId: 'acct-same' };
  const canonical = { ...legacy, provider: 'openai' };
  const authDoc = {
    lastGood: { openai: 'openai:codex-same' },
    profiles: {
      'openai-codex:same': legacy,
      'openai:codex-same': canonical,
    },
  };

  assert.deepEqual(
    buildOpenAiAuthOrder(authDoc, ['openai-codex:same']),
    ['openai:codex-same'],
  );
});

test('returns only explicit, usable API-key profiles after OAuth removal', () => {
  const authDoc = {
    profiles: {
      'openai:default': { type: 'api_key', provider: 'openai', key: 'secret' },
      'openai:empty': { type: 'api_key', provider: 'openai', key: '' },
    },
  };

  assert.deepEqual(buildOpenAiAuthOrder(authDoc, ['openai:default', 'openai:empty']), ['openai:default']);
});
