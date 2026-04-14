import test from 'node:test';
import assert from 'node:assert/strict';

import { buildExecutionLanePromptBlock } from './runtime-identity.mjs';

test('desktop browser mode adds visible-browser guidance for browser lane', () => {
  const prompt = buildExecutionLanePromptBlock({
    executionLane: 'browser',
    browserTask: true,
    browserMode: 'desktop',
  });

  assert.match(prompt, /live visible desktop browser/i);
  assert.match(prompt, /hostname navigation attempt is blocked/i);
});

test('headless browser lane keeps the default browser-first guidance', () => {
  const prompt = buildExecutionLanePromptBlock({
    executionLane: 'browser',
    browserTask: true,
    browserMode: 'headless',
  });

  assert.match(prompt, /Prefer browser and web-fetch tools before generic prose/i);
  assert.doesNotMatch(prompt, /live visible desktop browser/i);
});
