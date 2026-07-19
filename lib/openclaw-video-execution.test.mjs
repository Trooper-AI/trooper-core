import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENCLAW_VIDEO_EXECUTION_RULES,
  appendOpenClawVideoExecutionRules,
  buildVideoExecutionContinuation,
  evaluateVideoExecutionCompletion,
  inferVideoExecutionContract,
  reconcileVideoToolLogWithHistory,
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
    requiresDesignStyle: true,
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
  assert.deepEqual(result.missing, ['timeline mutation', 'design style preset', 'render start', 'render status check']);
});

test('mutation and render tools satisfy a production video execution contract', () => {
  const contract = inferVideoExecutionContract({ task: 'Create a post-ready TikTok video.' });
  const result = evaluateVideoExecutionCompletion([
    { tool: 'video_cut_range', success: true },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'podcast-short' } },
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
    { tool: 'video_set_design_style', success: true, params: { styleId: 'podcast-short' } },
    { tool: 'video_render_start', success: true },
    { tool: 'video_render_status', success: true },
  ], contract);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ['timeline mutation']);
});

test('explicit captions, animated title, and zoom remain required through rendering', () => {
  const contract = inferVideoExecutionContract({
    task: 'Create a production-ready TikTok with captions, an animated title, and a social punch-in zoom/reframe.',
    context: { executionLane: 'media' },
  });
  assert.deepEqual(contract, {
    enabled: true,
    requiresMutation: true,
    requiresRenderStart: true,
    requiresRenderStatus: true,
    requiresDesignStyle: true,
    requiresCaptions: true,
    requiresAnimatedTitlePackaging: true,
    requiresZoomPackaging: true,
  });

  const incomplete = evaluateVideoExecutionCompletion([
    { tool: 'video_cut_range', success: true },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'podcast-short' } },
    { tool: 'video_captions_generate', success: true },
    { tool: 'video_render_start', success: true },
    { tool: 'video_render_status', success: true },
  ], contract);
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.missing, ['animated title packaging', 'zoom/reframe packaging']);

  const complete = evaluateVideoExecutionCompletion([
    { tool: 'video_cut_range', success: true },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'podcast-short' } },
    { tool: 'video_captions_generate', success: true },
    {
      tool: 'video_package_short',
      success: true,
      params: { title: 'A strong hook', zoomTemplateId: 'social-punch' },
    },
    { tool: 'video_render_start', success: true },
    { tool: 'video_render_status', success: true },
  ], contract);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.missing, []);
});

test('structured error payloads never satisfy a required video tool', () => {
  const contract = inferVideoExecutionContract({
    task: 'Create a TikTok with captions.',
    context: { executionLane: 'media' },
  });
  const result = evaluateVideoExecutionCompletion([
    { tool: 'video_cut_range', success: true },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'podcast-short' } },
    {
      tool: 'video_captions_generate',
      success: true,
      result: { error: 'version_conflict', status: 409 },
    },
    { tool: 'video_render_start', success: true },
    { tool: 'video_render_status', success: true },
  ], contract);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ['captions']);
});

test('post-compaction session history restores authoritative tool outcomes and params', () => {
  const reconciled = reconcileVideoToolLogWithHistory([
    { tool: 'video_project_get', toolCallId: 'read-1', success: true },
    { tool: 'video_render_status', toolCallId: 'render-status-1', success: false },
  ], [
    {
      event: 'tool_start',
      data: { tool: 'video_package_short', toolCallId: 'package-1', params: { title: 'Hook', zoomTemplateId: 'social-punch' } },
    },
    {
      event: 'tool_result',
      data: { tool: 'video_package_short', toolCallId: 'package-1', success: true, result: { projectId: 'project-1', version: 12 } },
    },
    {
      event: 'tool_start',
      data: { tool: 'video_render_status', toolCallId: 'render-status-1', params: { jobId: 'render-1' } },
    },
    {
      event: 'tool_result',
      data: { tool: 'video_render_status', toolCallId: 'render-status-1', success: true, result: { status: 'ready' } },
    },
  ]);

  const packaged = reconciled.find((entry) => entry.toolCallId === 'package-1');
  assert.equal(packaged.success, true);
  assert.deepEqual(packaged.params, { title: 'Hook', zoomTemplateId: 'social-punch' });
  const renderStatus = reconciled.find((entry) => entry.toolCallId === 'render-status-1');
  assert.equal(renderStatus.success, true);
  assert.deepEqual(renderStatus.result, { status: 'ready' });
});

test('unresolved tool calls do not count as successful completion evidence', () => {
  const contract = inferVideoExecutionContract({ task: 'Edit and render this TikTok.' });
  const result = evaluateVideoExecutionCompletion([
    { tool: 'video_cut_range' },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'podcast-short' } },
    { tool: 'video_render_start', success: true },
    { tool: 'video_render_status', success: true },
  ], contract);
  assert.equal(result.complete, false);
  assert.deepEqual(result.missing, ['timeline mutation']);
});

test('requested transition and effect presets require proven package parameters', () => {
  const contract = inferVideoExecutionContract({
    task: 'Create a production TikTok with a flash-cut transition and grain effect.',
    context: { executionLane: 'media' },
  });
  assert.equal(contract.requiresDesignStyle, true);
  assert.equal(contract.requiresTransitionPackaging, true);
  assert.equal(contract.requiresEffectPackaging, true);

  const incomplete = evaluateVideoExecutionCompletion([
    { tool: 'video_cut_range', success: true },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'kinetic-social' } },
    { tool: 'video_package_short', success: true, params: { title: 'Hook' } },
    { tool: 'video_render_start', success: true },
    { tool: 'video_render_status', success: true },
  ], contract);
  assert.deepEqual(incomplete.missing, ['transition packaging', 'effect packaging']);

  const complete = evaluateVideoExecutionCompletion([
    { tool: 'video_cut_range', success: true },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'kinetic-social' } },
    { tool: 'video_package_short', success: true, params: { transitionId: 'flash-cut', effectId: 'grain' } },
    { tool: 'video_render_start', success: true },
    { tool: 'video_render_status', success: true },
  ], contract);
  assert.equal(complete.complete, true);
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
