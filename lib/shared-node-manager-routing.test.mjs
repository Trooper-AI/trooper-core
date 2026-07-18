import test from 'node:test';
import assert from 'node:assert/strict';

const {
  authorizeSlotAccess,
  extractBearerToken,
  isPublicBridgeRuntimePath,
  listSlotScopedTokens,
  resolveProxyTarget,
} = await import('./shared-node-routing.mjs');

const slot = {
  slotId: 'org-a',
  bridgeAuthToken: 'slot-a-bridge',
  gatewayToken: 'slot-a-gateway',
  ports: {
    bridge: 32000,
    gateway: 33000,
  },
};

const otherSlot = {
  slotId: 'org-b',
  bridgeAuthToken: 'slot-b-bridge',
  gatewayToken: 'slot-b-gateway',
  ports: {
    bridge: 32001,
    gateway: 33001,
  },
};

test('extractBearerToken parses Authorization header', () => {
  assert.equal(extractBearerToken({ authorization: 'Bearer secret' }), 'secret');
  assert.equal(extractBearerToken({ Authorization: 'bearer other' }), 'other');
  assert.equal(extractBearerToken({}), '');
});

test('shared workspace health routes go to the slot bridge without manager auth', () => {
  for (const suffix of ['/health', '/healthz', '/readyz']) {
    assert.equal(isPublicBridgeRuntimePath(suffix), true);
    assert.deepEqual(resolveProxyTarget({ slot, suffix, headers: {}, authToken: 'manager-token' }), {
      routeToBridge: true,
      targetPort: 32000,
      authRole: 'public',
    });
  }
});

test('missing auth never grants private bridge access', () => {
  assert.deepEqual(resolveProxyTarget({ slot, suffix: '/files', headers: {}, authToken: 'manager-token' }), {
    error: 'unauthorized',
    reason: 'missing_token',
  });
});

test('manager token grants bridge access for any slot', () => {
  assert.deepEqual(resolveProxyTarget({
    slot,
    suffix: '/files',
    headers: { authorization: 'Bearer manager-token' },
    authToken: 'manager-token',
  }), {
    routeToBridge: true,
    targetPort: 32000,
    authRole: 'manager',
  });
});

test('slot bridge token grants access only to that slot', () => {
  assert.deepEqual(resolveProxyTarget({
    slot,
    suffix: '/files',
    headers: { authorization: 'Bearer slot-a-bridge' },
    authToken: 'manager-token',
  }), {
    routeToBridge: true,
    targetPort: 32000,
    authRole: 'slot',
  });

  // Cross-slot: org-b token must not open org-a proxy
  assert.deepEqual(resolveProxyTarget({
    slot,
    suffix: '/files',
    headers: { authorization: 'Bearer slot-b-bridge' },
    authToken: 'manager-token',
  }), {
    error: 'unauthorized',
    reason: 'cross_slot_or_invalid',
  });
});

test('authorizeSlotAccess requires manager for control ops', () => {
  assert.equal(authorizeSlotAccess({
    headers: { authorization: 'Bearer slot-a-bridge' },
    managerAuthToken: 'manager-token',
    slot,
    requireManager: true,
  }).ok, false);

  assert.equal(authorizeSlotAccess({
    headers: { authorization: 'Bearer manager-token' },
    managerAuthToken: 'manager-token',
    requireManager: true,
  }).ok, true);
});

test('listSlotScopedTokens de-dupes and ignores empties', () => {
  assert.deepEqual(listSlotScopedTokens({
    bridgeAuthToken: 'a',
    slotAuthToken: 'a',
    gatewayToken: 'g',
  }), ['a', 'g']);
});

test('shared workspace gateway routes stay on the slot gateway', () => {
  assert.deepEqual(resolveProxyTarget({
    slot,
    suffix: '/chat?session=main',
    headers: {},
    authToken: 'manager-token',
  }), {
    routeToBridge: false,
    targetPort: 33000,
    authRole: 'gateway',
  });
});

test('other slot object cannot authorize with foreign tokens via authorizeSlotAccess', () => {
  const denied = authorizeSlotAccess({
    headers: { authorization: 'Bearer slot-a-bridge' },
    managerAuthToken: 'manager-token',
    slot: otherSlot,
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, 'cross_slot_or_invalid');
});
