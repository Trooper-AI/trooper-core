import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrate } from '../db/migrate.mjs';
import {
  ORPHANED_RUN_CLOSE_KIND,
  ORPHANED_RUN_MESSAGE,
  ORPHANED_RUN_REASON,
  RUN_ORPHAN_DEFAULT_MS,
  RUN_WATCHDOG_DEFAULT_INTERVAL_MS,
  SYNTHETIC_RUN_EVENT_SEQ_BASE,
  buildOrphanRunCloseEvent,
  createRunActivityRegistry,
  createRunWatchdog,
  resolveRunWatchdogConfig,
} from './run-watchdog.mjs';

const T0 = 10_000_000;

function makeHarness({ now = T0, orphanMs = RUN_ORPHAN_DEFAULT_MS, ...overrides } = {}) {
  const sqlite = new Database(':memory:');
  migrate(sqlite);
  sqlite.pragma('foreign_keys = ON'); // mirror production (db/index.mjs)
  const clock = { now };
  const broadcasts = [];
  const logs = [];
  const registry = createRunActivityRegistry({ now: () => clock.now });
  const resolverCalls = [];
  let resolverResult = false;
  const watchdog = createRunWatchdog({
    sqlite,
    registry,
    now: () => clock.now,
    orphanMs,
    resolvePendingRunExternally: (args) => { resolverCalls.push(args); return resolverResult; },
    broadcast: (type, payload) => broadcasts.push({ type, payload }),
    log: {
      info: (msg) => logs.push({ level: 'info', msg }),
      warn: (msg) => logs.push({ level: 'warn', msg }),
    },
    ...overrides,
  });
  // The boot floor pins everything to the watchdog's creation time — tests
  // advance past it explicitly to exercise closure.
  const advance = (ms) => { clock.now += ms; };
  const seedRun = (id, { status = 'running', startedAt = clock.now } = {}) => {
    sqlite.prepare(`INSERT INTO runs (id, agent_id, agent_name, source, channel, status, started_at, created_at)
      VALUES (?, 'agent-1', 'Test Agent', 'chat', 'general', ?, ?, ?)`).run(id, status, startedAt, startedAt);
  };
  const seedEvent = (runId, seq, timestamp, event = 'tool_result') => {
    sqlite.prepare('INSERT INTO run_events (run_id, seq, event, data, timestamp) VALUES (?, ?, ?, ?, ?)')
      .run(runId, seq, event, '{}', timestamp);
  };
  const run = (id) => sqlite.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  const events = (id) => sqlite.prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq').all(id);
  return {
    sqlite, clock, broadcasts, logs, registry, watchdog, resolverCalls, advance,
    setResolverResult: (v) => { resolverResult = v; },
    seedRun, seedEvent, run, events,
  };
}

test('config defaults: 60s scan, 10min orphan threshold, enabled', () => {
  const config = resolveRunWatchdogConfig({});
  assert.equal(config.intervalMs, RUN_WATCHDOG_DEFAULT_INTERVAL_MS);
  assert.equal(config.orphanMs, RUN_ORPHAN_DEFAULT_MS);
  assert.equal(config.enabled, true);
});

test('config: TROOPER_RUN_WATCHDOG_MS=0 disables; TROOPER_RUN_ORPHAN_MS overrides', () => {
  const config = resolveRunWatchdogConfig({ TROOPER_RUN_WATCHDOG_MS: '0', TROOPER_RUN_ORPHAN_MS: '120000' });
  assert.equal(config.enabled, false);
  assert.equal(config.orphanMs, 120000);
});

test('config: empty env values mean unset, never a collapsed threshold', () => {
  const config = resolveRunWatchdogConfig({ TROOPER_RUN_ORPHAN_MS: '', TROOPER_RUN_WATCHDOG_MS: '  ' });
  assert.equal(config.orphanMs, RUN_ORPHAN_DEFAULT_MS);
  assert.equal(config.intervalMs, RUN_WATCHDOG_DEFAULT_INTERVAL_MS);
  assert.equal(config.enabled, true);
});

test('config: ownedOrphanMs defaults to 60min and never drops below orphanMs', () => {
  assert.equal(resolveRunWatchdogConfig({}).ownedOrphanMs, 60 * 60_000);
  const floored = resolveRunWatchdogConfig({ TROOPER_RUN_ORPHAN_MS: '1800000', TROOPER_RUN_OWNED_ORPHAN_MS: '60000' });
  assert.equal(floored.ownedOrphanMs, floored.orphanMs);
});

test('the synthetic close event carries markers no live path emits', () => {
  const built = buildOrphanRunCloseEvent({ runId: 'r1', sessionKey: 's1', startedAt: 1, lastActivityAt: 2, now: 3 });
  assert.equal(built.event, 'error'); // real stream vocabulary chat-handler consumes
  assert.equal(built.data.synthetic, true);
  assert.equal(built.data.syntheticKind, ORPHANED_RUN_CLOSE_KIND);
  assert.equal(built.data.reason, ORPHANED_RUN_REASON);
  assert.equal(built.data.source, 'run_watchdog');
  assert.equal(built.data.error, ORPHANED_RUN_MESSAGE);
  assert.equal(built.timestamp, 3);
});

test('a recent running run is left alone', () => {
  const h = makeHarness();
  h.seedRun('fresh', { startedAt: h.clock.now - 60_000 });
  assert.deepEqual(h.watchdog.scanOnce(), []);
  assert.equal(h.run('fresh').status, 'running');
});

test('the boot floor protects everything until the process has been up for the threshold', () => {
  const h = makeHarness();
  // Stranded long before this process booted — but we JUST booted, so for all
  // we know the gateway is still streaming it. Nothing may be closed yet.
  h.seedRun('pre-boot', { startedAt: h.clock.now - 20 * 60_000 });
  assert.deepEqual(h.watchdog.scanOnce(), []);
  assert.equal(h.run('pre-boot').status, 'running');
});

test('a stale running run with no activity anywhere is closed with a synthetic terminal', () => {
  const h = makeHarness();
  const startedAt = h.clock.now - 20 * 60_000;
  h.seedRun('orphan', { startedAt });
  h.advance(RUN_ORPHAN_DEFAULT_MS); // past the boot floor
  const repairs = h.watchdog.scanOnce();
  assert.deepEqual(repairs.map((r) => r.action), ['closed']);

  const row = h.run('orphan');
  assert.equal(row.status, 'failed');
  assert.equal(row.finished_at, h.clock.now);
  assert.equal(row.duration_ms, h.clock.now - startedAt);
  assert.equal(row.error, ORPHANED_RUN_MESSAGE);

  const [ev] = h.events('orphan');
  assert.equal(ev.event, 'error');
  assert.ok(ev.seq >= SYNTHETIC_RUN_EVENT_SEQ_BASE, 'synthetic seq stays clear of live flush seqs');
  const data = JSON.parse(ev.data);
  assert.equal(data.synthetic, true);
  assert.equal(data.syntheticKind, ORPHANED_RUN_CLOSE_KIND);
  assert.equal(data.reason, ORPHANED_RUN_REASON);

  // Live clients hear about it through the existing emit path.
  assert.deepEqual(h.broadcasts.map((b) => b.type), ['agent:error', 'agent:typing_stop']);
  assert.equal(h.broadcasts[0].payload.runId, 'orphan');
  assert.equal(h.broadcasts[0].payload.synthetic, true);

  // Every repair is logged.
  assert.ok(h.logs.some((l) => l.level === 'info' && /closed orphaned run/.test(l.msg)));
});

test('recent run_events activity keeps a long run open', () => {
  const h = makeHarness();
  h.seedRun('busy', { startedAt: h.clock.now - 60 * 60_000 });
  h.seedEvent('busy', 0, h.clock.now - 30_000);
  assert.deepEqual(h.watchdog.scanOnce(), []);
  assert.equal(h.run('busy').status, 'running');
});

test('a recent in-memory touch keeps a long run open', () => {
  const h = makeHarness();
  h.seedRun('streaming', { startedAt: h.clock.now - 60 * 60_000 });
  h.registry.markStarted('streaming', { sessionKey: 'agent:main:x' });
  h.registry.touch('streaming');
  assert.deepEqual(h.watchdog.scanOnce(), []);
  assert.equal(h.run('streaming').status, 'running');
});

test('an owned run gets the larger owned threshold — quiet for 20 minutes is left alone', () => {
  const h = makeHarness();
  h.seedRun('long-tool-call', { startedAt: h.clock.now });
  h.registry.markStarted('long-tool-call', { sessionKey: 'agent:main:ltc' });
  h.advance(20 * 60_000); // silent for 20 min — a normal long build
  h.setResolverResult(true);
  assert.deepEqual(h.watchdog.scanOnce(), []);
  assert.equal(h.resolverCalls.length, 0, 'the pending must not be rejected for a normally-quiet owned run');
  assert.equal(h.run('long-tool-call').status, 'running');
});

test('a stale run this process still owns is closed by rejecting its pending, not by direct write', () => {
  const h = makeHarness();
  h.seedRun('held', { startedAt: h.clock.now });
  h.registry.markStarted('held', { sessionKey: 'agent:main:held' });
  h.advance(61 * 60_000); // an hour of total silence on an owned run is a stuck pending
  h.setResolverResult(true);

  const repairs = h.watchdog.scanOnce();
  assert.deepEqual(repairs, [{ runId: 'held', action: 'pending_rejected' }]);
  assert.deepEqual(h.resolverCalls, [{ runId: null, sessionKey: 'agent:main:held', successful: false, source: 'run_watchdog' }]);
  // The owning handler's failure path writes the terminal state — not us.
  assert.equal(h.run('held').status, 'running');
  assert.equal(h.events('held').length, 0);
  assert.equal(h.broadcasts.length, 0);
});

test('an owned run whose pending cannot be rejected is never direct-closed (the owner finally block is the single writer)', () => {
  const h = makeHarness();
  h.seedRun('steer', { startedAt: h.clock.now });
  h.registry.markStarted('steer', { sessionKey: 'agent:main:steer' });
  h.advance(61 * 60_000);
  h.setResolverResult(false); // e.g. a steer pending with expectFinal:false — no match
  assert.deepEqual(h.watchdog.scanOnce(), []);
  assert.equal(h.run('steer').status, 'running');
  assert.equal(h.events('steer').length, 0);

  // Once the owner clears the entry (its finally ran), the next sweep may close it.
  h.registry.markEnded('steer');
  const repairs = h.watchdog.scanOnce();
  assert.deepEqual(repairs.map((r) => r.action), ['closed']);
  assert.equal(h.run('steer').status, 'failed');
});

test('a closed run is not repaired twice', () => {
  const h = makeHarness();
  h.seedRun('once', { startedAt: h.clock.now - 20 * 60_000 });
  h.advance(RUN_ORPHAN_DEFAULT_MS);
  assert.equal(h.watchdog.scanOnce().length, 1);
  assert.equal(h.watchdog.scanOnce().length, 0);
  assert.equal(h.events('once').length, 1);
});

test('completed and failed runs are never touched', () => {
  const h = makeHarness();
  h.seedRun('done', { status: 'completed', startedAt: h.clock.now - 60 * 60_000 });
  h.seedRun('dead', { status: 'failed', startedAt: h.clock.now - 60 * 60_000 });
  assert.deepEqual(h.watchdog.scanOnce(), []);
});

test('synthetic seq clears existing run_events rows (UNIQUE(run_id, seq) is never violated)', () => {
  const h = makeHarness();
  h.seedRun('flushed', { startedAt: h.clock.now - 30 * 60_000 });
  h.seedEvent('flushed', 0, h.clock.now - 25 * 60_000);
  h.seedEvent('flushed', 1, h.clock.now - 25 * 60_000);
  h.advance(30 * 60_000);
  const [repair] = h.watchdog.scanOnce();
  assert.equal(repair.action, 'closed');
  assert.equal(repair.seq, SYNTHETIC_RUN_EVENT_SEQ_BASE);
  assert.equal(h.events('flushed').length, 3);
});

test('a sweep repairs at most maxRepairsPerSweep runs', () => {
  const h = makeHarness({ maxRepairsPerSweep: 1 });
  h.seedRun('stale-a', { startedAt: h.clock.now - 20 * 60_000 });
  h.seedRun('stale-b', { startedAt: h.clock.now - 20 * 60_000 });
  h.advance(RUN_ORPHAN_DEFAULT_MS);
  assert.equal(h.watchdog.scanOnce().length, 1);
  assert.equal(h.watchdog.scanOnce().length, 1); // the second waits for the next sweep
  assert.equal(h.watchdog.scanOnce().length, 0);
});

test('ancient strandings are closed without a broadcast (no error toast for a run from days ago)', () => {
  const h = makeHarness();
  h.seedRun('ancient', { startedAt: h.clock.now - 3 * 24 * 60 * 60_000 });
  h.advance(RUN_ORPHAN_DEFAULT_MS);
  const repairs = h.watchdog.scanOnce();
  assert.deepEqual(repairs.map((r) => r.action), ['closed']);
  assert.equal(h.run('ancient').status, 'failed');
  assert.equal(h.broadcasts.length, 0);
});

test('start() with the kill switch does nothing; otherwise it schedules an unref-able interval', () => {
  const h = makeHarness();
  const disabled = createRunWatchdog({ sqlite: h.sqlite, intervalMs: 0, log: { info() {}, warn() {} } });
  assert.equal(disabled.start(), false);
  assert.equal(disabled.running, false);

  let scheduled = null;
  const enabled = createRunWatchdog({
    sqlite: h.sqlite,
    intervalMs: 1000,
    log: { info() {}, warn() {} },
    setIntervalFn: (fn, ms) => { scheduled = { fn, ms }; return { unref() { scheduled.unrefed = true; } }; },
    clearIntervalFn: () => { scheduled = null; },
  });
  assert.equal(enabled.start(), true);
  assert.equal(enabled.running, true);
  assert.equal(scheduled.ms, 1000);
  assert.equal(scheduled.unrefed, true);
  enabled.stop();
  assert.equal(enabled.running, false);
});

test('one broken row does not stop the sweep', () => {
  const h = makeHarness();
  h.seedRun('good-1', { startedAt: h.clock.now - 20 * 60_000 });
  h.seedRun('good-2', { startedAt: h.clock.now - 20 * 60_000 });
  h.advance(RUN_ORPHAN_DEFAULT_MS);
  // Break the registry for one run id only.
  const originalGet = h.registry.get;
  h.registry.get = (runId) => {
    if (runId === 'good-1') throw new Error('boom');
    return originalGet(runId);
  };
  const repairs = h.watchdog.scanOnce();
  assert.deepEqual(repairs.map((r) => r.runId), ['good-2']);
  assert.ok(h.logs.some((l) => l.level === 'warn' && /repair failed for run good-1/.test(l.msg)));
});

test('registry prunes entries whose owner never cleaned up', () => {
  const clock = { now: T0 };
  const registry = createRunActivityRegistry({ now: () => clock.now });
  registry.markStarted('stale-entry', { sessionKey: 'x' });
  clock.now += 25 * 60 * 60 * 1000; // > 24h
  registry.prune();
  assert.equal(registry.get('stale-entry'), null);
});
