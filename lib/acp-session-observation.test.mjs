import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeAcpArtifacts,
  mergeAcpTranscript,
  observeAcpSessionHistory,
} from './acp-session-observation.mjs';

test('ACP history becomes chat, command, output, and file events without heartbeat noise', () => {
  const records = observeAcpSessionHistory([
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Build the calculator' }], timestamp: 1 },
    { id: 'a1', role: 'assistant', content: [
      { type: 'text', text: 'I will create it now.' },
      { type: 'tool_use', id: 't1', name: 'write', input: { path: '/home/node/.openclaw/workspace/calculator.html' } },
      { type: 'tool_result', tool_use_id: 't1', content: 'Wrote /home/node/.openclaw/workspace/calculator.html' },
    ], timestamp: 2 },
    { id: 'a2', role: 'assistant', content: 'ACP worker is running', timestamp: 3 },
  ]);

  assert.equal(records.length, 2);
  assert.deepEqual(records.flatMap((record) => record.transcript).map((item) => item.role), ['user', 'assistant']);
  assert.deepEqual(records.flatMap((record) => record.events).map((event) => event.type), ['message', 'message', 'tool_use', 'tool_result']);
  assert.deepEqual(records.flatMap((record) => record.artifacts).map((item) => item.path), [
    '/home/node/.openclaw/workspace/calculator.html',
    '/home/node/.openclaw/workspace/calculator.html',
  ]);
});

test('streaming updates replace transcript messages and file artifacts by stable identity', () => {
  const transcript = mergeAcpTranscript(
    [{ id: 'assistant-1', role: 'assistant', content: 'Part', createdAt: 1 }],
    [{ id: 'assistant-1', role: 'assistant', content: 'Part complete', createdAt: 2 }],
  );
  assert.equal(transcript.length, 1);
  assert.equal(transcript[0].content, 'Part complete');

  const artifacts = mergeAcpArtifacts(
    [{ path: '/home/node/.openclaw/workspace/app.html', size: 1 }],
    [{ path: '/home/node/.openclaw/workspace/app.html', size: 2 }],
  );
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].size, 2);
});
