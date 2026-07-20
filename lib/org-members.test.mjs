import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  __resetOrgMembersCache,
  isOrgMember,
  orgMemberRole,
  readOrgMembers,
  writeOrgMembers,
} from './org-members.mjs';
import { applyRuntimeEnvOverrides, loadRuntimeEnvOverridesAtBoot, readRuntimeEnvOverrides } from './runtime-env-overrides.mjs';

function tempPath(name) {
  return join(mkdtempSync(join(tmpdir(), 'trooper-test-')), name);
}

test('membership is fail-closed until a list is synced', () => {
  __resetOrgMembersCache();
  const statePath = tempPath('members.json');
  assert.equal(isOrgMember('uid-1', statePath), false);
  writeOrgMembers({ orgId: 'org_1', revision: 1, members: [{ uid: 'uid-1', role: 'owner', email: 'a@b.c' }] }, statePath);
  assert.equal(isOrgMember('uid-1', statePath), true);
  assert.equal(isOrgMember('uid-2', statePath), false);
  assert.equal(orgMemberRole('uid-1', statePath), 'owner');
});

test('stale revisions never roll back a newer member list', () => {
  __resetOrgMembersCache();
  const statePath = tempPath('members.json');
  writeOrgMembers({ orgId: 'org_1', revision: 5, members: [{ uid: 'uid-new' }] }, statePath);
  const result = writeOrgMembers({ orgId: 'org_1', revision: 3, members: [{ uid: 'uid-old' }] }, statePath);
  assert.equal(result.ignored, true);
  assert.equal(isOrgMember('uid-new', statePath), true);
  assert.equal(isOrgMember('uid-old', statePath), false);
});

test('member entries are normalized and malformed entries dropped', () => {
  __resetOrgMembersCache();
  const statePath = tempPath('members.json');
  writeOrgMembers({ revision: 1, members: [{ uid: 'u1' }, null, 'junk', { role: 'no-uid' }] }, statePath);
  const state = readOrgMembers(statePath);
  assert.equal(state.members.length, 1);
  assert.equal(state.members[0].role, 'member');
});

test('runtime env overrides: allowlist enforced, persisted, applied at boot', () => {
  const statePath = tempPath('env.json');
  const env = {};
  const result = applyRuntimeEnvOverrides(
    { FIREBASE_PROJECT_ID: 'trooper-prod', BRIDGE_AUTH_TOKEN: 'evil', PATH: '/evil' },
    { statePath, env },
  );
  assert.deepEqual(result.applied, ['FIREBASE_PROJECT_ID']);
  assert.deepEqual(result.rejected.sort(), ['BRIDGE_AUTH_TOKEN', 'PATH']);
  assert.equal(env.FIREBASE_PROJECT_ID, 'trooper-prod');
  assert.equal(env.BRIDGE_AUTH_TOKEN, undefined);
  // Persisted file only carries allowlisted keys
  const persisted = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.deepEqual(Object.keys(persisted.values), ['FIREBASE_PROJECT_ID']);
  // Boot re-application never overwrites real env
  const bootEnv = { FIREBASE_PROJECT_ID: 'from-real-env' };
  loadRuntimeEnvOverridesAtBoot({ statePath, env: bootEnv });
  assert.equal(bootEnv.FIREBASE_PROJECT_ID, 'from-real-env');
  const emptyEnv = {};
  loadRuntimeEnvOverridesAtBoot({ statePath, env: emptyEnv });
  assert.equal(emptyEnv.FIREBASE_PROJECT_ID, 'trooper-prod');
  assert.deepEqual(readRuntimeEnvOverrides(statePath), { FIREBASE_PROJECT_ID: 'trooper-prod' });
});
