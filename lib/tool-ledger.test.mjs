import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrate } from '../db/migrate.mjs';
import {
  TOOL_LEDGER_DEFAULT_WINDOW_MS,
  createToolLedger,
  hashToolArgs,
  resolveToolLedgerMode,
  stableStringify,
} from './tool-ledger.mjs';

function makeLedger({ startAt = 1_000_000 } = {}) {
  const sqlite = new Database(':memory:');
  migrate(sqlite);
  const clock = { now: startAt };
  const warnings = [];
  let nextId = 0;
  const ledger = createToolLedger({
    sqlite,
    now: () => clock.now,
    id: () => `row-${++nextId}`,
    log: { warn: (msg) => warnings.push(msg) },
  });
  const rows = () => sqlite.prepare('SELECT * FROM tool_ledger ORDER BY created_at, id').all();
  return { sqlite, clock, warnings, ledger, rows };
}

test('mode defaults to observe and only explicit off-values disable', () => {
  assert.equal(resolveToolLedgerMode({}), 'observe');
  assert.equal(resolveToolLedgerMode({ TROOPER_TOOL_LEDGER: 'observe' }), 'observe');
  assert.equal(resolveToolLedgerMode({ TROOPER_TOOL_LEDGER: 'anything-else' }), 'observe');
  for (const off of ['off', 'OFF', '0', 'false', 'disabled']) {
    assert.equal(resolveToolLedgerMode({ TROOPER_TOOL_LEDGER: off }), 'off');
  }
});

test('stableStringify is key-order independent and never throws on odd values', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 3, c: 4 }] }), stableStringify({ a: [2, { c: 4, d: 3 }], b: 1 }));
  const cyclic = { name: 'x' };
  cyclic.self = cyclic;
  assert.doesNotThrow(() => stableStringify(cyclic));
  assert.doesNotThrow(() => stableStringify({ fn: () => {}, big: 10n, u: undefined }));
});

test('hashToolArgs gives the same hash for the same logical args', () => {
  assert.equal(hashToolArgs({ path: '/a', mode: 'r' }), hashToolArgs({ mode: 'r', path: '/a' }));
  assert.notEqual(hashToolArgs({ path: '/a' }), hashToolArgs({ path: '/b' }));
  assert.equal(hashToolArgs(undefined), hashToolArgs({}));
});

test('recordCall inserts an observed row; recordOutcome updates it', () => {
  const { ledger, rows } = makeLedger();
  const inserted = ledger.recordCall({
    sessionKey: 'agent:main:chat', runId: 'run-1', toolCallId: 'call-1',
    tool: 'exec', argsHash: hashToolArgs({ command: 'ls' }),
  });
  assert.ok(inserted.id);
  assert.equal(inserted.dupOf, null);
  assert.equal(rows()[0].status, 'observed');

  assert.equal(ledger.recordOutcome('call-1', true), 1);
  assert.equal(rows()[0].status, 'succeeded');
});

test('failed outcomes are recorded as failed', () => {
  const { ledger, rows } = makeLedger();
  ledger.recordCall({ toolCallId: 'call-1', tool: 'exec', argsHash: 'h' });
  ledger.recordOutcome('call-1', false);
  assert.equal(rows()[0].status, 'failed');
});

test('recordOutcome without a matching call is a harmless no-op', () => {
  const { ledger } = makeLedger();
  assert.equal(ledger.recordOutcome('missing-call', true), 0);
  assert.equal(ledger.recordOutcome(null, true), 0);
});

test('a second call with the same tool+args inside the window is stamped dup_of and warned', () => {
  const { ledger, rows, warnings, clock } = makeLedger();
  const argsHash = hashToolArgs({ command: 'deploy' });
  const first = ledger.recordCall({ toolCallId: 'call-1', tool: 'exec', argsHash });
  clock.now += 60_000; // one minute later, well inside the 15-minute window
  const second = ledger.recordCall({ toolCallId: 'call-2', tool: 'exec', argsHash });
  assert.equal(second.dupOf, first.id);
  assert.equal(rows()[1].dup_of, first.id);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^\[tool-ledger\] duplicate /);
});

test('the same args outside the window are not duplicates', () => {
  const { ledger, warnings, clock } = makeLedger();
  const argsHash = hashToolArgs({ command: 'deploy' });
  ledger.recordCall({ toolCallId: 'call-1', tool: 'exec', argsHash });
  clock.now += TOOL_LEDGER_DEFAULT_WINDOW_MS + 1;
  const second = ledger.recordCall({ toolCallId: 'call-2', tool: 'exec', argsHash });
  assert.equal(second.dupOf, null);
  assert.equal(warnings.length, 0);
});

test('findRecentDuplicate honours an explicit windowMs', () => {
  const { ledger, clock } = makeLedger();
  const argsHash = hashToolArgs({ q: 'x' });
  ledger.recordCall({ toolCallId: 'call-1', tool: 'web_search', argsHash });
  clock.now += 5_000;
  assert.ok(ledger.findRecentDuplicate({ tool: 'web_search', argsHash }));
  assert.equal(ledger.findRecentDuplicate({ tool: 'web_search', argsHash, windowMs: 1_000 }), null);
});

test('re-delivery of the same toolCallId is not recorded twice', () => {
  // Live stream + history replay can deliver the same logical call twice.
  const { ledger, rows } = makeLedger();
  ledger.recordCall({ toolCallId: 'call-1', tool: 'exec', argsHash: 'h' });
  assert.equal(ledger.recordCall({ toolCallId: 'call-1', tool: 'exec', argsHash: 'h' }), null);
  assert.equal(rows().length, 1);
});

test('observeBridgeEvent records tool_start and tool_result and ignores other events', () => {
  const { ledger, rows } = makeLedger();
  ledger.observeBridgeEvent('text', { eventId: 'e-text', text: 'hello' });
  ledger.observeBridgeEvent('tool_start', {
    eventId: 'e-1', sessionKey: 's', runId: 'r', toolCallId: 'call-1',
    tool: 'read', params: { path: '/tmp/a' },
  });
  ledger.observeBridgeEvent('tool_result', { eventId: 'e-2', toolCallId: 'call-1', success: true });
  const all = rows();
  assert.equal(all.length, 1);
  assert.equal(all[0].tool, 'read');
  assert.equal(all[0].status, 'succeeded');
  assert.equal(all[0].args_hash, hashToolArgs({ path: '/tmp/a' }));
});

test('observeBridgeEvent dedupes duplicate deliveries by eventId', () => {
  const { ledger, rows } = makeLedger();
  const payload = { eventId: 'e-1', toolCallId: 'call-1', tool: 'exec', params: { command: 'ls' } };
  ledger.observeBridgeEvent('tool_start', payload);
  ledger.observeBridgeEvent('tool_start', payload); // e.g. SSE relay saw it too
  assert.equal(rows().length, 1);
});

test('observeBridgeEvent treats tool_result success=false as failed', () => {
  const { ledger, rows } = makeLedger();
  ledger.observeBridgeEvent('tool_start', { eventId: 'e-1', toolCallId: 'call-1', tool: 'exec', params: {} });
  ledger.observeBridgeEvent('tool_result', { eventId: 'e-2', toolCallId: 'call-1', success: false });
  assert.equal(rows()[0].status, 'failed');
});

test('observeBridgeEvent never throws, even when persistence fails', () => {
  const { ledger, sqlite, warnings } = makeLedger();
  sqlite.exec('DROP TABLE tool_ledger'); // simulate a broken database mid-run
  assert.doesNotThrow(() => {
    ledger.observeBridgeEvent('tool_start', { eventId: 'e-1', toolCallId: 'c', tool: 'exec', params: {} });
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /observe failed/);
});
