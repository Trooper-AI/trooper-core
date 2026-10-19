import test from 'node:test';
import assert from 'node:assert/strict';
import { openClawEnvFileCandidates, writeOpenClawEnvFile } from './openclaw-env-file.mjs';

test('env file candidates fall back beside the live OpenClaw config', () => {
  assert.deepEqual(openClawEnvFileCandidates({
    configPath: '/data/openclaw/openclaw.json',
  }), [
    '/opt/openclaw/.env',
    '/data/openclaw/.env',
  ]);
});

test('a missing VPS env directory does not abort the write', () => {
  const writes = [];
  const warnings = [];
  const result = writeOpenClawEnvFile('TELEGRAM_BOT_TOKEN=saved\n', {
    candidates: ['/opt/openclaw/.env', '/data/openclaw/.env'],
    write(target, content) {
      if (target.startsWith('/opt/openclaw')) {
        const error = new Error("EACCES: permission denied, mkdir '/opt/openclaw'");
        error.code = 'EACCES';
        throw error;
      }
      writes.push({ target, content });
    },
    warn(message) { warnings.push(message); },
  });
  assert.equal(result.written, true);
  assert.equal(result.path, '/data/openclaw/.env');
  assert.equal(writes.length, 1);
  assert.equal(warnings.length, 0);
});

test('env write failure is reported instead of thrown when every path fails', () => {
  const warnings = [];
  const result = writeOpenClawEnvFile('x', {
    candidates: ['/opt/openclaw/.env'],
    write() { throw new Error('read-only'); },
    warn(message) { warnings.push(message); },
  });
  assert.equal(result.written, false);
  assert.match(warnings[0], /read-only/);
});
