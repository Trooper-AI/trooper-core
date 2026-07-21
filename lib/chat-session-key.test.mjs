import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chatHandler = readFileSync(path.join(root, 'lib/chat-handler.mjs'), 'utf8');
const indexSource = readFileSync(path.join(root, 'index.mjs'), 'utf8');

test('direct chat-handler prefers chat-session keys over sticky channel keys', () => {
  assert.match(chatHandler, /chatSessionId/);
  assert.match(chatHandler, /chat-session:\$\{chatSessionId\}/);
  assert.match(chatHandler, /channel:\$\{channel\}/);
  // Must not be the only path: channel fallback is ok, exclusive channel is not.
  assert.ok(
    chatHandler.includes('chat-session:${chatSessionId}')
    && chatHandler.includes('channel:${channel}'),
  );
});

test('mission-control session resolver honors chatSessionId for rotation', () => {
  assert.match(indexSource, /function resolveMissionControlSessionKey/);
  assert.match(indexSource, /chatSessionId/);
  assert.match(indexSource, /chat-session:\$\{chatSessionId\}/);
  assert.match(
    indexSource,
    /context\?\.chatSessionId[\s\S]*chat-session/,
  );
});
