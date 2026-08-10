import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAcpEventStreamRegistry,
  buildAcpRuleObservation,
  ACP_ATTENTION_IDLE_HOLD_MS,
  ACP_POLL_ACTIVE_MS,
} from './acp-event-stream.mjs';
import { arbitrateSessionState } from './acp-state-rules.mjs';
import { classifyAcpObservation, reloadAcpStatePacks, resetAcpStatePacksForTest } from './acp-state-packs.mjs';
import { normalizeBridgeEventPayload } from './event-contracts.mjs';

// Same scheduler/harness pattern as acp-event-stream.test.mjs, with the REAL rule
// packs wired in — these tests pin the poller/rules integration end to end.

test.beforeEach(() => {
  resetAcpStatePacksForTest();
  reloadAcpStatePacks({ dir: '/nonexistent-pack-overrides' });
});

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
  };
}

function createHarness({ agent = 'claude' } = {}) {
  const scheduler = createScheduler();
  const state = { batches: [], status: 'running' };
  const local = {
    sessionKey: 'agent:main:acp:child-1',
    parentSessionKey: 'agent:main:hook:trooper:acp:channel:general',
    runId: 'run-1',
    agent,
    events: [],
    transcript: [],
    artifacts: [],
    _eventSequence: 0,
    _historyKeys: new Set(),
    _steerPending: false,
  };
  const registry = createAcpEventStreamRegistry({
    fetchHistory: async () => [],
    fetchSnapshot: async () => ({ status: state.status }),
    captureHistory: () => {
      const batch = state.batches.shift() || [];
      for (const event of batch) {
        event.sequence = ++local._eventSequence;
        local.events.push(event);
      }
      return batch;
    },
    buildFinal: (l, { failed, status, timedOut }) => ({
      type: failed ? 'error' : 'done',
      status: timedOut ? 'timeout' : (failed ? (status || 'failed') : 'completed'),
    }),
    normalizeEvent: normalizeBridgeEventPayload,
    stateRules: { classify: classifyAcpObservation, arbitrate: arbitrateSessionState },
    now: scheduler.now,
    setTimeoutFn: scheduler.setTimeoutFn,
    clearTimeoutFn: scheduler.clearTimeoutFn,
  });
  return { scheduler, registry, local, state };
}

test('a quota failure the legacy regex misses (ACP_SESSION_INIT_FAILED) now fails via rules with a structured errorKind', async () => {
  const { scheduler, registry, local, state } = createHarness({ agent: 'codex' });
  // ACP_SESSION_INIT_FAILED trips FAILURE_RE in the observation layer but NOT
  // looksLikeAcpFailureText — before rule packs, this text never failed the poller.
  local.transcript.push({ id: 'm1', role: 'assistant', content: 'ACP error: ACP_SESSION_INIT_FAILED', createdAt: 1 });
  state.status = 'running';
  let final = null;
  registry.subscribe('s1', local, { onTerminal: (f) => { final = f; } });
  await scheduler.advance(1);
  assert.equal(final?.type, 'error');
  assert.equal(local.status, 'failed');
  assert.equal(local.errorKind, 'acp_session_stale');
});

test('an approval prompt raises awaiting_user attention and emits one permission_request event', async () => {
  const { scheduler, registry, local, state } = createHarness({ agent: 'claude' });
  local.transcript.push({
    id: 'm1',
    role: 'assistant',
    content: 'Do you want to allow Claude to run `npm install`?\n1. Yes\n2. No',
    createdAt: 1,
  });
  state.status = 'running';
  const events = [];
  registry.subscribe('s1', local, { onEvent: (e) => events.push(e) });
  await scheduler.advance(1);
  assert.equal(local.attention, 'awaiting_user');
  const requests = events.filter((e) => e.type === 'permission_request');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].synthetic, true);
  assert.equal(requests[0].source, 'acp_rule');
  assert.ok(requests[0].sequence > 0);
  // Another tick with the same prompt on screen must not re-emit.
  await scheduler.advance(ACP_POLL_ACTIVE_MS + 1);
  assert.equal(events.filter((e) => e.type === 'permission_request').length, 1);
});

test('awaiting_user holds the idle heuristics: no empty-output failure while a prompt is up', async () => {
  const { scheduler, registry, local, state } = createHarness({ agent: 'claude' });
  local.transcript.push({
    id: 'm1',
    role: 'assistant',
    content: 'Do you want to proceed?\n1. Yes',
    createdAt: 1,
  });
  // Idle + prompt: without the hold, "idle with assistant output" would finish as
  // success and "no assistant output" (if output empty) as failed.
  state.status = 'idle';
  local.output = '';
  let final = null;
  registry.subscribe('s1', local, { onTerminal: (f) => { final = f; } });
  await scheduler.advance(1);
  assert.equal(final, null, 'poller must keep waiting while the prompt is live');
  assert.equal(local.attention, 'awaiting_user');
});

test('the idle hold expires so a stale prompt cannot pin the poller forever', async () => {
  const { scheduler, registry, local, state } = createHarness({ agent: 'claude' });
  local.transcript.push({ id: 'm1', role: 'assistant', content: 'Do you want to proceed?\n1. Yes', createdAt: 1 });
  local.output = 'some assistant output';
  state.status = 'idle';
  let final = null;
  registry.subscribe('s1', local, { onTerminal: (f) => { final = f; } });
  await scheduler.advance(1);
  assert.equal(final, null);
  // After the hold window (plus one idle-cadence poll so the next tick actually
  // fires), idle-with-output resolves as a normal terminal.
  await scheduler.advance(ACP_ATTENTION_IDLE_HOLD_MS + 5_000);
  assert.ok(final, 'expired hold falls back to the legacy idle terminal');
});

test('attention clears with a permission_resolved event once the prompt leaves the transcript tail', async () => {
  const { scheduler, registry, local, state } = createHarness({ agent: 'claude' });
  local.transcript.push({ id: 'm1', role: 'assistant', content: 'Do you want to proceed?\n1. Yes', createdAt: 1 });
  state.status = 'running';
  const events = [];
  registry.subscribe('s1', local, { onEvent: (e) => events.push(e) });
  await scheduler.advance(1);
  assert.equal(local.attention, 'awaiting_user');
  // Approval granted: the CLI answers with fresh output that pushes the prompt away.
  local.transcript = [{ id: 'm2', role: 'assistant', content: 'Installed 12 packages successfully.', createdAt: 2 }];
  await scheduler.advance(ACP_POLL_ACTIVE_MS + 1);
  assert.equal(local.attention, null);
  assert.equal(events.filter((e) => e.type === 'permission_resolved').length, 1);
});

test('a terminal session never reports lingering attention', async () => {
  const { scheduler, registry, local, state } = createHarness({ agent: 'claude' });
  local.transcript.push({ id: 'm1', role: 'assistant', content: 'Do you want to proceed?\n1. Yes', createdAt: 1 });
  state.status = 'running';
  let final = null;
  registry.subscribe('s1', local, { onTerminal: (f) => { final = f; } });
  await scheduler.advance(1);
  assert.equal(local.attention, 'awaiting_user');
  state.status = 'failed';
  await scheduler.advance(ACP_POLL_ACTIVE_MS + 1);
  assert.ok(final);
  assert.equal(local.attention, null);
  assert.equal(local.attentionSince, null);
});

test('a pushed typed permission event raises attention without waiting for a poll', async () => {
  const { scheduler, registry, local, state } = createHarness({ agent: 'opencode' });
  state.status = 'running';
  const events = [];
  registry.subscribe('s1', local, { onEvent: (e) => events.push(e) });
  await scheduler.advance(1);
  const result = registry.ingestExternalEvents(local.sessionKey, [
    { type: 'permission_request', content: 'Tool wants to run rm -rf ./dist' },
  ]);
  assert.equal(result.accepted, 1);
  assert.equal(local.attention, 'awaiting_user');
});

test('buildAcpRuleObservation puts the newest text last so tail rules see the live prompt', () => {
  const observation = buildAcpRuleObservation({
    transcript: [
      { role: 'user', content: 'please install deps' },
      { role: 'assistant', content: 'Do you want to proceed?\n1. Yes' },
    ],
    output: '',
    steerResponse: '',
  });
  assert.ok(observation.text.endsWith('1. Yes'));
});

test('without stateRules the registry behaves exactly as before (no attention fields ever set)', async () => {
  const scheduler = createScheduler();
  const local = {
    sessionKey: 'k', runId: 'r', agent: 'claude', events: [], artifacts: [],
    transcript: [{ id: 'm1', role: 'assistant', content: 'Do you want to proceed?\n1. Yes', createdAt: 1 }],
    _eventSequence: 0, _historyKeys: new Set(), _steerPending: false,
  };
  const registry = createAcpEventStreamRegistry({
    fetchHistory: async () => [],
    fetchSnapshot: async () => ({ status: 'running' }),
    captureHistory: () => [],
    now: scheduler.now,
    setTimeoutFn: scheduler.setTimeoutFn,
    clearTimeoutFn: scheduler.clearTimeoutFn,
  });
  registry.subscribe('s1', local, {});
  await scheduler.advance(1);
  assert.equal(local.attention, undefined);
});
