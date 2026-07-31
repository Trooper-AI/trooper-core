import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAcpEventStreamRegistry,
  ACP_POLL_ACTIVE_MS,
  ACP_POLL_IDLE_MS,
  ACP_POLL_PUSH_BACKSTOP_MS,
} from './acp-event-stream.mjs';
import { normalizeBridgeEventPayload } from './event-contracts.mjs';

function createScheduler() {
  let nowMs = 1_000_000;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => nowMs,
    setTimeoutFn: (fn, delay) => {
      const id = nextId++;
      timers.set(id, { fn, at: nowMs + Math.max(0, Number(delay) || 0) });
      return id;
    },
    clearTimeoutFn: (id) => timers.delete(id),
    async advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        nowMs = Math.max(nowMs, due[1].at);
        timers.delete(due[0]);
        due[1].fn();
        await new Promise((resolve) => setImmediate(resolve));
      }
      nowMs = target;
    },
    pendingDelays: () => [...timers.values()].map((timer) => timer.at - nowMs),
  };
}

function createHarness({ synthesizeInterruptionMarkers } = {}) {
  const scheduler = createScheduler();
  const calls = { fetchHistory: 0, fetchSnapshot: 0, cleanup: [] };
  const state = { batches: [], status: 'running' };
  const local = {
    sessionKey: 'agent:main:acp:child-1',
    parentSessionKey: 'agent:main:hook:trooper:acp:channel:general',
    runId: 'run-1',
    events: [],
    transcript: [],
    artifacts: [],
    _eventSequence: 0,
    _historyKeys: new Set(),
  };
  const registry = createAcpEventStreamRegistry({
    fetchHistory: async () => {
      calls.fetchHistory += 1;
      return [];
    },
    fetchSnapshot: async () => {
      calls.fetchSnapshot += 1;
      return { status: state.status };
    },
    captureHistory: () => {
      const batch = state.batches.shift() || [];
      for (const event of batch) {
        event.sequence = ++local._eventSequence;
        local.events.push(event);
      }
      return batch;
    },
    synthesizeInterruptionMarkers: synthesizeInterruptionMarkers || (() => []),
    buildFinal: (l, { failed, status, timedOut }) => ({
      type: failed ? 'error' : 'done',
      status: timedOut ? 'timeout' : (failed ? (status || 'failed') : 'completed'),
    }),
    onTerminalCleanup: (l) => calls.cleanup.push(l.sessionKey),
    normalizeEvent: normalizeBridgeEventPayload,
    now: scheduler.now,
    setTimeoutFn: scheduler.setTimeoutFn,
    clearTimeoutFn: scheduler.clearTimeoutFn,
  });
  return { scheduler, registry, local, calls, state };
}

test('two subscribers share one poller — one history fetch per tick', async () => {
  const { scheduler, registry, local, calls } = createHarness();
  const seenA = [];
  const seenB = [];
  registry.subscribe('s1', local, { onEvent: (e) => seenA.push(e) });
  registry.subscribe('s1', local, { onEvent: (e) => seenB.push(e) });
  await scheduler.advance(1);
  assert.equal(calls.fetchHistory, 1);
  assert.equal(registry.getStats().pollers, 1);
  assert.equal(registry.getStats().subscribers, 2);
});

test('events fan out to every subscriber with populated child envelopes', async () => {
  const { scheduler, registry, local, state } = createHarness();
  const seen = [];
  state.batches.push([{ type: 'tool_use', tool: 'exec', content: 'ls', createdAt: 5 }]);
  registry.subscribe('s1', local, { onEvent: (e) => seen.push(e) });
  await scheduler.advance(1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'tool_use');
  assert.equal(seen[0].childSessionKey, 'agent:main:acp:child-1');
  assert.equal(seen[0].sessionKey, 'agent:main:hook:trooper:acp:channel:general');
  assert.equal(seen[0].source, 'acp_poll');
  assert.equal(seen[0].sequence, 1);
  assert.ok(seen[0].payloadVersion >= 2);
});

test('interval adapts: active while events flow, idle after three empty polls', async () => {
  const { scheduler, registry, local, state } = createHarness();
  state.batches.push([{ type: 'message', content: 'hi', createdAt: 1 }]);
  registry.subscribe('s1', local, { onEvent: () => {} });
  await scheduler.advance(0);
  assert.deepEqual(scheduler.pendingDelays(), [ACP_POLL_ACTIVE_MS]);
  await scheduler.advance(ACP_POLL_ACTIVE_MS); // empty 1
  await scheduler.advance(ACP_POLL_ACTIVE_MS); // empty 2
  await scheduler.advance(ACP_POLL_ACTIVE_MS); // empty 3 -> idle
  assert.deepEqual(scheduler.pendingDelays(), [ACP_POLL_IDLE_MS]);
  state.batches.push([{ type: 'message', content: 'more', createdAt: 2 }]);
  await scheduler.advance(ACP_POLL_IDLE_MS);
  assert.deepEqual(scheduler.pendingDelays(), [ACP_POLL_ACTIVE_MS]);
});

test('push ingestion dedupes, reaches subscribers, and stretches polling to the backstop', async () => {
  const { scheduler, registry, local } = createHarness();
  const seen = [];
  registry.subscribe('s1', local, { onEvent: (e) => seen.push(e) });
  await scheduler.advance(0);
  const first = registry.ingestExternalEvents('agent:main:acp:child-1', [
    { kind: 'tool_result', toolCallId: 'c1', contentText: 'done' },
  ]);
  assert.equal(first.accepted, 1);
  const dupe = registry.ingestExternalEvents('agent:main:acp:child-1', [
    { kind: 'tool_result', toolCallId: 'c1', contentText: 'done' },
  ]);
  assert.equal(dupe.accepted, 0);
  assert.equal(seen.filter((e) => e.source === 'acp_push').length, 1);
  assert.equal(seen[seen.length - 1].content, 'done');
  await scheduler.advance(ACP_POLL_ACTIVE_MS);
  assert.deepEqual(scheduler.pendingDelays(), [ACP_POLL_PUSH_BACKSTOP_MS]);
  assert.equal(registry.getStats().pushObserved, 1);
});

test('unknown session keys drop pushed events instead of throwing', () => {
  const { registry } = createHarness();
  const result = registry.ingestExternalEvents('agent:main:acp:nope', [{ kind: 'x' }]);
  assert.equal(result.accepted, 0);
  assert.equal(result.dropped, 1);
});

test('failed terminal synthesizes markers, fans out the final, and cleans up once', async () => {
  const markers = [{ type: 'tool_error', tool: 'exec', content: '[interrupted]', synthetic: true }];
  const { scheduler, registry, local, calls, state } = createHarness({
    synthesizeInterruptionMarkers: () => markers,
  });
  const seenA = [];
  const seenB = [];
  let finalA = null;
  let finalB = null;
  registry.subscribe('s1', local, { onEvent: (e) => seenA.push(e), onTerminal: (f) => { finalA = f; } });
  registry.subscribe('s1', local, { onEvent: (e) => seenB.push(e), onTerminal: (f) => { finalB = f; } });
  state.status = 'failed';
  await scheduler.advance(1);
  assert.equal(finalA.type, 'error');
  assert.equal(finalB.type, 'error');
  assert.equal(seenA.filter((e) => e.type === 'tool_error').length, 1);
  assert.equal(seenB.filter((e) => e.type === 'tool_error').length, 1);
  assert.deepEqual(calls.cleanup, ['agent:main:acp:child-1']);
});

test('a late subscriber after terminal replays buffered events then gets the final', async () => {
  const { scheduler, registry, local, state } = createHarness();
  state.batches.push([{ type: 'message', content: 'work', createdAt: 1 }]);
  registry.subscribe('s1', local, { onEvent: () => {} });
  await scheduler.advance(1);
  state.status = 'completed';
  await scheduler.advance(ACP_POLL_ACTIVE_MS);
  const replayed = [];
  let final = null;
  registry.subscribe('s1', local, {
    onEvent: (e) => replayed.push(e),
    onTerminal: (f) => { final = f; },
  });
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].source, 'acp_replay');
  assert.equal(final.type, 'done');
});

test('replayFromSequence resumes a reconnecting client without duplicates', async () => {
  const { scheduler, registry, local, state } = createHarness();
  state.batches.push([
    { type: 'message', content: 'one', createdAt: 1 },
    { type: 'message', content: 'two', createdAt: 2 },
  ]);
  const first = [];
  const unsubscribe = registry.subscribe('s1', local, { onEvent: (e) => first.push(e) });
  await scheduler.advance(1);
  assert.equal(first.length, 2);
  unsubscribe();
  const resumed = [];
  registry.subscribe('s1', local, { onEvent: (e) => resumed.push(e), replayFromSequence: 1 });
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].content, 'two');
});

test('poller lingers after the last unsubscribe, then tears down', async () => {
  const { scheduler, registry, local } = createHarness();
  const unsubscribe = registry.subscribe('s1', local, { onEvent: () => {} });
  await scheduler.advance(1);
  unsubscribe();
  assert.equal(registry.getStats().pollers, 1);
  await scheduler.advance(60_000);
  assert.equal(registry.getStats().pollers, 0);
  assert.equal(registry.indexBySessionKey('agent:main:acp:child-1'), null);
});
