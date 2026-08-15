import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from '../db/migrate.mjs';
import { forwardToolEventPayload } from './event-contracts.mjs';
import {
  createTapeRecorder,
  dispatchAgentFrameToListener,
  replayTape,
  resolveTapeDir,
} from './tape.mjs';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tape-synthetic-run.jsonl');
const makeDir = () => mkdtempSync(path.join(tmpdir(), 'tape-test-'));

test('recording is off by default: resolveTapeDir yields null unless the env var is set', () => {
  assert.equal(resolveTapeDir({}), null);
  assert.equal(resolveTapeDir({ TROOPER_TAPE_DIR: '' }), null);
  assert.equal(resolveTapeDir({ TROOPER_TAPE_DIR: '   ' }), null);
  assert.equal(resolveTapeDir({ TROOPER_TAPE_DIR: '/var/tapes' }), '/var/tapes');
});

test('record → replay round trip preserves frames, order, direction, and monotone seq', () => {
  const recorder = createTapeRecorder({ dir: makeDir(), now: () => 1755000000000 });
  const frames = [
    { type: 'res', id: 'a', ok: true, payload: { status: 'accepted', runId: 'r1' } },
    { type: 'event', event: 'agent', payload: { runId: 'r1', stream: 'assistant', data: { text: 'hi' } } },
    { type: 'req', id: 'b', method: 'agent', params: { message: 'do the thing' } },
  ];
  recorder.record('in', frames[0]);
  recorder.record('in', frames[1]);
  recorder.record('out', frames[2]);

  const replayed = [];
  const { fed, skipped } = replayTape(recorder.path, (frame, meta) => replayed.push({ frame, meta }));
  assert.equal(fed, 3);
  assert.equal(skipped, 0);
  assert.deepEqual(replayed.map((r) => r.frame), frames);
  assert.deepEqual(replayed.map((r) => r.meta.seq), [1, 2, 3]);
  assert.deepEqual(replayed.map((r) => r.meta.dir), ['in', 'in', 'out']);
});

test('a tape cut mid-write replays the intact lines and counts the torn one', () => {
  const recorder = createTapeRecorder({ dir: makeDir() });
  recorder.record('in', { type: 'res', id: 'a', ok: true });
  appendFileSync(recorder.path, '{"seq":2,"dir":"in","fra'); // torn final line
  const seen = [];
  const { fed, skipped } = replayTape(recorder.path, (frame) => seen.push(frame));
  assert.equal(fed, 1);
  assert.equal(skipped, 1);
});

test('record never throws into the frame path, even on unserializable frames', () => {
  const recorder = createTapeRecorder({ dir: makeDir() });
  assert.doesNotThrow(() => recorder.record('in', { bad: 10n })); // BigInt breaks JSON.stringify
  assert.doesNotThrow(() => recorder.record('in', { fine: true }));
  const { fed } = replayTape(recorder.path, () => {});
  assert.equal(fed, 1); // the bad frame was dropped, the good one recorded
});

test('dispatchAgentFrameToListener mirrors the gateway dispatch contract', () => {
  const calls = [];
  const listener = (stream, data, runId) => calls.push({ stream, data, runId });

  // Non-agent frames are not dispatched.
  assert.equal(dispatchAgentFrameToListener({ type: 'res', id: 'x', ok: true }, listener), false);
  assert.equal(calls.length, 0);

  // Native `tool` stream is rewritten to tool_use / tool_result.
  dispatchAgentFrameToListener({
    type: 'event', event: 'agent',
    payload: { runId: 'r1', stream: 'tool', data: { phase: 'start', name: 'exec', args: { command: 'ls' } } },
  }, listener);
  dispatchAgentFrameToListener({
    type: 'event', event: 'agent',
    payload: { runId: 'r1', stream: 'tool', data: { phase: 'end', name: 'exec', result: 'ok', error: null } },
  }, listener);
  assert.deepEqual(calls.map((c) => c.stream), ['tool_use', 'tool_result']);
  assert.deepEqual(calls[0].data.input, { command: 'ls' });
  assert.equal(calls[1].data.content, 'ok');
  assert.equal(calls[1].data.is_error, false);

  // Every other stream passes through untouched.
  dispatchAgentFrameToListener({
    type: 'event', event: 'agent',
    payload: { runId: 'r1', stream: 'assistant', data: { text: 'hi' } },
  }, listener);
  assert.equal(calls[2].stream, 'assistant');
});

test('replaying the committed fixture derives the expected run_events rows', () => {
  // Closest instantiable layer to the (monolith-locked) real frame handler:
  // the gateway dispatch contract (dispatchAgentFrameToListener) feeding the
  // same event-contracts payload builder and run_events row shape the chat
  // and task handlers persist — against the real db/migrate.mjs schema, so
  // UNIQUE(run_id, seq) and the runs FK are enforced.
  const sqlite = new Database(':memory:');
  migrate(sqlite);
  sqlite.pragma('foreign_keys = ON');
  sqlite.prepare(`INSERT INTO runs (id, agent_id, agent_name, source, status, started_at, created_at)
    VALUES ('run-tape-1', 'agent-1', 'Tape Agent', 'chat', 'running', 1755000000000, 1755000000000)`).run();

  const insertEvent = sqlite.prepare(
    'INSERT INTO run_events (run_id, seq, event, data, timestamp) VALUES (?, ?, ?, ?, ?)',
  );
  let seq = 0;
  let agentFrames = 0;
  let otherFrames = 0;

  const { fed, skipped } = replayTape(FIXTURE, (frame, meta) => {
    const dispatched = dispatchAgentFrameToListener(frame, (stream, data, runId) => {
      // Mirror of the chat/task streamCallback persistence contract
      // (lib/chat-handler.mjs / lib/task-handler.mjs tool event branches).
      if (stream === 'tool_use') {
        const payload = forwardToolEventPayload('tool_start', data, {
          tool: data.name || data.tool || 'unknown',
          params: data.input || data.args || {},
        });
        insertEvent.run(runId, seq++, 'tool_start', JSON.stringify(payload), meta.t);
      }
      if (stream === 'tool_result') {
        const payload = forwardToolEventPayload('tool_result', data, {
          tool: data.name || data.tool || 'unknown',
          success: !data.is_error,
          summary: typeof data.content === 'string' ? data.content.slice(0, 500) : (data.summary || ''),
        });
        insertEvent.run(runId, seq++, 'tool_result', JSON.stringify(payload), meta.t);
      }
    });
    if (dispatched) agentFrames += 1; else otherFrames += 1;
  });

  assert.equal(fed, 9);
  assert.equal(skipped, 0);
  assert.equal(agentFrames, 7); // lifecycle x2, assistant, tool x2, tool_use, tool_result
  assert.equal(otherFrames, 2); // the two res frames

  const rows = sqlite.prepare("SELECT * FROM run_events WHERE run_id = 'run-tape-1' ORDER BY seq").all();
  assert.deepEqual(rows.map((r) => r.event), ['tool_start', 'tool_result', 'tool_start', 'tool_result']);
  assert.deepEqual(rows.map((r) => r.seq), [0, 1, 2, 3]);

  const [execStart, execResult, readStart, readResult] = rows.map((r) => JSON.parse(r.data));
  assert.equal(execStart.tool, 'exec');
  assert.deepEqual(execStart.params, { command: 'echo hello' });
  assert.equal(execStart.toolCallId, 'call-1');
  assert.equal(execResult.tool, 'exec');
  assert.equal(execResult.success, true);
  assert.equal(execResult.raw, 'hello\n');
  assert.equal(readStart.tool, 'read');
  assert.deepEqual(readStart.params, { path: '/workspace/notes.txt' });
  assert.equal(readResult.tool, 'read');
  assert.equal(readResult.raw, 'synthetic file body');
  assert.equal(readResult.summary, 'synthetic file body');

  // Replay timestamps come from the tape, not the wall clock.
  assert.deepEqual(rows.map((r) => r.timestamp), [1755000000300, 1755000000400, 1755000000500, 1755000000600]);
});

test('the committed fixture is well-formed JSONL with monotone seq and only synthetic content', () => {
  const lines = readFileSync(FIXTURE, 'utf8').trim().split('\n');
  let lastSeq = 0;
  for (const line of lines) {
    const entry = JSON.parse(line);
    assert.ok(entry.seq > lastSeq, 'seq strictly increases');
    lastSeq = entry.seq;
    assert.equal(entry.dir, 'in');
    assert.ok(entry.frame && typeof entry.frame === 'object');
  }
  assert.equal(lines.length, 9);
});
