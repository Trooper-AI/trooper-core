import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bridgeSource = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');

test('ACPX Trooper spawns avoid --bind here on webchat/hook hosts', () => {
  const start = bridgeSource.indexOf('async function spawnAcpRun');
  const end = bridgeSource.indexOf('// GET /acp/sessions', start);
  const source = bridgeSource.slice(start, end);

  assert.ok(start >= 0 && end > start, 'expected ACP spawn implementation');
  assert.match(source, /resolveAcpControlSessionKey/);
  assert.match(source, /resolveAcpSpawnBindMode/);
  assert.match(source, /`--bind \$\{mode\}`/);
  assert.match(source, /isAcpConversationBindingsUnavailableError/);
  // Hard-coded --bind here regresses channel/webchat ACP chips.
  assert.doesNotMatch(source, /'--bind here'/);
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

test('ACP stream steers follow-up prompts and publishes steer replies', () => {
  assert.match(bridgeSource, /function runAcpSteerAndPublish/);
  assert.match(bridgeSource, /looksLikeAcpSteerAck/);
  const streamStart = bridgeSource.indexOf("app.post('/acp/sessions/:sessionId/stream'");
  const streamEnd = bridgeSource.indexOf("app.post('/acp/sessions/:sessionId/cancel'", streamStart);
  const streamSource = bridgeSource.slice(streamStart, streamEnd);
  assert.match(streamSource, /req\.body\?\.message/);
  assert.match(streamSource, /runAcpSteerAndPublish/);
  assert.match(streamSource, /spawnOwnsPrompt/);
});
