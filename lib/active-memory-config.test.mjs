import test from 'node:test';
import assert from 'node:assert/strict';
import { hardenActiveMemoryConfigForBridge } from './active-memory-config.mjs';

test('hardenActiveMemoryConfigForBridge bounds active memory to direct main-agent turns', () => {
  const { config, changed } = hardenActiveMemoryConfigForBridge({
    plugins: {
      entries: {
        'active-memory': {
          enabled: true,
          config: {
            agents: ['main', 'spc-ren'],
            allowedChatTypes: ['direct', 'channel'],
            modelFallbackPolicy: 'default-remote',
            queryMode: 'full',
            timeoutMs: 15000,
            maxSummaryChars: 900,
            persistTranscripts: true,
            thinking: 'high',
            logging: true,
          },
        },
      },
    },
  });

  assert.equal(changed, true);
  const cfg = config.plugins.entries['active-memory'].config;
  assert.deepEqual(cfg.agents, ['main']);
  assert.deepEqual(cfg.allowedChatTypes, ['direct']);
  assert.equal(cfg.modelFallbackPolicy, undefined);
  assert.equal(cfg.queryMode, 'message');
  assert.equal(cfg.timeoutMs, 5000);
  assert.equal(cfg.maxSummaryChars, 220);
  assert.equal(cfg.persistTranscripts, false);
  assert.equal(cfg.thinking, 'off');
  assert.equal(cfg.logging, false);
});

test('hardenActiveMemoryConfigForBridge leaves configs without active memory unchanged', () => {
  const original = { plugins: { entries: {} } };
  const { config, changed } = hardenActiveMemoryConfigForBridge(original);
  assert.equal(changed, false);
  assert.deepEqual(config, original);
});
