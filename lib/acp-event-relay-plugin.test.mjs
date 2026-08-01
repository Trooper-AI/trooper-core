import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACP_EVENT_RELAY_PLUGIN_ID,
  ACP_EVENT_RELAY_BATCH_MS,
  ACP_EVENT_RELAY_CONTENT_CAP,
  ACP_EVENT_RELAY_HOOKS,
  buildAcpEventRelayPluginFiles,
} from './acp-event-relay-plugin.mjs';

function entrySource(files) {
  return files.find((file) => file.path === 'index.js').content;
}

test('plugin files carry manifest, package, and entry with the plugin id', () => {
  const files = buildAcpEventRelayPluginFiles({ bridgePort: 3002, token: 'tok' });
  assert.deepEqual(files.map((file) => file.path).sort(), ['index.js', 'openclaw.plugin.json', 'package.json']);
  const manifest = JSON.parse(files.find((file) => file.path === 'openclaw.plugin.json').content);
  assert.equal(manifest.id, ACP_EVENT_RELAY_PLUGIN_ID);
  const packageJson = JSON.parse(files.find((file) => file.path === 'package.json').content);
  assert.deepEqual(packageJson.openclaw, { extensions: ['./index.js'] });
});

test('entry targets /internal/acp-event with docker-host fallback and the bridge token', () => {
  const entry = entrySource(buildAcpEventRelayPluginFiles({ bridgePort: 3103, token: 'secret-token' }));
  assert.match(entry, /http:\/\/host\.docker\.internal:3103\/internal\/acp-event/);
  assert.match(entry, /http:\/\/172\.17\.0\.1:3103\/internal\/acp-event/);
  assert.match(entry, /"secret-token"/);
  assert.match(entry, /x-trooper-bridge-token/);
});

test('every hook registers inside its own try/catch — unknown hooks never break the plugin', () => {
  const entry = entrySource(buildAcpEventRelayPluginFiles());
  for (const hook of ACP_EVENT_RELAY_HOOKS) {
    assert.ok(entry.includes(JSON.stringify(hook).replace(/"/g, '"')) || entry.includes(hook), `entry mentions ${hook}`);
  }
  assert.match(entry, /unknown hook on this gateway build/);
  assert.match(entry, /never let telemetry failures affect the run/);
});

test('entry batches with the micro-batch interval and caps content size', () => {
  const entry = entrySource(buildAcpEventRelayPluginFiles());
  assert.match(entry, new RegExp(`BATCH_MS = ${ACP_EVENT_RELAY_BATCH_MS}`));
  assert.match(entry, new RegExp(`CONTENT_CAP = ${ACP_EVENT_RELAY_CONTENT_CAP}`));
  assert.match(entry, /MAX_QUEUE = 200/);
  assert.match(entry, /setTimeout\(flush, BATCH_MS\)/);
});

test('entry is dependency-free ESM with a default register export', () => {
  const entry = entrySource(buildAcpEventRelayPluginFiles());
  assert.doesNotMatch(entry, /\brequire\(/);
  assert.doesNotMatch(entry, /^import /m);
  assert.match(entry, /export default function register\(api\)/);
});
