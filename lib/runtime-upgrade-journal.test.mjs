import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import test from 'node:test';
import {
  beginRuntimeUpgradeState,
  isRuntimeUpgradeActive,
  patchRuntimeUpgradeState,
  readRuntimeUpgradeState,
} from './runtime-upgrade-journal.mjs';

test('runtime upgrade journal is atomic, durable, and patchable', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'trooper-upgrade-'));
  const statePath = path.join(directory, 'state.json');
  try {
    beginRuntimeUpgradeState({ operationId: 'upgrade-1', scope: 'bridge', target: { version: '2' } }, statePath);
    assert.equal(readRuntimeUpgradeState(statePath).status, 'staging');
    patchRuntimeUpgradeState({ status: 'verifying', phase: 'health_checks' }, statePath);
    const state = readRuntimeUpgradeState(statePath);
    assert.equal(state.operationId, 'upgrade-1');
    assert.equal(state.status, 'verifying');
    assert.equal(state.phase, 'health_checks');
    assert.ok(state.updatedAt);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('only unfinished lifecycle states are active', () => {
  assert.equal(isRuntimeUpgradeActive({ status: 'staging' }), true);
  assert.equal(isRuntimeUpgradeActive({ status: 'verifying' }), true);
  assert.equal(isRuntimeUpgradeActive({ status: 'completed' }), false);
  assert.equal(isRuntimeUpgradeActive({ status: 'rolled_back' }), false);
});
