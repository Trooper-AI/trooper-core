import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  AcpAccountAuthJobManager,
  buildAccountAuthDockerArgs,
  normalizeAccountAuthTarget,
  parseAccountAuthInstructions,
  redactAccountAuthOutput,
} from './acp-account-auth.mjs';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => child.emit('close', null, 'SIGTERM');
  return child;
}

test('account auth targets are fixed and provider-specific', () => {
  const claude = normalizeAccountAuthTarget('claude');
  assert.equal(claude?.recipe.binaryPath, '/usr/local/bin/claude');
  assert.deepEqual(claude?.recipe.loginArgs, ['auth', 'login']);
  assert.equal(normalizeAccountAuthTarget('opencode', 'xai')?.provider, 'xai');
  assert.equal(normalizeAccountAuthTarget('opencode', 'anthropic'), null);
  assert.equal(normalizeAccountAuthTarget('gemini'), null);
});

test('docker invocation pins node identity, persistent XDG homes, and managed binary', () => {
  const target = normalizeAccountAuthTarget('opencode', 'openai');
  const args = buildAccountAuthDockerArgs({
    containerName: 'gateway-1',
    target,
    commandArgs: target.recipe.loginArgs,
  });
  assert.deepEqual(args.slice(0, 8), ['exec', '-i', '-u', 'node', '-w', '/home/node', '-e', 'HOME=/home/node']);
  assert.ok(args.includes('XDG_CONFIG_HOME=/home/node/.openclaw/acpx/config'));
  assert.ok(args.includes('OPENCODE_CONFIG=/home/node/.openclaw/acpx/opencode-config/opencode.json'));
  assert.ok(args.includes('/usr/local/bin/opencode'));
  assert.equal(args.includes('npx'), false);
});

test('provider instructions retain only allowed URLs and short user codes', () => {
  const parsed = parseAccountAuthInstructions(
    'Open https://github.com/login/device\nDevice code: ABCD-EFGH\naccess_token=secret-value',
    ['github.com'],
  );
  assert.equal(parsed.verificationUrl, 'https://github.com/login/device');
  assert.equal(parsed.userCode, 'ABCD-EFGH');
  assert.doesNotMatch(redactAccountAuthOutput('access_token=secret-value'), /secret-value/);
  assert.equal(parseAccountAuthInstructions('Open https://evil.example/login', ['github.com']).verificationUrl, null);
});

test('job lifecycle exposes browser instructions but never credentials', async () => {
  const child = fakeChild();
  const manager = new AcpAccountAuthJobManager({
    containerName: 'gateway-1',
    spawnProcess: () => child,
    createId: () => 'job-1',
    now: () => 1_000,
  });
  const started = manager.start('copilot');
  assert.equal(started.status, 'starting');
  child.stderr.write('Visit https://github.com/login/device\nDevice code: ABCD-EFGH\n');
  const waiting = manager.getJob('job-1');
  assert.equal(waiting.status, 'waiting_for_browser');
  assert.equal(waiting.userCode, 'ABCD-EFGH');
  assert.equal(Object.hasOwn(waiting, 'output'), false);
  child.emit('close', 0, null);
  assert.equal(manager.getJob('job-1').status, 'connected');
});

test('authorization input is accepted only by a live provider prompt and is not returned', () => {
  const child = fakeChild();
  let written = '';
  child.stdin.on('data', (chunk) => { written += chunk.toString(); });
  const manager = new AcpAccountAuthJobManager({
    containerName: 'gateway-1',
    spawnProcess: () => child,
    createId: () => 'job-2',
  });
  manager.start('claude');
  child.stderr.write('Paste authorization code:\n');
  const result = manager.input('job-2', 'safe-short-code');
  assert.equal(result.status, 'verifying');
  assert.equal(written, 'safe-short-code\n');
  assert.equal(JSON.stringify(result).includes('safe-short-code'), false);
});
