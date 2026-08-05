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

test('usage-limit history becomes a compact error event, not a system-prompt dump', () => {
  const blob = [
    'You are Codex, a coding agent.',
    'AGENTS.md SOUL.md TOOLS.md Always follow Mission Floor Available tools',
    'x'.repeat(900),
    "ERROR: You've hit your usage limit. try again at Aug 30th, 2026 5:38 PM. Some(UsageLimitExceeded)",
  ].join('\n');
  const records = observeAcpSessionHistory([
    { id: 'a-fail', role: 'assistant', content: blob, timestamp: 9 },
  ]);
  const events = records.flatMap((record) => record.events);
  assert.equal(events[0].type, 'error');
  assert.match(events[0].content, /usage limit/i);
  assert.doesNotMatch(events[0].content, /You are Codex/);
  assert.equal(records[0].transcript[0].role, 'error');
});

test('Internal error stderrTail mid-prompt fragment is not shown as the failure', () => {
  const garbled = [
    'ACP error (ACP_TURN_FAILED): Internal error: eir browser.',
    '',
    '### Editing constraints',
    '',
    'You default to ASCII when editing or creating files.',
  ].join('\n');
  const records = observeAcpSessionHistory([
    { id: 'a-garbled', role: 'assistant', content: garbled, timestamp: 11 },
  ]);
  const content = records.flatMap((record) => record.events)[0]?.content || '';
  assert.match(content, /stderr was truncated|usage limit/i);
  assert.doesNotMatch(content, /eir browser/i);
  assert.doesNotMatch(content, /Editing constraints/i);
});

test('UsageLimit at end of Internal error blob is recovered', () => {
  const blob = [
    'ACP_TURN_FAILED Internal error: eir browser. ### Editing constraints You default to ASCII',
    'x'.repeat(400),
    "ERROR: You've hit your usage limit. try again at Aug 30th, 2026 5:38 PM. Some(UsageLimitExceeded)",
  ].join(' ');
  const records = observeAcpSessionHistory([
    { id: 'a-buried', role: 'assistant', content: blob, timestamp: 12 },
  ]);
  const event = records.flatMap((record) => record.events)[0];
  assert.equal(event.errorKind, 'acp_quota_exhausted');
  assert.match(event.content, /usage limit/i);
  assert.doesNotMatch(event.content, /eir browser/i);
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
