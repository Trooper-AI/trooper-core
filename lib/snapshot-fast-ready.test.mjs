import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { snapshotFastReadyStatus } from './snapshot-fast-ready.mjs';

const bridgeSource = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');

test('snapshot readiness is visible only to an active snapshot bake', () => {
  assert.deepEqual(snapshotFastReadyStatus({ enabled: false, markerExists: true }), {
    status: 404,
    body: { error: 'not_found' },
  });
});

test('snapshot readiness stays pending until setup writes the fast-ready marker', () => {
  assert.deepEqual(snapshotFastReadyStatus({ enabled: true, markerExists: false }), {
    status: 503,
    body: { ready: false },
  });
  assert.deepEqual(snapshotFastReadyStatus({ enabled: true, markerExists: true }), {
    status: 200,
    body: { ready: true },
  });
});

test('snapshot fast-ready endpoint is bridge-authenticated and reads the durable bake marker', () => {
  const start = bridgeSource.indexOf("app.get('/snapshot-fast-ready'");
  const end = bridgeSource.indexOf("app.get('/health'", start);
  const route = bridgeSource.slice(start, end);

  assert.ok(start >= 0 && end > start, 'snapshot fast-ready route must be present');
  assert.match(route, /requireBridgeAuth\(req, res\)/);
  assert.match(route, /TROOPER_SNAPSHOT_BUILD.*ORG_ID.*snapshot-builder/s);
  assert.match(route, /\/tmp\/trooper-snapshot-fast-ready/);
  assert.match(route, /snapshotFastReadyStatus/);
});
