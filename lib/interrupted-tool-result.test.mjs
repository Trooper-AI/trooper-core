import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERRUPTED_TOOL_RESULT,
  INTERRUPTION_MARKER_KIND,
  buildInterruptedAcpToolResultEvent,
  listUnmatchedAcpToolUses,
} from './interrupted-tool-result.mjs';

const use = (toolCallId, tool = 'exec') => ({ type: 'tool_use', toolCallId, tool });
const done = (toolCallId, tool = 'exec') => ({ type: 'tool_result', toolCallId, tool });

test('marker text is byte-exact (qm-adapted contract; replays depend on it)', () => {
  assert.equal(
    INTERRUPTED_TOOL_RESULT,
    '[interrupted — the platform restarted while this tool call was running and its outcome was not recorded. Check what actually happened before redoing anything with side effects.]',
  );
});

test('paired tool_use events are not reported', () => {
  assert.deepEqual(listUnmatchedAcpToolUses([use('a'), done('a')]), []);
});

test('tool_error closes a pending use like tool_result', () => {
  assert.deepEqual(listUnmatchedAcpToolUses([use('a'), { type: 'tool_error', toolCallId: 'a', tool: 'exec' }]), []);
});

test('an orphan tool_use is reported with its identity', () => {
  const unmatched = listUnmatchedAcpToolUses([use('a'), done('a'), use('b', 'write')]);
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].toolCallId, 'b');
  assert.equal(unmatched[0].tool, 'write');
});

test('id-less results consume same-tool pending uses first, then oldest', () => {
  const unmatched = listUnmatchedAcpToolUses([
    use(null, 'exec'),
    use(null, 'write'),
    { type: 'tool_result', toolCallId: null, tool: 'write' },
  ]);
  assert.equal(unmatched.length, 1);
  assert.equal(unmatched[0].tool, 'exec');
});

test('marker event carries the honest error shape for the SSE stream', () => {
  const marker = buildInterruptedAcpToolResultEvent({ toolCallId: 'x', tool: 'exec' });
  assert.equal(marker.type, 'tool_error');
  assert.equal(marker.content, INTERRUPTED_TOOL_RESULT);
  assert.equal(marker.recoverable, false);
  assert.equal(marker.synthetic, true);
  assert.equal(marker.syntheticKind, INTERRUPTION_MARKER_KIND);
});

test('appending markers is idempotent — the pairing treats them as results', () => {
  const events = [use('a'), use('b', 'write')];
  const unmatched = listUnmatchedAcpToolUses(events);
  assert.equal(unmatched.length, 2);
  const marked = [...events, ...unmatched.map((pending) => buildInterruptedAcpToolResultEvent(pending))];
  assert.deepEqual(listUnmatchedAcpToolUses(marked), []);
});
