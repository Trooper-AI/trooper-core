import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bridgeSource = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');

test('ACPX workers are bound to their parent conversation', () => {
  const start = bridgeSource.indexOf('async function spawnAcpRun');
  const end = bridgeSource.indexOf('// GET /acp/sessions', start);
  const source = bridgeSource.slice(start, end);

  assert.ok(start >= 0 && end > start, 'expected ACP spawn implementation');
  assert.match(source, /'--bind here'/);
  assert.doesNotMatch(source, /'--bind off'/);
  assert.doesNotMatch(source, /'--thread off'/);
});

test('ACPX permission preferences never invoke an unsupported gateway command', () => {
  const start = bridgeSource.indexOf("app.put('/acp/sessions/:sessionId/permissions'");
  const end = bridgeSource.indexOf("app.get('/exec-approvals'", start);
  const source = bridgeSource.slice(start, end);

  assert.ok(start >= 0 && end > start, 'expected ACP permission endpoint');
  assert.doesNotMatch(source, /runGatewaySlashCommand/);
  assert.match(source, /trooper_preference_only/);
});

test('gateway image includes the Linux isolation helper required by Codex', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /\bbubblewrap\b/);
});
