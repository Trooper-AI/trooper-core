import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureOpenClawPluginAllowList, OPENCLAW_PLUGIN_ALLOW_IDS } from './plugin-allow.mjs';

const SHRUNK = [
  'trooper-video-bridge',
  'trooper-image-generation-defaults',
  'trooper-run-completion',
  'trooper-acp-event-relay',
  'brave',
];

test('a five-plugin allow list is expanded back to every Trooper plugin', () => {
  const config = {
    plugins: {
      allow: [...SHRUNK, 'customer-plugin'],
      deny: ['telegram', 'trooper-jev-bridge', 'leave-me'],
    },
  };
  const result = ensureOpenClawPluginAllowList(config);
  assert.equal(result.changed, true);
  for (const id of OPENCLAW_PLUGIN_ALLOW_IDS) {
    assert.ok(config.plugins.allow.includes(id), id);
  }
  assert.ok(config.plugins.allow.includes('customer-plugin'));
  assert.deepEqual(config.plugins.allow.slice(0, 5), SHRUNK);
  assert.deepEqual(config.plugins.deny, ['leave-me']);
});

test('an absent allow list stays absent', () => {
  const config = { plugins: { entries: { brave: { enabled: true } } } };
  const result = ensureOpenClawPluginAllowList(config);
  assert.equal(result.changed, false);
  assert.equal(config.plugins.allow, undefined);
});
