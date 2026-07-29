import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  OPENCODE_ACP_CONFIG_DIR,
  OPENCODE_ACP_CONFIG_PATH,
  OpenCodeAcpConfigManager,
  buildManagedOpenCodeAcpAgentConfig,
  buildOpenCodeAcpConfigDockerArgs,
  ensureManagedOpenCodeAcpAgentConfig,
  getManagedOpenCodeAcpAgentConfigState,
  normalizeOpenCodeAcpProvider,
} from './opencode-acp-config.mjs';

function runWriteScript({ provider, existingConfig } = {}) {
  const args = buildOpenCodeAcpConfigDockerArgs({
    containerName: 'openclaw-openclaw-gateway-1',
    action: 'configure',
    provider,
  });
  const files = new Map();
  if (existingConfig !== undefined) files.set(OPENCODE_ACP_CONFIG_PATH, existingConfig);
  const calls = { rename: 0, mkdir: 0 };
  const fs = {
    existsSync: (filePath) => files.has(filePath),
    readFileSync: (filePath) => files.get(filePath),
    mkdirSync: () => { calls.mkdir += 1; },
    openSync: (filePath, flags) => {
      assert.equal(flags, 'wx');
      files.set(filePath, '');
      return filePath;
    },
    writeFileSync: (descriptor, value) => files.set(descriptor, String(value)),
    fsyncSync: () => {},
    closeSync: () => {},
    renameSync: (from, to) => {
      calls.rename += 1;
      files.set(to, files.get(from));
      files.delete(from);
    },
  };
  const output = [];
  const errors = [];
  const process = {
    env: { TROOPER_OPENCODE_PROVIDER: provider },
    pid: 123,
    exitCode: 0,
    stdout: { write: (value) => output.push(String(value)) },
    stderr: { write: (value) => errors.push(String(value)) },
  };
  const require = (name) => {
    if (name === 'node:fs') return fs;
    if (name === 'node:path') return path;
    throw new Error(`Unexpected module: ${name}`);
  };
  new Function('require', 'process', args.at(-1))(require, process);
  return { files, calls, output: output.join(''), errors: errors.join(''), process };
}

test('OpenCode ACP provider selection is a fixed allowlist', () => {
  assert.equal(normalizeOpenCodeAcpProvider('anthropic'), 'anthropic');
  assert.equal(normalizeOpenCodeAcpProvider(' OPENAI '), 'openai');
  assert.equal(normalizeOpenCodeAcpProvider('openrouter'), 'openrouter');
  assert.equal(normalizeOpenCodeAcpProvider('gemini'), '');
  assert.equal(normalizeOpenCodeAcpProvider('openai;rm -rf /'), '');

  assert.throws(
    () => buildOpenCodeAcpConfigDockerArgs({
      containerName: 'gateway',
      action: 'configure',
      provider: 'openai;curl bad.example',
    }),
    /Unsupported OpenCode ACP provider/,
  );
});

test('OpenCode ACP uses a persistent config and gives only its ACPX worker that path', () => {
  assert.equal(OPENCODE_ACP_CONFIG_DIR, '/home/node/.openclaw/acpx/opencode-config');
  assert.equal(OPENCODE_ACP_CONFIG_PATH, '/home/node/.openclaw/acpx/opencode-config/opencode.json');

  const current = {
    plugins: {
      entries: {
        acpx: {
          enabled: true,
          config: {
            timeoutSeconds: 180,
            agents: {
              claude: { command: 'claude' },
            },
          },
        },
      },
    },
  };
  const first = ensureManagedOpenCodeAcpAgentConfig(current);
  assert.equal(first.changed, true);
  assert.deepEqual(
    current.plugins.entries.acpx.config.agents.opencode,
    buildManagedOpenCodeAcpAgentConfig(),
  );
  assert.deepEqual(current.plugins.entries.acpx.config.agents.claude, { command: 'claude' });
  assert.equal(current.plugins.entries.acpx.config.timeoutSeconds, 180);
  assert.deepEqual(
    current.plugins.entries.acpx.config.agents.opencode,
    {
      command: 'env',
      args: [
        `OPENCODE_CONFIG=${OPENCODE_ACP_CONFIG_PATH}`,
        '/usr/local/bin/opencode', 'acp',
      ],
    },
  );
  assert.equal(ensureManagedOpenCodeAcpAgentConfig(current).changed, false);
});

test('OpenCode ACP preserves a user-managed ACPX command instead of overwriting it', () => {
  const current = {
    plugins: {
      entries: {
        acpx: {
          enabled: true,
          config: {
            agents: {
              opencode: { command: 'opencode', args: ['acp', '--custom-profile'] },
            },
          },
        },
      },
    },
  };

  assert.deepEqual(getManagedOpenCodeAcpAgentConfigState(current), {
    managed: false,
    reason: 'custom_override',
  });
  const result = ensureManagedOpenCodeAcpAgentConfig(current);
  assert.equal(result.changed, false);
  assert.equal(result.managed, false);
  assert.equal(result.reason, 'custom_override');
  assert.deepEqual(current.plugins.entries.acpx.config.agents.opencode, {
    command: 'opencode',
    args: ['acp', '--custom-profile'],
  });
});

test('OpenCode ACP configuration uses a fixed node docker argv and environment references only', () => {
  const args = buildOpenCodeAcpConfigDockerArgs({
    containerName: 'openclaw-openclaw-gateway-1',
    action: 'configure',
    provider: 'openrouter',
  });
  const joined = args.join('\n');

  assert.deepEqual(args.slice(0, 10), [
    'exec', '-u', 'node', '-w', '/home/node', '-e', 'HOME=/home/node',
    '-e', 'TROOPER_OPENCODE_PROVIDER=openrouter', 'openclaw-openclaw-gateway-1',
  ]);
  assert.ok(args.includes('node'));
  assert.ok(args.includes('-e'));
  assert.match(joined, new RegExp(OPENCODE_ACP_CONFIG_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(joined, /\{env:ANTHROPIC_API_KEY\}/);
  assert.match(joined, /\{env:OPENAI_API_KEY\}/);
  assert.match(joined, /\{env:OPENROUTER_API_KEY\}/);
  assert.match(joined, /renameSync/);
  assert.doesNotMatch(joined, /\b(?:sh|bash|zsh)\b/);
  assert.doesNotMatch(joined, /sk-[A-Za-z0-9_-]{8,}/);
  assert.doesNotThrow(() => new Function(args.at(-1)));

  const probeArgs = buildOpenCodeAcpConfigDockerArgs({
    containerName: 'openclaw-openclaw-gateway-1',
    action: 'availability',
  });
  assert.doesNotThrow(() => new Function(probeArgs.at(-1)));
});

test('OpenCode ACP availability exposes only selected provider and credential readiness', async () => {
  const calls = [];
  const manager = new OpenCodeAcpConfigManager({
    containerName: 'openclaw-openclaw-gateway-1',
    execFile: async (file, args) => {
      calls.push({ file, args });
      return {
        stdout: JSON.stringify({
          selectedProvider: 'anthropic',
          credentialPresent: true,
          status: 'ready',
        }),
      };
    },
  });

  const availability = await manager.getAvailability();
  assert.equal(availability.selectedProvider, 'anthropic');
  assert.equal(availability.credentialPresent, true);
  assert.equal(availability.authenticated, true);
  assert.equal(availability.configured, true);
  assert.equal(availability.error, null);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('node'));
});

test('OpenCode provider selection atomically merges an existing config without storing a credential', () => {
  const runtime = runWriteScript({
    provider: 'anthropic',
    existingConfig: JSON.stringify({
      autoupdate: false,
      provider: {
        openai: {
          options: {
            baseURL: 'https://example.test/v1',
            apiKey: '{env:OPENAI_API_KEY}',
          },
        },
      },
    }),
  });
  const saved = JSON.parse(runtime.files.get(OPENCODE_ACP_CONFIG_PATH));

  assert.equal(runtime.process.exitCode, 0);
  assert.equal(runtime.calls.rename, 1);
  assert.deepEqual(JSON.parse(runtime.output), { provider: 'anthropic' });
  assert.equal(runtime.errors, '');
  assert.equal(saved.autoupdate, false);
  assert.equal(saved.provider.anthropic.options.apiKey, '{env:ANTHROPIC_API_KEY}');
  assert.equal(saved.provider.openai.options.baseURL, 'https://example.test/v1');
  assert.equal(Object.hasOwn(saved.provider.openai.options, 'apiKey'), false);
  assert.doesNotMatch(JSON.stringify(saved), /sk-[A-Za-z0-9_-]{8,}/);
});

test('OpenCode provider selection refuses malformed existing JSON rather than overwriting it', () => {
  const runtime = runWriteScript({ provider: 'openai', existingConfig: '{not json' });

  assert.equal(runtime.process.exitCode, 1);
  assert.equal(runtime.calls.rename, 0);
  assert.equal(runtime.files.get(OPENCODE_ACP_CONFIG_PATH), '{not json');
  assert.equal(runtime.output, '');
  assert.equal(runtime.errors, 'OPENCODE_PROVIDER_CONFIG_INVALID\n');
});

test('OpenCode ACP reports a missing provider selection as auth required, not ready', async () => {
  const manager = new OpenCodeAcpConfigManager({
    containerName: 'openclaw-openclaw-gateway-1',
    execFile: async () => ({
      stdout: JSON.stringify({
        selectedProvider: null,
        credentialPresent: false,
        status: 'not_configured',
      }),
    }),
  });

  const availability = await manager.getAvailability();
  assert.equal(availability.authenticated, false);
  assert.equal(availability.configured, false);
  assert.equal(availability.errorCode, 'OPENCODE_PROVIDER_NOT_SELECTED');
  assert.match(availability.error, /Choose an OpenCode provider/i);
});

test('OpenCode ACP rejects malformed existing config without returning its contents', async () => {
  const secret = 'this-must-not-leave-the-gateway';
  const manager = new OpenCodeAcpConfigManager({
    containerName: 'openclaw-openclaw-gateway-1',
    execFile: async () => {
      const error = new Error(secret);
      error.stderr = 'OPENCODE_PROVIDER_CONFIG_INVALID';
      throw error;
    },
  });

  await assert.rejects(
    () => manager.configure('openai'),
    (error) => error?.code === 'OPENCODE_PROVIDER_CONFIG_INVALID'
      && !String(error.message).includes(secret)
      && /Existing configuration was left unchanged/i.test(error.message),
  );
});

test('OpenCode ACP configuration returns no credential values after a provider is selected', async () => {
  const calls = [];
  const manager = new OpenCodeAcpConfigManager({
    containerName: 'openclaw-openclaw-gateway-1',
    execFile: async (_file, args) => {
      calls.push(args);
      if (args.includes('TROOPER_OPENCODE_PROVIDER=openai')) return { stdout: '{"provider":"openai"}' };
      return {
        stdout: JSON.stringify({
          selectedProvider: 'openai',
          credentialPresent: false,
          status: 'credential_missing',
        }),
      };
    },
  });

  const result = await manager.configure('openai');
  assert.equal(result.provider, 'openai');
  assert.equal(result.availability.selectedProvider, 'openai');
  assert.equal(result.availability.credentialPresent, false);
  assert.equal(result.availability.authenticated, false);
  assert.equal(JSON.stringify(result).includes('OPENAI_API_KEY'), false);
  assert.equal(calls.length, 2);
});

test('bridge routes require bridge auth and ACP agent readiness depends on the provider probe', () => {
  const source = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /app\.get\('\/gateway\/opencode\/provider-config\/availability',[\s\S]{0,160}requireBridgeAuth\(req, res\)/,
  );
  assert.match(
    source,
    /app\.post\('\/gateway\/opencode\/provider-config',[\s\S]{0,160}requireBridgeAuth\(req, res\)/,
  );
  assert.match(source, /const keys = Object\.keys\(body\);[\s\S]{0,320}keys\.length !== 1 \|\| keys\[0\] !== 'provider'/);
  assert.match(source, /getOpenCodeAcpProviderAvailability\(\)\.catch\(\(\) => null\)/);
  assert.match(source, /connectedOpenCodeAccount \|\| opencodeProvider\?\.authenticated/);
  assert.match(source, /connectionStatus: connected \? 'connected' : 'auth_required'/);
  assert.match(source, /ensureManagedOpenCodeAcpAgentConfig\(config\)/);
  assert.match(source, /OPENCODE_ACP_ADAPTER_OVERRIDE/);
});
