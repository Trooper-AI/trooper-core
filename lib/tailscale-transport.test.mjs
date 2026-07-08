import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTailscaleTransportInput } from './tailscale-transport.mjs';

test('normalizes a valid Tailscale transport request', () => {
  assert.deepEqual(normalizeTailscaleTransportInput({
    authKey: 'tskey-auth-abcdefghijklmnop',
    hostname: ' Trooper-Work ',
    tags: 'tag:trooper, tag:local-model',
  }), {
    authKey: 'tskey-auth-abcdefghijklmnop',
    hostname: 'trooper-work',
    tags: 'tag:trooper,tag:local-model',
  });
});

test('rejects invalid Tailscale transport values', () => {
  assert.throws(() => normalizeTailscaleTransportInput({ authKey: 'nope' }), /valid Tailscale auth key/);
  assert.throws(
    () => normalizeTailscaleTransportInput({
      authKey: 'tskey-auth-abcdefghijklmnop',
      hostname: 'bad hostname',
    }),
    /hostname/,
  );
  assert.throws(
    () => normalizeTailscaleTransportInput({
      authKey: 'tskey-auth-abcdefghijklmnop',
      tags: 'trooper',
    }),
    /tags/,
  );
});
