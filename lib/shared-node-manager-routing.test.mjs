import test from 'node:test';
import assert from 'node:assert/strict';

const {
  isPublicBridgeRuntimePath,
  resolveProxyTarget,
} = await import('./shared-node-routing.mjs');

const slot = {
  ports: {
    bridge: 32000,
    gateway: 33000,
  },
};

test('shared workspace health routes go to the slot bridge without manager auth', () => {
  for (const suffix of ['/health', '/healthz', '/readyz']) {
    assert.equal(isPublicBridgeRuntimePath(suffix), true);
    assert.deepEqual(resolveProxyTarget({ slot, suffix, headers: {}, authToken: 'manager-token' }), {
      routeToBridge: true,
      targetPort: 32000,
    });
  }
});

test('missing manager auth configuration never grants bridge access', () => {
  assert.deepEqual(resolveProxyTarget({ slot, suffix: '/files', headers: {}, authToken: '' }), {
    error: 'unauthorized',
  });
});

test('shared workspace bridge routes require manager auth', () => {
  for (const suffix of [
    '/files',
    '/skills',
    '/logs',
    '/api/memories',
    '/ws',
    '/stats',
    '/system-stats',
    '/version',
    '/config/api-keys',
  ]) {
    assert.equal(isPublicBridgeRuntimePath(suffix), false);
    assert.deepEqual(resolveProxyTarget({ slot, suffix, headers: {}, authToken: 'manager-token' }), {
      error: 'unauthorized',
    });
    assert.deepEqual(resolveProxyTarget({
      slot,
      suffix,
      headers: { authorization: 'Bearer manager-token' },
      authToken: 'manager-token',
    }), {
      routeToBridge: true,
      targetPort: 32000,
    });
  }
});

test('shared workspace gateway routes stay on the slot gateway', () => {
  assert.deepEqual(resolveProxyTarget({ slot, suffix: '/chat?session=main', headers: {}, authToken: 'manager-token' }), {
    routeToBridge: false,
    targetPort: 33000,
  });
});
