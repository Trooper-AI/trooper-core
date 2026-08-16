import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The lib modules are behavior-tested in their own files; what those tests
// cannot see is whether index.mjs and the handlers actually CALL them —
// reverting only the integration lines would leave every module test green.
// These are deliberate source-text assertions (same trade-off as the repo's
// existing monolith-wiring tests): they fail if the wiring is removed.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');

test('index.mjs wires the tool ledger tap, tape wrap, watchdog start, and purge additions', () => {
  const src = read('index.mjs');
  assert.match(src, /toolLedger\.observeBridgeEvent\(/, 'ledger tap missing from the onEvent wrapper');
  assert.match(src, /gateway\._handleFrame = /, 'tape wrap of gateway._handleFrame missing');
  assert.match(src, /runWatchdog\.start\(\)/, 'watchdog never started');
  assert.match(src, /ownedOrphanMs: runWatchdogConfig\.ownedOrphanMs/, 'watchdog owned threshold not wired from config');
  assert.match(src, /tool_ledger/, 'tool_ledger missing from the purge list');
  assert.match(src, /resolveSpillSettings\(process\.env\)/, 'purge does not clear the spill dir');
});

test('chat-handler wires liveness marks and spill', () => {
  const src = read('lib/chat-handler.mjs');
  assert.match(src, /markRunStarted\(runId/, 'chat run never marked started');
  assert.match(src, /touchRunActivity\(runId\)/, 'chat stream events never touch liveness');
  assert.match(src, /markRunEnded\(runId\)/, 'chat finally never clears the registry');
  assert.match(src, /maybeSpillToolResultText\(rawSerialized\)/, 'chat tool results never spill');
  assert.match(src, /spillOutcome\.spilled \? null : structuredResult/, 'spilled chat results must drop the inline structured result');
});

test('task-handler wires liveness marks and spill', () => {
  const src = read('lib/task-handler.mjs');
  assert.match(src, /markRunStarted\(runId/, 'task run never marked started');
  assert.match(src, /touchRunActivity\(runId\)/, 'task stream events never touch liveness');
  assert.match(src, /markRunEnded\(runId\)/, 'task finally never clears the registry');
  assert.match(src, /raw: spillOutcome\.text, result: null/, 'spilled task results must drop the inline result');
});
