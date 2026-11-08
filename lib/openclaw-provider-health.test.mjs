import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OpenClawProviderHealthManager,
  buildOpenClawProviderStatusCliArgs,
  buildOpenClawProviderStatusDockerArgs,
} from './openclaw-provider-health.mjs';

const status = JSON.stringify({
  auth: { oauth: { providers: [], profiles: [] } },
  probes: { results: [] },
});

test('app-pool provider status invokes the OpenClaw CLI with canonical OpenAI OAuth identifiers', async () => {
  const calls = [];
  const manager = new OpenClawProviderHealthManager({
    containerName: 'openclaw-gateway',
    appPool: true,
    cliPath: '/opt/openclaw/dist/index.js',
    execFile: async (...call) => {
      calls.push(call);
      return { stdout: status, stderr: '' };
    },
  });

  const result = await manager.run({ provider: 'openai-codex', profileId: 'openai-codex:account-1', probe: true });

  assert.equal(result.ok, true);
  assert.deepEqual(calls[0][0], process.execPath);
  assert.deepEqual(calls[0][1], [
    '/opt/openclaw/dist/index.js',
    'models', 'status', '--json', '--probe', '--probe-provider', 'openai',
    '--probe-profile', 'openai:codex-account-1', '--probe-max-tokens', '1', '--probe-timeout', '15000',
  ]);
  assert.equal(calls[0][2].cwd, '/opt/openclaw/dist');
  assert.equal(calls[0][2].env.HOME, '/home/node');
});

test('app-pool provider CLI args reject missing or relative executable paths', () => {
  assert.throws(
    () => buildOpenClawProviderStatusCliArgs({ cliPath: '', provider: 'openai-codex', probe: true }),
    { code: 'OPENCLAW_PROVIDER_CLI_UNAVAILABLE' },
  );
  assert.throws(
    () => buildOpenClawProviderStatusCliArgs({ cliPath: 'dist/index.js', provider: 'openai-codex', probe: true }),
    { code: 'OPENCLAW_PROVIDER_CLI_UNAVAILABLE' },
  );
  assert.deepEqual(
    buildOpenClawProviderStatusCliArgs({
      cliPath: '/opt/openclaw/dist/index.js',
      provider: 'openai-codex',
      profileId: 'openai-codex:account-1',
      probe: true,
    }),
    [
      '/opt/openclaw/dist/index.js',
      'models', 'status', '--json', '--probe', '--probe-provider', 'openai',
      '--probe-profile', 'openai:codex-account-1', '--probe-max-tokens', '1', '--probe-timeout', '15000',
    ],
  );
});

test('separate-container provider status keeps the docker exec path', () => {
  assert.deepEqual(
    buildOpenClawProviderStatusDockerArgs({
      containerName: 'openclaw-gateway',
      provider: 'openai-codex',
      probe: true,
    }),
    [
      'exec', '-u', 'node', '-w', '/home/node', '-e', 'HOME=/home/node', 'openclaw-gateway',
      'timeout', '--foreground', '--signal=TERM', '--kill-after=5s', '30s',
      'openclaw', 'models', 'status', '--json', '--probe', '--probe-provider', 'openai',
      '--probe-max-tokens', '1', '--probe-timeout', '15000',
    ],
  );
});

test('app-pool live checks load saved provider keys beside the configured OpenClaw config', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'provider-health-env-'));
  const configPath = path.join(directory, 'openclaw.json');
  writeFileSync(configPath, JSON.stringify({ agents: { defaults: {} } }));
  writeFileSync(path.join(directory, '.env'), 'OPENROUTER_API_KEY=stored-test-key\n');
  const calls = [];
  try {
    const manager = new OpenClawProviderHealthManager({
      containerName: 'openclaw-gateway',
      appPool: true,
      cliPath: '/opt/openclaw/dist/index.js',
      configPath,
      envPath: '/opt/openclaw/.env',
      execFile: async (...call) => {
        calls.push(call);
        return { stdout: status, stderr: '' };
      },
    });
    await manager.run({ provider: 'openrouter', profileId: 'openrouter:default', model: 'openrouter/example/model', probe: true });
    assert.equal(calls[0][2].env.OPENROUTER_API_KEY, 'stored-test-key');
    assert.equal(calls[0][2].env.HOME, '/home/node');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

