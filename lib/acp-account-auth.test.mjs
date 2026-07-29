import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  AcpAccountAuthJobManager,
  buildAccountAuthDockerArgs,
  normalizeAccountAuthTarget,
  opencodeCredentialListHasProvider,
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

test('opencode logins pin a non-interactive method so headless jobs cannot hang on a picker', () => {
  const openai = normalizeAccountAuthTarget('opencode', 'openai');
  assert.deepEqual(openai.recipe.loginArgs, [
    'auth', 'login', '--provider', 'openai', '--method', 'ChatGPT Pro/Plus (headless)',
  ]);
  const copilot = normalizeAccountAuthTarget('opencode', 'github-copilot');
  assert.deepEqual(copilot.recipe.loginArgs, [
    'auth', 'login', '--provider', 'github-copilot', '--method', 'Login with GitHub Copilot',
  ]);
  // xai has no OAuth method in OpenCode; it prompts for an API key instead.
  const xai = normalizeAccountAuthTarget('opencode', 'xai');
  assert.equal(xai.recipe.promptType, 'api_key');
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

test('the real claude 2.1.220 login transcript produces a link and a code prompt', () => {
  // Captured verbatim from `claude auth login` with piped stdio.
  const transcript = 'Opening browser to sign in…\n'
    + 'If the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y\n'
    + 'Paste code here if prompted > ';
  const target = normalizeAccountAuthTarget('claude');
  const parsed = parseAccountAuthInstructions(transcript, target.recipe.hosts);
  assert.match(parsed.verificationUrl, /^https:\/\/claude\.com\/cai\/oauth\/authorize/);

  const child = fakeChild();
  const manager = new AcpAccountAuthJobManager({
    containerName: 'gateway-1',
    spawnProcess: () => child,
    createId: () => 'job-claude',
  });
  manager.start('claude');
  child.stdout.write(transcript);
  const waiting = manager.getJob('job-claude');
  assert.equal(waiting.status, 'waiting_for_input');
  assert.equal(waiting.promptType, 'authorization_code');
  assert.match(waiting.verificationUrl, /^https:\/\/claude\.com\//);
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

test('authorization input is accepted only by a live provider prompt and submits with CRLF', () => {
  const child = fakeChild();
  let written = '';
  child.stdin.on('data', (chunk) => { written += chunk.toString(); });
  const manager = new AcpAccountAuthJobManager({
    containerName: 'gateway-1',
    spawnProcess: () => child,
    createId: () => 'job-2',
  });
  manager.start('claude');
  assert.throws(() => manager.input('job-2', 'too-early'), /does not accept browser input/);
  child.stderr.write('Paste code here if prompted > ');
  const result = manager.input('job-2', 'safe-short-code');
  assert.equal(result.status, 'verifying');
  // Interactive prompts submit on carriage return; "\n" alone is ignored.
  assert.equal(written, 'safe-short-code\r\n');
  assert.equal(JSON.stringify(result).includes('safe-short-code'), false);
});

test('a submitted code cannot be undone by the stale prompt text in the transcript', () => {
  const child = fakeChild();
  const manager = new AcpAccountAuthJobManager({
    containerName: 'gateway-1',
    spawnProcess: () => child,
    createId: () => 'job-3',
  });
  manager.start('claude');
  child.stdout.write('Paste code here if prompted > ');
  manager.input('job-3', 'code-one');
  child.stdout.write('Verifying…\n');
  assert.equal(manager.getJob('job-3').status, 'verifying');
  // A genuinely fresh prompt (rejected code) may return the job to input.
  child.stdout.write('Invalid code. Paste code here if prompted > ');
  assert.equal(manager.getJob('job-3').status, 'waiting_for_input');
});

test('the opencode xai key prompt accepts an API key through the guarded input channel', () => {
  const child = fakeChild();
  let written = '';
  child.stdin.on('data', (chunk) => { written += chunk.toString(); });
  const manager = new AcpAccountAuthJobManager({
    containerName: 'gateway-1',
    spawnProcess: () => child,
    createId: () => 'job-xai',
  });
  const started = manager.start('opencode', { provider: 'xai' });
  assert.equal(started.provider, 'xai');
  child.stdout.write('┌  Add credential\n│\n◆  Enter your API key\n│  _\n└\n');
  const waiting = manager.getJob('job-xai');
  assert.equal(waiting.status, 'waiting_for_input');
  assert.equal(waiting.promptType, 'api_key');
  const result = manager.input('job-xai', 'xai-test-key');
  assert.equal(result.status, 'verifying');
  assert.equal(written, 'xai-test-key\r\n');
  assert.equal(JSON.stringify(result).includes('xai-test-key'), false);
});

test('the opencode copilot deployment picker is answered once with the fixed default', () => {
  const child = fakeChild();
  let written = '';
  child.stdin.on('data', (chunk) => { written += chunk.toString(); });
  const manager = new AcpAccountAuthJobManager({
    containerName: 'gateway-1',
    spawnProcess: () => child,
    createId: () => 'job-ghc',
  });
  manager.start('opencode', { provider: 'github-copilot' });
  child.stdout.write('┌  Add credential\n│\n◆  Select GitHub deployment type\n│  ● GitHub.com (Public)\n│  ○ GitHub Enterprise\n└\n');
  assert.equal(written, '\r');
  child.stdout.write('◇  Select GitHub deployment type\n│  GitHub.com\n');
  assert.equal(written, '\r', 'the fixed response must fire at most once');
  child.stdout.write('First copy your one-time code: ABCD-1234\nOpen https://github.com/login/device\n');
  const waiting = manager.getJob('job-ghc');
  assert.equal(waiting.status, 'waiting_for_browser');
  assert.equal(waiting.userCode, 'ABCD-1234');
});

test('opencode credential listing matches display labels, not provider ids', () => {
  // Captured from `opencode auth list` 1.14.48 (ANSI stripped).
  const listing = '┌  Credentials /home/node/.openclaw/acpx/data/opencode/auth.json\n'
    + '│\n●  OpenAI oauth\n│\n●  GitHub Copilot oauth\n│\n●  xAI api\n│\n└  3 credentials\n';
  assert.equal(opencodeCredentialListHasProvider('openai', listing), true);
  assert.equal(opencodeCredentialListHasProvider('github-copilot', listing), true);
  assert.equal(opencodeCredentialListHasProvider('xai', listing), true);
  const empty = '┌  Credentials /home/node/.local/share/opencode/auth.json\n│\n└  0 credentials\n';
  assert.equal(opencodeCredentialListHasProvider('openai', empty), false);
  assert.equal(opencodeCredentialListHasProvider('xai', empty), false);
});

test('claude auth status that explicitly reports loggedIn:false is never authenticated', async () => {
  const manager = new AcpAccountAuthJobManager({
    containerName: 'gateway-1',
    execFile: async (file, args) => {
      if (args.includes('--version')) return { stdout: '2.1.220 (Claude Code)', stderr: '', code: 0 };
      return { stdout: '{"loggedIn": false}', stderr: '', code: 0 };
    },
  });
  const status = await manager.getStatus('claude');
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.equal(status.status, 'sign_in_required');
});

test('a failed login surfaces the CLI reason without leaking credentials', async () => {
  const child = fakeChild();
  const manager = new AcpAccountAuthJobManager({
    containerName: 'gateway-1',
    spawnProcess: () => child,
    createId: () => 'job-err',
    now: () => 1_000,
  });
  manager.start('opencode', { provider: 'openai' });
  child.stdout.write('Error: Unknown method "ChatGPT Pro/Plus (headless)" for openai. Available: ChatGPT (browser)\naccess_token=super-secret\n');
  child.emit('close', 1, null);
  await new Promise((resolve) => setImmediate(resolve));
  const job = manager.getJob('job-err');
  assert.equal(job.status, 'failed');
  assert.match(job.error, /Unknown method/);
  assert.doesNotMatch(job.error, /super-secret/);
});
