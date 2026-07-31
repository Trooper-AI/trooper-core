import test from 'node:test';
import assert from 'node:assert/strict';
import { BRIDGE_AUTH_UNCONFIGURED_ERROR, evaluateBridgeAuth } from './bridge-auth.mjs';

test('unconfigured token fails closed with a 503 naming the escape hatch', () => {
  const result = evaluateBridgeAuth({ configuredToken: '', authorizationHeader: 'Bearer anything' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.equal(result.body.error, BRIDGE_AUTH_UNCONFIGURED_ERROR);
  assert.match(result.body.message, /BRIDGE_ALLOW_UNAUTHENTICATED_DEV=1/);
});

test('unconfigured token passes only with the explicit dev opt-in', () => {
  const result = evaluateBridgeAuth({ configuredToken: '', allowUnauthenticatedDev: true });
  assert.deepEqual(result, { ok: true, mode: 'unauthenticated_dev' });
});

test('dev opt-in does not bypass a configured token', () => {
  const result = evaluateBridgeAuth({
    configuredToken: 'secret',
    authorizationHeader: 'Bearer wrong',
    allowUnauthenticatedDev: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});

test('wrong token is a 401 with the shared-node-manager response shape', () => {
  const result = evaluateBridgeAuth({ configuredToken: 'secret', authorizationHeader: 'Bearer nope' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.deepEqual(Object.keys(result.body).sort(), ['error', 'message']);
  assert.equal(result.body.error, 'unauthorized');
});

test('matching token passes with and without the Bearer prefix', () => {
  assert.equal(evaluateBridgeAuth({ configuredToken: 'secret', authorizationHeader: 'Bearer secret' }).ok, true);
  assert.equal(evaluateBridgeAuth({ configuredToken: 'secret', authorizationHeader: 'secret' }).ok, true);
});

test('missing authorization header against a configured token is a 401', () => {
  const result = evaluateBridgeAuth({ configuredToken: 'secret' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
});
