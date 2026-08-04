import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acpParentSessionKey,
  isAcpConversationBindingsUnavailableError,
  isConversationBindCapableSession,
  resolveAcpControlSessionKey,
  resolveAcpSpawnBindMode,
} from './acp-spawn-host.mjs';

test('dedicated ACP control keys are per-channel and not chat session keys', () => {
  assert.equal(
    acpParentSessionKey('coding'),
    'agent:main:hook:trooper:acp:channel:coding',
  );
  assert.equal(
    acpParentSessionKey('#Coding Room!'),
    'agent:main:hook:trooper:acp:channel:coding-room',
  );
});

test('Trooper hook/webchat sessions cannot host conversation bindings', () => {
  assert.equal(
    isConversationBindCapableSession('agent:main:hook:trooper:jordan:channel:coding'),
    false,
  );
  assert.equal(
    isConversationBindCapableSession('agent:main:hook:trooper:acp:channel:coding'),
    false,
  );
  assert.equal(isConversationBindCapableSession('agent:main'), false);
  assert.equal(isConversationBindCapableSession('agent:main:webchat'), false);
  assert.equal(
    isConversationBindCapableSession('agent:main:discord:channel:dev'),
    true,
  );
});

test('resolveAcpControlSessionKey ignores Trooper chat hosts', () => {
  assert.equal(
    resolveAcpControlSessionKey({
      requestedParentSessionKey: 'agent:main:hook:trooper:jordan:channel:coding',
      channel: 'coding',
    }),
    'agent:main:hook:trooper:acp:channel:coding',
  );
  assert.equal(
    resolveAcpControlSessionKey({
      requestedParentSessionKey: '',
      channel: 'coding',
    }),
    'agent:main:hook:trooper:acp:channel:coding',
  );
  assert.equal(
    resolveAcpControlSessionKey({
      requestedParentSessionKey: 'agent:main:discord:channel:dev',
      channel: 'coding',
    }),
    'agent:main:discord:channel:dev',
  );
});

test('Trooper ACP hosts spawn with --bind off', () => {
  assert.equal(
    resolveAcpSpawnBindMode('agent:main:hook:trooper:acp:channel:coding'),
    'off',
  );
  assert.equal(
    resolveAcpSpawnBindMode('agent:main:discord:channel:dev'),
    'here',
  );
});

test('bindings-unavailable errors are detected for spawn retries', () => {
  assert.equal(
    isAcpConversationBindingsUnavailableError(
      '⚠️ Conversation bindings are unavailable for webchat.',
    ),
    true,
  );
  assert.equal(
    isAcpConversationBindingsUnavailableError('spawned agent:main:acp:abc'),
    false,
  );
});
