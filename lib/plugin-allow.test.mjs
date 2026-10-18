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

test('a five-plugin allow list is removed so every installed plugin can load', () => {
  const config = {
    plugins: {
      allow: [...SHRUNK, 'customer-plugin'],
      deny: ['telegram', 'trooper-jev-bridge', 'leave-me'],
      entries: { brave: { enabled: true } },
    },
    tools: { allow: ['web_search'] },
  };
  const result = ensureOpenClawPluginAllowList(config);
  assert.equal(result.changed, true);
  assert.equal(config.plugins.allow, undefined);
  assert.equal(config.plugins.entries.brave.enabled, true);
  assert.equal(config.tools.allow, undefined);
  assert.deepEqual(config.plugins.deny, ['leave-me']);
});

test('an absent allow list stays absent', () => {
  const config = { plugins: { entries: { brave: { enabled: true } } } };
  const result = ensureOpenClawPluginAllowList(config);
  assert.equal(result.changed, false);
  assert.equal(config.plugins.allow, undefined);
});
