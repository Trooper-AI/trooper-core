import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDirectFileAccessToken,
  deriveFileAccessSecret,
  verifyDirectFileAccessToken,
} from './file-access-token.mjs';

const GOLDEN = {
  bridgeAuthToken: 'golden-bridge-token',
  orgId: 'org_golden',
  userId: 'user_golden',
  pathPrefix: '/files/Videos/',
  now: 1700000000000,
  ttlMs: 300000,
  // Cross-repo parity: Trooper server/lib/direct-file-token.test.js asserts
  // the exact same token string. If this changes, both repos must change.
  token: 'eyJhdWQiOiJ0cm9vcGVyLWRpcmVjdC1maWxlcyIsIm9yZ0lkIjoib3JnX2dvbGRlbiIsInVzZXJJZCI6InVzZXJfZ29sZGVuIiwicGF0aFByZWZpeCI6Ii9maWxlcy9WaWRlb3MvIiwiaXNzdWVkQXQiOjE3MDAwMDAwMDAwMDAsImV4cGlyZXNBdCI6MTcwMDAwMDMwMDAwMH0.TW_-VBeUJwUWittc2B8lbm7G6efR62C3HlRhdDk1dFw',
};

test('golden vector: token generation is stable across repos', () => {
  const { token, expiresAt } = createDirectFileAccessToken(GOLDEN);
  assert.equal(token, GOLDEN.token);
  assert.equal(expiresAt, 1700000300000);
});

test('roundtrip verification with path prefix enforcement', () => {
  const { token } = createDirectFileAccessToken(GOLDEN);
  const inScope = verifyDirectFileAccessToken(token, {
    bridgeAuthToken: GOLDEN.bridgeAuthToken,
    path: '/files/Videos/render.mp4',
    now: GOLDEN.now + 1000,
  });
  assert.equal(inScope.userId, 'user_golden');
  const outOfScope = verifyDirectFileAccessToken(token, {
    bridgeAuthToken: GOLDEN.bridgeAuthToken,
    path: '/files/secrets.env',
    now: GOLDEN.now + 1000,
  });
  assert.equal(outOfScope, null);
});

test('expired, tampered, and wrong-key tokens are rejected', () => {
  const { token } = createDirectFileAccessToken(GOLDEN);
  assert.equal(verifyDirectFileAccessToken(token, {
    bridgeAuthToken: GOLDEN.bridgeAuthToken,
    now: GOLDEN.now + 301_000,
  }), null);
  assert.equal(verifyDirectFileAccessToken(`${token}x`, {
    bridgeAuthToken: GOLDEN.bridgeAuthToken,
    now: GOLDEN.now,
  }), null);
  assert.equal(verifyDirectFileAccessToken(token, {
    bridgeAuthToken: 'different-bridge-token',
    now: GOLDEN.now,
  }), null);
});

test('no bridge token means no signing and no verification', () => {
  assert.equal(deriveFileAccessSecret(''), null);
  assert.throws(() => createDirectFileAccessToken({ ...GOLDEN, bridgeAuthToken: '' }), /bridge auth token/);
  assert.equal(verifyDirectFileAccessToken(GOLDEN.token, { bridgeAuthToken: '' }), null);
});
