import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENCLAW_VIDEO_EXECUTION_RULES,
  appendOpenClawVideoExecutionRules,
  buildVideoExecutionContinuation,
  evaluateVideoExecutionCompletion,
  inferVideoExecutionContract,
} from './openclaw-video-execution.mjs';

test('detects a TikTok creation brief as an execution contract', () => {
  const contract = inferVideoExecutionContract({
    task: 'Create production-level TikToks from this podcast. Plan first, then execute.',
    context: { executionLane: 'media' },
  });

  assert.deepEqual(contract, {
    enabled: true,
    requiresMutation: true,
    requiresRenderStart: true,
    requiresRenderStatus: true,
  });
});

test('does not turn an analysis-only video request into an execution run', () => {
  const contract = inferVideoExecutionContract({
    task: 'Just analyze this video and recommend the best moments.',
    systemPrompt: 'Use video_edit, video_cut_range, and video_render_start for execution requests.',
    context: { executionLane: 'media' },
  });
  assert.equal(contract.enabled, false);
});

test('analysis tools alone cannot satisfy a video execution contract', () => {
  const contract = inferVideoExecutionContract({
    task: 'Make a production-ready TikTok from this podcast.',
  });
  const result = evaluateVideoExecutionCompletion([
    { tool: 'video_project_get', success: true },
    { tool: 'video_transcript_get', success: true },
    { tool: 'video_highlights', success: true },
  ], contract);

  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ['timeline mutation', 'render start', 'render status check']);
});

test('mutation and render tools satisfy a production video execution contract', () => {
  const contract = inferVideoExecutionContract({ task: 'Create a post-ready TikTok video.' });
  const result = evaluateVideoExecutionCompletion([
    { tool: 'video_cut_range', success: true },
    { tool: 'video_captions_generate', success: true },
    { tool: 'video_render_start', success: true },
    { tool: 'video_render_status', success: true },
  ], contract);

  assert.equal(result.complete, true);
  assert.deepEqual(result.missing, []);
});

test('failed mutation calls do not satisfy completion', () => {
  const contract = inferVideoExecutionContract({ task: 'Edit and render this TikTok.' });
  const result = evaluateVideoExecutionCompletion([
    { tool: 'video_edit', success: false },
    { tool: 'video_render_start', success: true },
    { tool: 'video_render_status', success: true },
  ], contract);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ['timeline mutation']);
});

test('workspace completion rules are appended once', () => {
  const once = appendOpenClawVideoExecutionRules('# Team Lead');
  const twice = appendOpenClawVideoExecutionRules(once);
  assert.equal(once, twice);
  assert.match(once, /Never label an analysis-only run complete/i);
  assert.ok(OPENCLAW_VIDEO_EXECUTION_RULES.length > 500);
});

test('continuation prompt names missing work and prevents transcript page-zero thrash', () => {
  const prompt = buildVideoExecutionContinuation({
    attempt: 1,
    evaluation: {
      missing: ['timeline mutation', 'render start'],
      tools: ['video_project_get', 'video_transcript_get'],
    },
  });
  assert.match(prompt, /timeline mutation, render start/i);
  assert.match(prompt, /Do not request transcript page 0 again/i);
  assert.match(prompt, /video_project_get, video_transcript_get/i);
});
