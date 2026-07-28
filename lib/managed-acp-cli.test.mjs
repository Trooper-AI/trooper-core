import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ManagedAcpCliManager,
  buildManagedAcpCliDockerArgs,
  getManagedAcpCliRecipe,
  redactManagedAcpCliOutput,
} from './managed-acp-cli.mjs';

test('managed ACP recipes are fixed and reject unknown harnesses', () => {
  assert.equal(getManagedAcpCliRecipe('claude')?.packageName, '@anthropic-ai/claude-code');
  assert.equal(getManagedAcpCliRecipe('gemini')?.binary, 'gemini');
  assert.equal(getManagedAcpCliRecipe('opencode')?.authMode, 'provider_selection_required');
  assert.equal(getManagedAcpCliRecipe('codex'), null);
  assert.throws(
    () => buildManagedAcpCliDockerArgs({ containerName: 'gateway', harness: 'claude;rm-rf', action: 'install' }),
    /Unsupported managed ACP harness/,
  );
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
    'npm', 'install', '--global', '--no-audit', '--no-fund', '@anthropic-ai/claude-code',
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
  assert.deepEqual(args.slice(-2), ['gemini', '--version']);
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
