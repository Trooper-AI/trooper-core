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

const visualQaEvidence = () => [
  { tool: 'video_brand_guidelines', success: true, params: { action: 'get' }, result: { configured: false } },
  { tool: 'video_perception', success: true, params: { faces: true } },
  { tool: 'video_frames', success: true, params: { frames: [0, 90, 180] } },
  { tool: 'read', success: true, params: { path: 'Videos/project-1/thumbnails/frame_90_v12.jpg' } },
  { tool: 'video_lint', success: true },
];

const completedRenderEvidence = () => [
  { tool: 'video_render_start', success: true },
  {
    tool: 'video_render_status',
    success: true,
    result: { status: 'complete', outputPath: 'Videos/project-1/renders/draft.mp4' },
  },
];

/** FrameDeck-style defaults for TikTok/shorts: captions + hook title. */
const socialPackageEvidence = (title = 'Key Insight') => [
  { tool: 'video_captions_generate', success: true },
  { tool: 'video_package_short', success: true, params: { title } },
];

test('detects a production TikTok brief as a full production contract', () => {
  const contract = inferVideoExecutionContract({
    task: 'Create production-level TikToks from this podcast. Plan first, then execute.',
    context: { executionLane: 'media' },
  });

  assert.equal(contract.enabled, true);
  assert.equal(contract.tier, 'production');
  assert.equal(contract.maxContinuationAttempts, 2);
  assert.equal(contract.requiresMutation, true);
  assert.equal(contract.requiresRenderStart, true);
  assert.equal(contract.requiresRenderStatus, true);
  assert.equal(contract.requiresDesignStyle, true);
  assert.equal(contract.requiresBrandCheck, true);
  assert.equal(contract.requiresPerception, true);
  assert.equal(contract.requiresFrameCapture, true);
  assert.equal(contract.requiresFrameInspection, true);
  assert.equal(contract.requiresLint, true);
});

test('draft TikTok requests require mutation only (no forced render/QA)', () => {
  const contract = inferVideoExecutionContract({
    task: 'Make a quick draft TikTok cut from this podcast.',
    context: { executionLane: 'media' },
  });
  assert.equal(contract.enabled, true);
  assert.equal(contract.tier, 'draft');
  assert.equal(contract.maxContinuationAttempts, 1);
  assert.equal(contract.requiresMutation, true);
  assert.equal(contract.requiresRenderStart, false);
  assert.equal(contract.requiresRenderStatus, false);
  assert.equal(contract.requiresDesignStyle, undefined);
  assert.equal(contract.requiresBrandCheck, undefined);
  assert.equal(contract.requiresPerception, undefined);
});

test('standard platform create requires render but not full production QA', () => {
  const contract = inferVideoExecutionContract({
    task: 'Create a TikTok from this podcast clip.',
    context: { executionLane: 'media' },
  });
  assert.equal(contract.enabled, true);
  assert.equal(contract.tier, 'standard');
  assert.equal(contract.maxContinuationAttempts, 1);
  assert.equal(contract.requiresMutation, true);
  assert.equal(contract.requiresRenderStart, true);
  assert.equal(contract.requiresRenderStatus, true);
  // FrameDeck-style social defaults (not production QA)
  assert.equal(contract.requiresDesignStyle, true);
  assert.equal(contract.requiresCaptions, true);
  assert.equal(contract.requiresAnimatedTitlePackaging, true);
  assert.equal(contract.requiresLint, undefined);
  assert.equal(contract.requiresBrandCheck, undefined);
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
  assert.deepEqual(result.missing, [
    'timeline mutation',
    'brand guideline check',
    'design style preset',
    'face-aware perception',
    'captions',
    'animated title packaging',
    'post-edit representative frames',
    'visual frame inspection',
    'post-edit video lint',
    'render start',
    'render status check',
  ]);
});

test('mutation and render tools satisfy a production video execution contract', () => {
  const contract = inferVideoExecutionContract({ task: 'Create a post-ready TikTok video.' });
  const result = evaluateVideoExecutionCompletion([
    { tool: 'video_cut_range', success: true },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'podcast-short' } },
    { tool: 'video_captions_generate', success: true },
    {
      tool: 'video_package_short',
      success: true,
      params: { title: 'Key Insight' },
    },
    ...visualQaEvidence(),
    ...completedRenderEvidence(),
  ], contract);

  assert.equal(result.complete, true);
  assert.deepEqual(result.missing, []);
});

test('failed mutation calls do not satisfy completion', () => {
  const contract = inferVideoExecutionContract({ task: 'Edit and render this TikTok.' });
  const result = evaluateVideoExecutionCompletion([
    { tool: 'video_edit', success: false },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'podcast-short' } },
    { tool: 'video_captions_generate', success: true },
    // package_short counts as mutation — omit it so only the failed video_edit remains
    ...visualQaEvidence(),
    ...completedRenderEvidence(),
  ], contract);
  assert.equal(result.complete, false);
  assert.ok(result.missing.includes('timeline mutation'));
  assert.ok(result.missing.includes('animated title packaging'));
});

test('standard TikTok defaults to FrameDeck-style cuts + captions + title', () => {
  const contract = inferVideoExecutionContract({
    task: 'Make 3 TikTok clips from this podcast.',
    context: { executionLane: 'media' },
  });
  assert.equal(contract.enabled, true);
  assert.equal(contract.tier, 'standard');
  assert.equal(contract.requiresMutation, true);
  assert.equal(contract.requiresCaptions, true);
  assert.equal(contract.requiresDesignStyle, true);
  assert.equal(contract.requiresAnimatedTitlePackaging, true);
  assert.equal(contract.requiresRenderStart, true);
  // Not production → no forced brand/perception/lint
  assert.notEqual(contract.requiresLint, true);
  assert.notEqual(contract.requiresBrandCheck, true);

  const incomplete = evaluateVideoExecutionCompletion([
    { tool: 'video_make_shorts', success: true },
    ...completedRenderEvidence(),
  ], contract);
  assert.equal(incomplete.complete, false);
  assert.ok(incomplete.missing.includes('captions'));
  assert.ok(incomplete.missing.includes('design style preset'));
  assert.ok(incomplete.missing.includes('animated title packaging'));

  const complete = evaluateVideoExecutionCompletion([
    { tool: 'video_make_shorts', success: true },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'podcast-short' } },
    { tool: 'video_captions_generate', success: true },
    { tool: 'video_package_short', success: true, params: { title: 'Must Hear' } },
    ...completedRenderEvidence(),
  ], contract);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.missing, []);
});

test('explicit captions, animated title, and zoom remain required through rendering', () => {
  const contract = inferVideoExecutionContract({
    task: 'Create a production-ready TikTok with captions, an animated title, and a social punch-in zoom/reframe.',
    context: { executionLane: 'media' },
  });
  assert.equal(contract.enabled, true);
  assert.equal(contract.tier, 'production');
  assert.equal(contract.requiresMutation, true);
  assert.equal(contract.requiresRenderStart, true);
  assert.equal(contract.requiresRenderStatus, true);
  assert.equal(contract.requiresDesignStyle, true);
  assert.equal(contract.requiresBrandCheck, true);
  assert.equal(contract.requiresPerception, true);
  assert.equal(contract.requiresFrameCapture, true);
  assert.equal(contract.requiresFrameInspection, true);
  assert.equal(contract.requiresLint, true);
  assert.equal(contract.requiresCaptions, true);
  assert.equal(contract.requiresAnimatedTitlePackaging, true);
  assert.equal(contract.requiresZoomPackaging, true);

  const incomplete = evaluateVideoExecutionCompletion([
    { tool: 'video_cut_range', success: true },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'podcast-short' } },
    { tool: 'video_captions_generate', success: true },
    ...visualQaEvidence(),
    ...completedRenderEvidence(),
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
    ...visualQaEvidence(),
    ...completedRenderEvidence(),
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
    { tool: 'video_package_short', success: true, params: { title: 'Hook' } },
    ...visualQaEvidence(),
    ...completedRenderEvidence(),
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

test('a result-only history record cannot erase live package parameters', () => {
  const reconciled = reconcileVideoToolLogWithHistory([
    {
      tool: 'video_package_short',
      toolCallId: 'package-live-1',
      params: { title: 'Proof', zoomTemplateId: 'social-punch', transitionId: 'fade', effectId: 'grain' },
      success: true,
      result: { projectId: 'project-1', version: 39 },
    },
  ], [
    {
      event: 'tool_result',
      data: {
        tool: 'video_package_short',
        toolCallId: 'package-live-1',
        success: true,
        result: { projectId: 'project-1', version: 39 },
      },
    },
  ]);

  assert.deepEqual(reconciled[0].params, {
    title: 'Proof',
    zoomTemplateId: 'social-punch',
    transitionId: 'fade',
    effectId: 'grain',
  });
});

test('package result metadata remains valid completion evidence after compaction', () => {
  const contract = inferVideoExecutionContract({
    task: 'Create a production TikTok with an animated title, zoom, transition, and grain effect.',
  });
  const result = evaluateVideoExecutionCompletion([
    { tool: 'video_cut_range', success: true },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'podcast-short' } },
    { tool: 'video_captions_generate', success: true },
    {
      tool: 'video_package_short',
      success: true,
      result: {
        packaging: { title: 'Proof', zoomTemplateId: 'social-punch', transitionId: 'fade', effectId: 'grain' },
      },
    },
    ...visualQaEvidence(),
    ...completedRenderEvidence(),
  ], contract);
  assert.equal(result.complete, true);
});

test('unresolved tool calls do not count as successful completion evidence', () => {
  const contract = inferVideoExecutionContract({ task: 'Edit and render this TikTok.' });
  const result = evaluateVideoExecutionCompletion([
    { tool: 'video_cut_range' }, // no success flag → not a completed mutation
    { tool: 'video_set_design_style', success: true, params: { styleId: 'podcast-short' } },
    { tool: 'video_captions_generate', success: true },
    // omit package_short (it is also a mutation tool)
    ...visualQaEvidence(),
    ...completedRenderEvidence(),
  ], contract);
  assert.equal(result.complete, false);
  assert.ok(result.missing.includes('timeline mutation'));
  assert.ok(result.missing.includes('animated title packaging'));
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
    { tool: 'video_captions_generate', success: true },
    { tool: 'video_package_short', success: true, params: { title: 'Hook' } },
    ...visualQaEvidence(),
    ...completedRenderEvidence(),
  ], contract);
  assert.deepEqual(incomplete.missing, ['transition packaging', 'effect packaging']);

  const complete = evaluateVideoExecutionCompletion([
    { tool: 'video_cut_range', success: true },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'kinetic-social' } },
    { tool: 'video_captions_generate', success: true },
    {
      tool: 'video_package_short',
      success: true,
      params: { title: 'Hook', transitionId: 'flash-cut', effectId: 'grain' },
    },
    ...visualQaEvidence(),
    ...completedRenderEvidence(),
  ], contract);
  assert.equal(complete.complete, true);
});

test('failed HyperFrames motion does not block export when main render completes', () => {
  const contract = inferVideoExecutionContract({
    task: 'Create a production TikTok with motion graphics and post-ready export.',
    context: { executionLane: 'media' },
  });
  const result = evaluateVideoExecutionCompletion([
    { tool: 'video_remotion_capabilities', success: true },
    { tool: 'video_cut_range', success: true },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'kinetic-social' } },
    { tool: 'video_captions_generate', success: true },
    { tool: 'video_package_short', success: true, params: { title: 'Hook' } },
    { tool: 'video_motion_scene_create', success: true },
    { tool: 'video_motion_scene_render', success: true },
    {
      tool: 'video_motion_scene_status',
      success: true,
      result: {
        scene: { renderStatus: 'failed' },
        jobs: [{ status: 'failed', error: 'HyperFrames worker did not produce a non-empty WEBM' }],
      },
    },
    { tool: 'video_brand_guidelines', success: true, params: { action: 'get' } },
    { tool: 'video_perception', success: true, params: { faces: true } },
    { tool: 'video_frames', success: true, params: { frames: [0, 90, 180] } },
    { tool: 'read', success: true, params: { path: 'Videos/project-1/thumbnails/frame_90_v12.jpg' } },
    { tool: 'video_lint', success: true },
    { tool: 'video_render_start', success: true },
    {
      tool: 'video_render_status',
      success: true,
      result: { status: 'complete', outputPath: 'Videos/project-1/renders/draft.mp4' },
    },
  ], contract);
  assert.equal(result.motionDegraded, true);
  assert.equal(result.complete, true);
  assert.ok(!result.missing.includes('completed motion scene output'));
});

test('motion graphics requests require capability selection and a completed scene output', () => {
  const contract = inferVideoExecutionContract({
    task: 'Create a production explainer video with motion graphics, layered callouts, and a text highlight.',
    context: { executionLane: 'media' },
  });
  assert.equal(contract.requiresRemotionCapabilities, true);
  assert.equal(contract.requiresMotionSceneCreate, true);
  assert.equal(contract.requiresMotionSceneRender, true);
  assert.equal(contract.requiresMotionSceneStatus, true);

  const base = [
    { tool: 'video_brand_guidelines', success: true, params: { action: 'get' } },
    { tool: 'video_perception', success: true, params: { faces: true } },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'faceless-explainer' } },
  ];
  const incomplete = evaluateVideoExecutionCompletion([
    ...base,
    { tool: 'video_remotion_capabilities', success: true },
    { tool: 'video_motion_scene_create', success: true, result: { sceneId: 'scene-1' } },
    { tool: 'video_motion_scene_render', success: true, result: { jobId: 'motion-1' } },
    { tool: 'video_motion_scene_status', success: true, result: { status: 'running' } },
    ...visualQaEvidence().slice(2),
    ...completedRenderEvidence(),
  ], contract);
  assert.deepEqual(incomplete.missing, ['completed motion scene output']);

  const complete = evaluateVideoExecutionCompletion([
    ...base,
    { tool: 'video_remotion_capabilities', success: true },
    { tool: 'video_motion_scene_create', success: true, result: { sceneId: 'scene-1' } },
    { tool: 'video_motion_scene_render', success: true, result: { jobId: 'motion-1' } },
    { tool: 'video_motion_scene_status', success: true, result: { status: 'complete', outputPath: 'Videos/project-1/motion/scene-1.webm' } },
    ...visualQaEvidence().slice(2),
    ...completedRenderEvidence(),
  ], contract);
  assert.equal(complete.complete, true);
  assert.deepEqual(complete.missing, []);
});

test('a running render is not a completed deliverable', () => {
  const contract = inferVideoExecutionContract({ task: 'Create a production TikTok.' });
  const result = evaluateVideoExecutionCompletion([
    { tool: 'video_brand_guidelines', success: true, params: { action: 'get' } },
    { tool: 'video_perception', success: true, params: { faces: true } },
    { tool: 'video_cut_range', success: true },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'podcast-short' } },
    ...socialPackageEvidence(),
    ...visualQaEvidence().slice(1),
    { tool: 'video_render_start', success: true },
    { tool: 'video_render_status', success: true, result: { status: 'running', progress: 0.8 } },
  ], contract);

  assert.equal(result.renderStatus, true);
  assert.equal(result.renderComplete, false);
  assert.deepEqual(result.missing, ['completed render output']);
});

test('frame capture and lint must happen after the final timeline mutation', () => {
  const contract = inferVideoExecutionContract({ task: 'Create a production TikTok.' });
  const result = evaluateVideoExecutionCompletion([
    { tool: 'video_brand_guidelines', success: true, params: { action: 'get' } },
    { tool: 'video_perception', success: true, params: { faces: true } },
    ...visualQaEvidence().slice(1),
    { tool: 'video_cut_range', success: true },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'podcast-short' } },
    ...socialPackageEvidence(),
    ...completedRenderEvidence(),
  ], contract);

  assert.deepEqual(result.missing, [
    'post-edit representative frames',
    'visual frame inspection',
    'post-edit video lint',
  ]);
});

test('a lint call with blocking visual errors cannot satisfy production QA', () => {
  const contract = inferVideoExecutionContract({ task: 'Create a production TikTok.' });
  const evidence = visualQaEvidence();
  evidence[evidence.length - 1] = {
    tool: 'video_lint',
    success: true,
    result: { ok: false, errors: 2, issues: [{ code: 'text_layer_collision' }, { code: 'caption_too_dense' }] },
  };
  const result = evaluateVideoExecutionCompletion([
    { tool: 'video_cut_range', success: true },
    { tool: 'video_set_design_style', success: true, params: { styleId: 'podcast-short' } },
    ...socialPackageEvidence(),
    ...evidence,
    ...completedRenderEvidence(),
  ], contract);
  assert.deepEqual(result.missing, ['post-edit video lint']);
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

test('responseRequestsUserDecision detects plan-approval questions and ignores completion reports', async () => {
  const { responseRequestsUserDecision } = await import('./openclaw-video-execution.mjs');
  // Genuine decision requests → true
  assert.equal(responseRequestsUserDecision(
    'Here is my plan for the three clips…\n\nThis is what I\'m proposing. Want me to go ahead and create all three, or adjust the selection/count?',
  ), true);
  assert.equal(responseRequestsUserDecision('Which option do you prefer — A or B?'), true);
  assert.equal(responseRequestsUserDecision('Generating music costs ~$0.40. Should I proceed with the paid generation?'), true);
  assert.equal(responseRequestsUserDecision('I can cut it at 45s or 60s. Let me know which one you want?'), true);
  // Completion / status reports → false
  assert.equal(responseRequestsUserDecision('All three TikToks are rendered. Output: Videos/p1/renders/final.mp4'), false);
  assert.equal(responseRequestsUserDecision(''), false);
  assert.equal(responseRequestsUserDecision('The transcript (did you know? it has 2743 words) was analyzed.\n\nRender complete at Videos/out.mp4.'), false);
});
