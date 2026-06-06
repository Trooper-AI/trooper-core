import test from 'node:test';
import assert from 'node:assert/strict';

const {
  isUserBridgeRuntimePath,
  resolveProxyTarget,
} = await import('./shared-node-routing.mjs');

const slot = {
  ports: {
    bridge: 32000,
    gateway: 33000,
  },
};

test('shared workspace user routes go to the slot bridge without manager auth', () => {
  for (const suffix of ['/files', '/skills', '/logs', '/api/memories', '/ws']) {
    assert.equal(isUserBridgeRuntimePath(suffix), true);
    assert.deepEqual(resolveProxyTarget({ slot, suffix, headers: {}, authToken: 'manager-token' }), {
      routeToBridge: true,
      targetPort: 32000,
    });
  }
});

test('shared workspace admin routes still require manager auth', () => {
  assert.deepEqual(resolveProxyTarget({ slot, suffix: '/config/api-keys', headers: {}, authToken: 'manager-token' }), {
    error: 'unauthorized',
  });
  assert.deepEqual(resolveProxyTarget({
    slot,
    suffix: '/config/api-keys',
    headers: { authorization: 'Bearer manager-token' },
    authToken: 'manager-token',
  }), {
    routeToBridge: true,
    targetPort: 32000,
  });
});

test('shared workspace gateway routes stay on the slot gateway', () => {
  assert.deepEqual(resolveProxyTarget({ slot, suffix: '/chat?session=main', headers: {}, authToken: 'manager-token' }), {
    routeToBridge: false,
    targetPort: 33000,
  });
});
