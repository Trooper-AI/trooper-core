import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  CodexDeviceAuthJobManager,
  DEFAULT_CODEX_ACP_CONTAINER_HOME,
  DEFAULT_CODEX_DEVICE_AUTH_RESTART_WAIT_MS,
  buildCodexCliInstallDockerArgs,
  buildCodexDeviceAuthDockerArgs,
  CODEX_DEVICE_AUTH_FAILURE_KIND,
  classifyCodexDeviceAuthFailure,
  hasValidNativeCodexChatGptAuth,
  parseCodexDeviceAuthInstructions,
  redactCodexDeviceAuthOutput,
} from './codex-device-auth.mjs';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killedWith = null;
  }

  kill(signal) {
    this.killedWith = signal;
    return true;
  }
}

function makeCommandError(message, { stdout = '', stderr = '' } = {}) {
  const error = new Error(message);
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

function createRuntime({ authenticatedRef, installedRef, children, calls }) {
  const execFile = async (file, args) => {
    calls.push({ file, args });
    const command = args.slice(args.indexOf('openclaw-openclaw-gateway-1') + 1);
    if (command[0] === 'codex' && command.includes('--version')) {
      if (!installedRef.value) throw makeCommandError('codex: not found', { stderr: 'codex: not found' });
      return { stdout: 'codex 1.2.3\n' };
    }
    if (command[0] === 'codex' && command.includes('status')) {
      if (!authenticatedRef.value) throw makeCommandError('Not logged in', { stderr: 'Not logged in' });
      return { stdout: 'Logged in using ChatGPT\n' };
    }
    if (command[0] === 'mkdir' || command[0] === 'chmod') return { stdout: '' };
    throw new Error(`Unexpected command: ${command.join(' ')}`);
  };
  const spawnProcess = (file, args) => {
    const child = new FakeChild();
    children.push({ file, args, child });
    return child;
  };
  return { execFile, spawnProcess };
}

test('Codex login status exit code, not wording, is the authentication contract', async () => {
  const calls = [];
  const children = [];
  const manager = new CodexDeviceAuthJobManager({
    containerName: 'openclaw-openclaw-gateway-1',
    children,
    calls,
    execFile: async (_file, args) => {
      const command = args.slice(args.indexOf('openclaw-openclaw-gateway-1') + 1);
      if (command[0] === 'codex' && command.includes('--version')) return { stdout: 'codex 1.2.3\n', code: 0 };
      if (command[0] === 'codex' && command.includes('status')) return { stdout: '', code: 0 };
      throw new Error(`Unexpected command: ${command.join(' ')}`);
    },
  });

  const availability = await manager.getAvailability();
  assert.equal(availability.installed, true);
  assert.equal(availability.authenticated, true);
});

test('managed Docker args pin Codex to the gateway node ACP home', () => {
  const args = buildCodexDeviceAuthDockerArgs({
    containerName: 'openclaw-openclaw-gateway-1',
    commandArgs: ['codex', 'login', '--device-auth'],
  });

  assert.deepEqual(args, [
    'exec', '-u', 'node', '-w', '/home/node',
    '-e', 'HOME=/home/node',
    '-e', `CODEX_HOME=${DEFAULT_CODEX_ACP_CONTAINER_HOME}`,
    '-e', 'CODEX_CLI_AUTH_CREDENTIALS_STORE=file',
    'openclaw-openclaw-gateway-1',
    'codex', 'login', '--device-auth',
  ]);
  assert.throws(
    () => buildCodexDeviceAuthDockerArgs({
      containerName: 'openclaw-openclaw-gateway-1',
      codexHome: '/home/node/.codex',
      commandArgs: ['codex', 'login', '--device-auth'],
    }),
    /Invalid Codex ACP home/,
  );
});

test('the only install path is a fixed root global npm install, followed by node verification', () => {
  const args = buildCodexCliInstallDockerArgs({ containerName: 'openclaw-openclaw-gateway-1' });
  assert.deepEqual(args, [
    'exec', '-u', '0', '-w', '/home/node',
    'openclaw-openclaw-gateway-1',
    'timeout', '--foreground', '--signal=TERM', '--kill-after=10s', '180s',
    'npm', 'install', '--global', '--no-audit', '--no-fund', '@openai/codex',
  ]);
});

test('a valid native ChatGPT session is recognized without exposing its tokens', () => {
  assert.equal(hasValidNativeCodexChatGptAuth({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'access', refresh_token: 'refresh' },
  }), true);
  assert.equal(hasValidNativeCodexChatGptAuth({
    auth_mode: 'chatgpt',
    tokens: { access_token: 'access' },
  }), false);
  assert.equal(hasValidNativeCodexChatGptAuth({
    auth_mode: 'api_key',
    tokens: { access_token: 'access', refresh_token: 'refresh' },
  }), false);
});

test('passive ACP availability refresh is seed-only and preserves device auth', () => {
  const source = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /function syncCodexOAuthToAcpHome\(authDoc, \{ overwriteNative = true \} = \{\}\)/,
  );
  assert.match(
    source,
    /if \(!overwriteNative\) \{[\s\S]{0,500}hasValidNativeCodexChatGptAuth\(existing\)\) return false/,
  );
  assert.match(
    source,
    /syncCodexOAuthToAcpHome\(authDoc, \{ overwriteNative: false \}\);/,
  );
});

test('device auth output retains browser instructions while redacting credentials', () => {
  const output = [
    'Open https://auth.openai.com/device to continue.',
    'Enter device code: ABCD-EFGH',
    'access_token=very-sensitive-access-token-value',
    'Authorization: Bearer very-sensitive-bearer-value',
  ].join('\n');
  const redacted = redactCodexDeviceAuthOutput(output);
  const parsed = parseCodexDeviceAuthInstructions(output);

  assert.match(redacted, /ABCD-EFGH/);
  assert.doesNotMatch(redacted, /very-sensitive/);
  assert.equal(parsed.verificationUrl, 'https://auth.openai.com/device');
  assert.equal(parsed.userCode, 'ABCD-EFGH');
  assert.equal(
    parseCodexDeviceAuthInstructions('Open https://untrusted.example/device\nCode: ABCD-EFGH').verificationUrl,
    null,
  );
});

test('Codex device-auth ANSI output keeps the real URL and one-time code', () => {
  const output = [
    '\u001B[2KFollow these steps to sign in with your account:',
    '1. Open this link in your browser and follow the prompts to get a device code authorization:',
    '   \u001B[94mhttps://auth.openai.com/codex/device\u001B[0m',
    '2. Enter this one-time code (case-sensitive):',
    '   \u001B[94mK8PV-2Q7R\u001B[0m',
  ].join('\n');

  const redacted = redactCodexDeviceAuthOutput(output);
  const parsed = parseCodexDeviceAuthInstructions(output);

  assert.doesNotMatch(redacted, /\u001B/);
  assert.equal(parsed.verificationUrl, 'https://auth.openai.com/codex/device');
  assert.equal(parsed.userCode, 'K8PV-2Q7R');
  assert.equal(
    parseCodexDeviceAuthInstructions('Follow the device code authorization:').userCode,
    null,
  );
});

test('the device-code permission rejection is made actionable without exposing credentials', () => {
  const classified = classifyCodexDeviceAuthFailure(
    'Enable device code authorization for Codex in ChatGPT Security Settings, then run codex login --device-auth again.',
  );

  assert.equal(classified.failureKind, CODEX_DEVICE_AUTH_FAILURE_KIND.DEVICE_CODE_NOT_ENABLED);
  assert.match(classified.error, /workspace admin/i);
  assert.match(classified.error, /start a new code/i);
});

test('device-auth job parses instructions and validates the final gateway session', async () => {
  const calls = [];
  const children = [];
  const authenticatedRef = { value: false };
  const installedRef = { value: true };
  const runtime = createRuntime({ authenticatedRef, installedRef, children, calls });
  const manager = new CodexDeviceAuthJobManager({
    containerName: 'openclaw-openclaw-gateway-1',
    ...runtime,
    createId: () => 'job-1',
  });

  const started = await manager.start();
  assert.equal(started.jobId, 'job-1');
  assert.equal(started.status, 'starting');
  assert.equal(children.length, 1);
  assert.deepEqual(children[0].args.slice(-10), [
    'timeout', '--foreground', '--signal=TERM', '--kill-after=10s', '720s',
    'codex', '-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth',
  ]);
  assert.ok(calls.every(({ args }) => args.includes('-u') && args.includes('node')));
  assert.ok(calls.every(({ args }) => args.includes(`CODEX_HOME=${DEFAULT_CODEX_ACP_CONTAINER_HOME}`)));

  children[0].child.stdout.emit('data', Buffer.from(
    'Open https://auth.openai.com/device\nEnter device code: ABCD-EFGH\n',
  ));
  const waiting = manager.getStatus('job-1');
  assert.equal(waiting.status, 'waiting_for_browser');
  assert.equal(waiting.verificationUrl, 'https://auth.openai.com/device');
  assert.equal(waiting.userCode, 'ABCD-EFGH');

  authenticatedRef.value = true;
  children[0].child.emit('close', 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const completed = manager.getStatus('job-1');
  assert.equal(completed.status, 'connected');
  assert.equal(completed.authenticated, true);
  assert.equal(completed.message, 'Codex is connected to the gateway ACP runtime.');
});

test('a ChatGPT device-code policy rejection reaches the handoff as a specific failure', async () => {
  const calls = [];
  const children = [];
  const authenticatedRef = { value: false };
  const installedRef = { value: true };
  const manager = new CodexDeviceAuthJobManager({
    containerName: 'openclaw-openclaw-gateway-1',
    ...createRuntime({ authenticatedRef, installedRef, children, calls }),
    createId: () => 'job-device-policy',
  });

  await manager.start();
  children[0].child.stderr.emit('data', Buffer.from(
    'Enable device code authorization for Codex in ChatGPT Security Settings, then run codex login --device-auth again.\n',
  ));
  children[0].child.emit('close', 1, null);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const failed = manager.getStatus('job-device-policy');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureKind, CODEX_DEVICE_AUTH_FAILURE_KIND.DEVICE_CODE_NOT_ENABLED);
  assert.match(failed.error, /selected ChatGPT account or workspace/i);
});

test('missing CLI can be diagnosed without starting a generic command', async () => {
  const calls = [];
  const children = [];
  const authenticatedRef = { value: false };
  const installedRef = { value: false };
  const manager = new CodexDeviceAuthJobManager({
    containerName: 'openclaw-openclaw-gateway-1',
    ...createRuntime({ authenticatedRef, installedRef, children, calls }),
  });

  await assert.rejects(
    () => manager.start({ installIfMissing: false }),
    (error) => error?.code === 'CODEX_CLI_MISSING' && error?.availability?.installed === false,
  );
  assert.equal(children.length, 0);
  assert.deepEqual(calls[0].args.slice(-2), ['codex', '--version']);
});

test('a missing CLI is installed through the one fixed root path then login returns to node', async () => {
  const calls = [];
  const children = [];
  const authenticatedRef = { value: false };
  const installedRef = { value: false };
  const manager = new CodexDeviceAuthJobManager({
    containerName: 'openclaw-openclaw-gateway-1',
    ...createRuntime({ authenticatedRef, installedRef, children, calls }),
    createId: () => 'job-install',
  });

  const started = await manager.start();
  assert.equal(started.status, 'installing');
  assert.deepEqual(children[0].args.slice(-6), [
    'npm', 'install', '--global', '--no-audit', '--no-fund', '@openai/codex',
  ]);
  assert.deepEqual(children[0].args.slice(0, 4), ['exec', '-u', '0', '-w']);

  installedRef.value = true;
  children[0].child.emit('close', 0, null);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children.length, 2);
  assert.ok(children[1].args.includes('node'));
  assert.ok(children[1].args.includes(`CODEX_HOME=${DEFAULT_CODEX_ACP_CONTAINER_HOME}`));

  await manager.cancel('job-install');
  children[1].child.emit('close', null, 'SIGTERM');
});

test('cancellation terminates only the managed device-auth child', async () => {
  const calls = [];
  const children = [];
  const authenticatedRef = { value: false };
  const installedRef = { value: true };
  const manager = new CodexDeviceAuthJobManager({
    containerName: 'openclaw-openclaw-gateway-1',
    ...createRuntime({ authenticatedRef, installedRef, children, calls }),
    createId: () => 'job-cancel',
  });

  await manager.start();
  const pending = await manager.cancel('job-cancel');
  assert.equal(pending.status, 'cancelling');
  assert.equal(children[0].child.killedWith, 'SIGTERM');
  children[0].child.emit('close', null, 'SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.getStatus('job-cancel').status, 'cancelled');
});

test('restart stops the prior fixed device-auth process before issuing a fresh code', async () => {
  const calls = [];
  const children = [];
  const authenticatedRef = { value: false };
  const installedRef = { value: true };
  const manager = new CodexDeviceAuthJobManager({
    containerName: 'openclaw-openclaw-gateway-1',
    ...createRuntime({ authenticatedRef, installedRef, children, calls }),
    createId: (() => {
      let sequence = 0;
      return () => `job-restart-${++sequence}`;
    })(),
    restartWaitMs: DEFAULT_CODEX_DEVICE_AUTH_RESTART_WAIT_MS,
  });

  const first = await manager.start();
  const restarting = manager.start({ force: true, restart: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children[0].child.killedWith, 'SIGTERM');
  children[0].child.emit('close', null, 'SIGTERM');
  const fresh = await restarting;

  assert.equal(first.jobId, 'job-restart-1');
  assert.equal(fresh.jobId, 'job-restart-2');
  assert.equal(children.length, 2);
});
