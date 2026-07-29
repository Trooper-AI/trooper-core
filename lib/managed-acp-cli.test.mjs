import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ManagedAcpCliManager,
  buildManagedAcpCliDockerArgs,
  getManagedAcpCliRecipe,
  redactManagedAcpCliOutput,
} from './managed-acp-cli.mjs';

test('managed ACP recipes are fixed and reject unknown harnesses', () => {
  const claude = getManagedAcpCliRecipe('claude');
  const gemini = getManagedAcpCliRecipe('gemini');
  assert.equal(claude?.packageName, '@anthropic-ai/claude-code');
  assert.equal(claude?.packageVersion, '2.1.220');
  assert.equal(claude?.authMode, 'official_browser_login');
  assert.match(claude?.authHint || '', /official browser login/i);
  assert.equal(gemini?.binary, 'gemini');
  assert.equal(gemini?.authMode, 'enterprise_credentials_only');
  assert.equal(gemini?.exposed, false);
  assert.equal(getManagedAcpCliRecipe('opencode')?.binaryPath, '/usr/local/bin/opencode');
  assert.equal(getManagedAcpCliRecipe('kimi')?.packageVersion, '0.30.0');
  assert.equal(getManagedAcpCliRecipe('copilot')?.packageVersion, '1.0.75');
  assert.equal(getManagedAcpCliRecipe('codex'), null);
  assert.throws(
    () => buildManagedAcpCliDockerArgs({ containerName: 'gateway', harness: 'claude;rm-rf', action: 'install' }),
    /Unsupported managed ACP harness/,
  );
});

test('Claude auth probe treats an unknown successful status JSON shape as authenticated', async () => {
  const manager = new ManagedAcpCliManager({
    containerName: 'openclaw-openclaw-gateway-1',
    execFile: async (_file, args) => {
      if (args.includes('--version')) return { stdout: 'claude 9.9.9\n', stderr: '', code: 0 };
      if (args.includes('auth') && args.includes('status')) {
        return { stdout: '{"futureCliShape":{"session":"active"}}\n', stderr: '', code: 0 };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    },
  });

  const availability = await manager.getAvailability('claude');
  assert.equal(availability.installed, true);
  assert.equal(availability.authenticated, true);
  assert.equal(availability.errorCode, null);
});

test('Claude auth probe preserves an explicit unauthenticated status', async () => {
  const manager = new ManagedAcpCliManager({
    containerName: 'openclaw-openclaw-gateway-1',
    execFile: async (_file, args) => {
      if (args.includes('--version')) return { stdout: 'claude 9.9.9\n', stderr: '', code: 0 };
      if (args.includes('auth') && args.includes('status')) {
        return { stdout: '{"authenticated":false}\n', stderr: '', code: 0 };
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`);
    },
  });

  const availability = await manager.getAvailability('claude');
  assert.equal(availability.installed, true);
  assert.equal(availability.authenticated, false);
  assert.equal(availability.errorCode, 'ACP_CLI_AUTH_REQUIRED');
});

test('managed install is fixed argv inside the gateway, never a shell command', () => {
  const args = buildManagedAcpCliDockerArgs({
    containerName: 'openclaw-openclaw-gateway-1',
    harness: 'claude',
    action: 'install',
  });
  assert.deepEqual(args, [
    'exec', '-u', '0', '-w', '/home/node', 'openclaw-openclaw-gateway-1',
    'timeout', '--foreground', '--signal=TERM', '--kill-after=10s', '180s',
    'npm', 'install', '--global', '--no-audit', '--no-fund', '@anthropic-ai/claude-code@2.1.220',
  ]);
  assert.ok(!args.includes('sh'));
  assert.ok(!args.includes('bash'));
});

test('managed probes run as the ACP node user with a fixed home', () => {
  const args = buildManagedAcpCliDockerArgs({
    containerName: 'openclaw-openclaw-gateway-1',
    harness: 'gemini',
    action: 'probe',
  });
  assert.deepEqual(args.slice(0, 8), [
    'exec', '-u', 'node', '-w', '/home/node', '-e', 'HOME=/home/node', 'openclaw-openclaw-gateway-1',
  ]);
  assert.deepEqual(args.slice(-2), ['/usr/local/bin/gemini', '--version']);
});

test('managed CLI output redacts credentials before it leaves the bridge', () => {
  const output = redactManagedAcpCliOutput('api_key=abc-secret\nAuthorization: Bearer another-secret\nclaude 1.2.3');
  assert.doesNotMatch(output, /secret/);
  assert.match(output, /claude 1\.2\.3/);
});

test('availability reports a missing fixed CLI instead of pretending it is ready', async () => {
  const manager = new ManagedAcpCliManager({
    containerName: 'openclaw-openclaw-gateway-1',
    execFile: async () => {
      const error = new Error('claude: command not found');
      error.stderr = 'claude: command not found';
      throw error;
    },
  });
  const availability = await manager.getAvailability('claude');
  assert.equal(availability.supported, true);
  assert.equal(availability.installed, false);
  assert.equal(availability.managedInstall, true);
  assert.equal(availability.errorCode, 'ACP_CLI_MISSING');
});

test('unsupported ACP targets never expose a generic installer', async () => {
  const manager = new ManagedAcpCliManager({ containerName: 'openclaw-openclaw-gateway-1' });
  const availability = await manager.getAvailability('grok');
  assert.equal(availability.supported, false);
  assert.equal(availability.managedInstall, false);
  await assert.rejects(() => manager.install('grok'), (error) => error?.code === 'ACP_CLI_UNSUPPORTED');
});
