import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_COMPLETION_PLUGIN_ID,
  RunTerminalMarkerStore,
  buildRunCompletionPluginFiles,
} from './run-completion-plugin.mjs';

test('marker store records and retrieves by runId and sessionKey, with TTL pruning', () => {
  const store = new RunTerminalMarkerStore({ ttlMs: 1000 });
  store.record({ runId: 'run-1', sessionKey: 'agent:main:hook:trooper:lead', kind: 'agent_end', success: true, endedAt: Date.now() });
  assert.equal(store.get({ runId: 'run-1' })?.kind, 'agent_end');
  assert.equal(store.get({ sessionKey: 'agent:main:hook:trooper:lead' })?.runId, 'run-1');
  assert.equal(store.get({ runId: 'other' }), null);

  store.record({ runId: 'old-run', kind: 'agent_end', endedAt: Date.now() - 5000 });
  assert.equal(store.get({ runId: 'old-run' }), null, 'expired markers must prune');
});

test('plugin files carry manifest, entry with endpoints/token, and hook registrations', () => {
  const files = buildRunCompletionPluginFiles({ bridgePort: 3002, token: 'secret-token' });
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.content]));

  const manifest = JSON.parse(byPath['openclaw.plugin.json']);
  assert.equal(manifest.id, RUN_COMPLETION_PLUGIN_ID);
  assert.ok(manifest.configSchema);

  const pkg = JSON.parse(byPath['package.json']);
  assert.equal(pkg.type, 'module');
  assert.deepEqual(pkg.openclaw.extensions, ['./index.js']);

  const entry = byPath['index.js'];
  assert.match(entry, /host\.docker\.internal:3002\/internal\/run-complete/);
  assert.match(entry, /172\.17\.0\.1:3002\/internal\/run-complete/);
  assert.match(entry, /secret-token/);
  assert.match(entry, /on\('agent_end'/);
  assert.match(entry, /on\('session_end'/);
  // The entry must be valid ESM.
  assert.match(entry, /export default function register\(api\)/);
});

test('plugin entry parses as valid JavaScript', async () => {
  const files = buildRunCompletionPluginFiles({ bridgePort: 3002 });
  const entry = files.find((f) => f.path === 'index.js').content;
  const dataUrl = `data:text/javascript;base64,${Buffer.from(entry).toString('base64')}`;
  const mod = await import(dataUrl);
  assert.equal(typeof mod.default, 'function');
  // register with a stub api — must not throw, must subscribe both hooks
  const hooks = [];
  mod.default({ on: (name) => hooks.push(name) });
  assert.deepEqual(hooks.sort(), ['agent_end', 'session_end']);
});
