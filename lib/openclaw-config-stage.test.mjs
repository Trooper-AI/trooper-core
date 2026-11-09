import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stageTool = path.join(root, 'openclaw-config-stage.mjs');

function runStage(args) {
  return spawnSync(process.execPath, [stageTool, ...args], { encoding: 'utf8' });
}

test('managed ACP config can be parked and restored without restoring retired schema', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trooper-openclaw-stage-'));
  const configPath = path.join(tempRoot, 'openclaw.json');
  const sidecarPath = path.join(tempRoot, 'managed-plugin-config.json');
  const config = {
    agents: { defaults: { maxConcurrent: 4 } },
    acp: {
      enabled: true,
      backend: 'acpx',
      defaultAgent: 'claude',
      allowedAgents: ['claude', 'codex'],
      maxConcurrentSessions: 3,
      permissions: { legacy: true },
      sessionTimeout: 60,
      dispatch: { enabled: true, prefix: '/legacy' },
    },
    plugins: {
      entries: {
        acpx: { enabled: true, config: { nonInteractivePermissions: 'deny' } },
        lobster: { enabled: true },
        telegram: { enabled: true },
      },
    },
    gateway: { auth: { token: 'fixture-secret' } },
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });

  const parked = runStage(['park', configPath, sidecarPath]);
  assert.equal(parked.status, 0, parked.stderr);
  const stagedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  assert.equal(stagedConfig.acp, undefined);
  assert.deepEqual(Object.keys(stagedConfig.plugins.entries), ['telegram']);
  assert.deepEqual(Object.keys(sidecar.entries).sort(), ['acpx', 'lobster']);
  assert.equal(sidecar.acp.maxConcurrentSessions, 3);
  assert.equal(fs.statSync(sidecarPath).mode & 0o777, 0o600);
  assert.doesNotMatch(`${parked.stdout}${parked.stderr}`, /fixture-secret/);

  stagedConfig.agents.defaults.maxConcurrent = 5;
  fs.writeFileSync(configPath, `${JSON.stringify(stagedConfig, null, 2)}\n`, { mode: 0o600 });
  const restored = runStage(['restore', configPath, sidecarPath]);
  assert.equal(restored.status, 0, restored.stderr);
  const finalConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(finalConfig.acp.enabled, true);
  assert.deepEqual(finalConfig.acp.allowedAgents, ['claude', 'codex']);
  assert.equal(finalConfig.acp.maxConcurrentSessions, undefined);
  assert.equal(finalConfig.acp.permissions, undefined);
  assert.equal(finalConfig.acp.sessionTimeout, undefined);
  assert.deepEqual(finalConfig.acp.dispatch, { enabled: true });
  assert.equal(finalConfig.plugins.entries.acpx.config.nonInteractivePermissions, 'deny');
  assert.deepEqual(finalConfig.plugins.entries.lobster, { enabled: true });
  assert.deepEqual(finalConfig.plugins.entries.telegram, { enabled: true });
  assert.equal(finalConfig.agents.defaults.maxConcurrent, 5);
  assert.equal(finalConfig.gateway.auth.token, 'fixture-secret');
});

test('plugin checks use installed package metadata without loading plugin runtime', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trooper-openclaw-plugin-'));
  const configPath = path.join(tempRoot, 'openclaw.json');
  const packagePath = path.join(tempRoot, 'npm/projects/acpx/node_modules/@openclaw/acpx/package.json');
  fs.mkdirSync(path.dirname(packagePath), { recursive: true });
  fs.writeFileSync(packagePath, JSON.stringify({ name: '@openclaw/acpx', version: '2026.11.1' }));
  fs.writeFileSync(configPath, JSON.stringify({ acp: { enabled: true, backend: 'acpx' } }));

  const version = runStage(['plugin-version', tempRoot, '@openclaw/acpx']);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, '2026.11.1');

  const enabled = runStage(['plugin-enabled', configPath, 'acpx']);
  assert.equal(enabled.status, 0, enabled.stderr);
  const matching = runStage(['assert-plugin-version', configPath, 'acpx', '2026.11.1']);
  assert.equal(matching.status, 0, matching.stderr);
  const mismatch = runStage(['assert-plugin-version', configPath, 'acpx', '2026.11.2']);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /acpx package version is 2026\.11\.1/);
});
