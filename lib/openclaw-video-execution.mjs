const VIDEO_MUTATION_TOOLS = new Set([
  'video_edit',
  'video_timeline_apply',
  'video_cut_range',
  'video_make_shorts',
  'video_package_short',
  'video_transcript_cut',
  'video_transcript_clean',
  'video_transcript_keep',
  'video_director_run',
  'video_motion_scene_create',
  'video_motion_scene_update',
]);

const VIDEO_RENDER_START_TOOLS = new Set([
  'video_render_start',
  'video_motion_scene_render',
]);

const VIDEO_RENDER_STATUS_TOOLS = new Set([
  'video_render_status',
  'video_motion_scene_status',
  'video_director_status',
]);

const VIDEO_CAPTION_TOOLS = new Set(['video_captions_generate']);
const VIDEO_PACKAGE_TOOLS = new Set(['video_package_short']);
const VIDEO_DESIGN_STYLE_TOOLS = new Set(['video_set_design_style']);
const VIDEO_BRAND_TOOLS = new Set(['video_brand_guidelines']);
const VIDEO_PERCEPTION_TOOLS = new Set(['video_perception']);
const VIDEO_FRAME_TOOLS = new Set(['video_frames']);
const VIDEO_LINT_TOOLS = new Set(['video_lint']);
const VIDEO_REMOTION_CAPABILITY_TOOLS = new Set(['video_remotion_capabilities']);
const VIDEO_MOTION_CREATE_TOOLS = new Set(['video_motion_scene_create', 'video_motion_scene_update']);
const VIDEO_MOTION_RENDER_TOOLS = new Set(['video_motion_scene_render']);
const VIDEO_MOTION_STATUS_TOOLS = new Set(['video_motion_scene_status']);
const FRAME_INSPECTION_TOOLS = new Set(['read', 'read_file', 'image', 'describe_image']);

const VIDEO_EXECUTION_RULES_START = '<!-- OPENCLAW_VIDEO_EXECUTION_CONTRACT_START -->';
const VIDEO_EXECUTION_RULES_END = '<!-- OPENCLAW_VIDEO_EXECUTION_CONTRACT_END -->';

export const OPENCLAW_VIDEO_EXECUTION_RULES = `${VIDEO_EXECUTION_RULES_START}
## Video execution completion contract

When the human asks to create, edit, package, or render a video, planning and analysis are intermediate work—not completion.

**Product model (FrameDeck-style):** OpenClaw does not write Remotion React source. It mutates the Trooper video project (cuts, captions, titles, packaging) so the **same project opens in the Trooper video editor** for preview/tweak/export. Remotion only previews and renders that project JSON.

### Default social pipeline (TikTok / Reel / Short / podcast clip)

Unless the human said **draft / rough / quick / preview**, always finish this sequence on the live project:

1. **Cuts** — \`video_cut_range\` / \`video_make_shorts\` / transcript keep-cut (real timeline mutation).
2. **Design** — \`video_set_design_style\` (\`podcast-short\`, \`kinetic-social\`, or \`subtitle-first-vertical\`).
3. **Subtitles** — \`video_captions_generate\` (word-timed, short cues). Required for platform shorts even if the human did not say “captions”.
4. **Title package** — \`video_package_short\` with a short hook \`title\` (upper-third / separate from captions). Default for platform shorts.
5. **Export** — \`video_render_start\` → poll \`video_render_status\` until completed \`outputPath\`.
6. **Deliver** — report \`projectUrl\` / project id so the human can open the editor, plus the MP4 path when render completed.

Skip HyperFrames / Seedance / director unless the human explicitly asked for kinetic motion graphics or AI gen. Fancy MG is optional; **cuts + captions + title** are the product.

Match effort to the requested quality bar (performance-sensitive):

- **Draft / rough / quick / preview** — successfully mutate the timeline (cuts). Captions/title/render optional unless asked.
- **Standard platform deliverable** (TikTok / Reel / Short / podcast clip / “render this”) — full default social pipeline above. Skip brand/perception/frames/lint unless production language.
- **Production / post-ready / publish / final** — social pipeline + full quality bar below.

Always:

- Do not finalize after only project, media, transcript, perception, highlight, workflow, or skill reads.
- Before the final answer on any execution request, successfully call a real timeline mutation tool such as \`video_edit\`, \`video_timeline_apply\`, \`video_cut_range\`, \`video_make_shorts\`, or \`video_transcript_keep/cut\`.
- When captions are required (platform shorts or the human asked), successfully call \`video_captions_generate\`. Do not fake captions with generic overlay text clips.
- When title packaging is required (platform shorts or the human asked for animated title / zoom / transition / effect), call \`video_package_short\` with the requested \`title\`, \`zoomTemplateId\`, \`transitionId\`, and/or \`effectId\`; do not approximate these fields with generic timeline operations. Place titles **upper-third** when captions occupy lower-third.
- When the request explicitly asks for motion graphics, an explainer, layers, animated highlights/callouts, shaders/WebGL, or HTML-in-canvas work, first call \`video_remotion_capabilities\`, then create a relevant \`video_motion_scene_create\`, call \`video_motion_scene_render\`, and poll \`video_motion_scene_status\` until a completed output is registered on the timeline. Reading a motion skill or creating source alone is not completion.
- **HyperFrames failure path (critical):** if motion create/render returns worker unavailable, empty WEBM, or failed status twice, **remove unbaked motion scenes**, keep titles/captions/package, and **finish with video_render_start → complete outputPath**. Do not loop forever on motion. Editor-ready project + MP4 without MG beats no deliverable.
- **Zoom / fade packaging:** if render fails with non-monotonic \`inputRange\` / keyframe errors, strip zoom templates and one-sided fades (or re-package without crossfade), then re-render. Prefer a successful draft export over social-punch zooms.
- Remotion primitives are a capability library, not a mandate to stack every effect.
- Never leave the human with analysis-only chat. The editor must show the cuts (and captions/titles when required) after the run.

Production-only (when the human asked for production / post-ready / publish / final quality):

- Successfully call \`video_set_design_style\` with canonical \`styleId\` (never legacy \`style\` or \`lookId\`) before captions and packaging.
- Call \`video_perception\` with \`faces:true\` so cuts and reframes use scene, energy, silence, and face evidence.
- Call \`video_brand_guidelines\` with \`action:"get"\`. Apply the saved profile when configured; if none exists, use the chosen style pack and never invent a font, logo, or color.
- After the last production mutation, call \`video_frames\` at representative beginning/middle/end frames, inspect at least one returned still with \`read\`/\`image\`, and run \`video_lint\`. Fix placement, safe-area, font, caption, or overlap problems before rendering.
- Call \`video_render_start\` and poll \`video_render_status\` (or director/motion equivalents) until a terminal completed status and output path exist.

General:

- A truncated transcript page is enough to proceed. Never request transcript page 0 twice. Use \`nextStartIndex\` for another page, or use highlights/perception and make the best editorial choice.
- Keep progress narration short. Tool calls and the resulting project/render are the work product.
- If required tools fail, report the exact failed tool and error. Never label an analysis-only run complete.
${VIDEO_EXECUTION_RULES_END}`;

function safeJsonParse(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isFailurePayload(value) {
  const payload = typeof value === 'string' ? safeJsonParse(value) : value;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.error || payload.isError === true || payload.is_error === true) return true;
  const numericStatus = Number(payload.status);
  if (Number.isFinite(numericStatus) && numericStatus >= 400) return true;
  if (payload.success === false || payload.ok === false) return true;
  return ['failed', 'error'].includes(String(payload.status || '').trim().toLowerCase());
}

function successfulToolEntries(toolLog = []) {
  return (Array.isArray(toolLog) ? toolLog : []).filter((entry) => (
    entry
    && entry.success === true
    && !isFailurePayload(entry.result)
    && !isFailurePayload(entry.summary)
  ));
}

function normalizedToolNames(toolLog = []) {
  return successfulToolEntries(toolLog)
    .map((entry) => String(entry.tool || '').trim().toLowerCase())
    .filter(Boolean);
}

function nonEmptyObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

export function reconcileVideoToolLogWithHistory(toolLog = [], historyEvents = []) {
  const startsByCallId = new Map();
  const startsByTool = new Map();
  const historyResults = [];

  for (const event of Array.isArray(historyEvents) ? historyEvents : []) {
    const data = event?.data || {};
    const tool = String(data.tool || data.toolName || '').trim();
    if (!tool) continue;
    const toolCallId = data.toolCallId || null;
    if (event?.event === 'tool_start') {
      const start = { tool, toolCallId, params: data.params || {}, used: false };
      if (toolCallId) startsByCallId.set(toolCallId, start);
      if (!startsByTool.has(tool.toLowerCase())) startsByTool.set(tool.toLowerCase(), []);
      startsByTool.get(tool.toLowerCase()).push(start);
      continue;
    }
    if (event?.event !== 'tool_result') continue;

    let start = toolCallId ? startsByCallId.get(toolCallId) : null;
    if (!start) {
      start = (startsByTool.get(tool.toLowerCase()) || []).find((candidate) => !candidate.used) || null;
    }
    if (start) start.used = true;
    const result = data.result ?? null;
    const summary = data.summary || data.raw || '';
    historyResults.push({
      tool,
      ...(toolCallId || start?.toolCallId ? { toolCallId: toolCallId || start.toolCallId } : {}),
      params: nonEmptyObject(data.params) ? data.params : (start?.params || {}),
      result,
      summary,
      success: data.success === true && !isFailurePayload(result) && !isFailurePayload(summary),
      source: data.source || event?.source || 'session_history',
    });
  }

  const merged = [];
  const seen = new Set();
  for (const entry of [...(Array.isArray(toolLog) ? toolLog : []), ...historyResults]) {
    if (!entry?.tool) continue;
    const normalized = {
      ...entry,
      success: entry.success === true && !isFailurePayload(entry.result) && !isFailurePayload(entry.summary),
    };
    const signature = normalized.toolCallId
      ? `id:${normalized.toolCallId}`
      : `value:${String(normalized.tool).toLowerCase()}:${JSON.stringify(normalized.params || {})}:${String(normalized.summary || '').slice(0, 160)}`;
    if (seen.has(signature)) {
      const index = merged.findIndex((candidate) => (
        normalized.toolCallId
          ? candidate.toolCallId === normalized.toolCallId
          : `value:${String(candidate.tool).toLowerCase()}:${JSON.stringify(candidate.params || {})}:${String(candidate.summary || '').slice(0, 160)}` === signature
      ));
      if (index >= 0 && normalized.success === true) {
        const previous = merged[index];
        merged[index] = {
          ...previous,
          ...normalized,
          // A late history result can retain the call id after its tool_start
          // has been compacted. Keep authoritative live-call parameters.
          params: nonEmptyObject(normalized.params) ? normalized.params : (previous.params || {}),
          result: normalized.result ?? previous.result,
          summary: normalized.summary || previous.summary || '',
        };
      }
      continue;
    }
    seen.add(signature);
    merged.push(normalized);
  }
  return merged;
}

function hasAny(set, values) {
  return values.some((value) => set.has(value));
}

export function appendOpenClawVideoExecutionRules(markdown = '') {
  const original = String(markdown || '');
  if (original.includes(VIDEO_EXECUTION_RULES_START)) return original;
  const current = original.trimEnd();
  return `${current}${current ? '\n\n' : ''}${OPENCLAW_VIDEO_EXECUTION_RULES}\n`;
}

/**
 * Performance tiers for video completion enforcement (OC-01).
 *
 * - draft: timeline mutation only — no forced render/QA/continuations beyond 1
 * - standard: FrameDeck-style social pipeline (cuts + captions + title) + completed render
 * - production: full brand/perception/frames/lint + social pipeline + completed render
 *
 * Platform shorts default to captions + title packaging even when the user did not
 * type those words — that is what makes the Trooper editor look “done”.
 *
 * Explicit packaging requests (zoom, motion graphics, …) still attach on any tier
 * when the user asked for them.
 */
export function inferVideoExecutionContract({ task = '', systemPrompt = '', context = {} } = {}) {
  const taskText = String(task || '').toLowerCase();
  const combined = `${taskText}\n${systemPrompt}\n${JSON.stringify(context || {})}`.toLowerCase();
  const videoSignal = context?.executionLane === 'media'
    // Saved workflows with video steps set this deterministic flag (Trooper
    // buildSavedWorkflowRunDispatch) instead of relying on prompt wording.
    || context?.videoExecution === true
    || /\bvideo_(?:project|edit|timeline|cut|make_shorts|render|transcript|highlights|perception)\b/.test(combined)
    || /\b(?:tiktoks?|reels?|youtube shorts?|video edit|podcast clips?|long[- ]to[- ]shorts?)\b/.test(combined);
  const executionSignal = /\b(?:create|make|edit|cut|package|produce|render|generate|turn|convert|deliver|post)\b/.test(taskText);
  const analysisSignal = /\b(?:analy[sz]e|inspect|transcri(?:be|pt)|summarize|plan|recommend|explain|review)\b/.test(taskText);
  const explicitlyPlanOnly = analysisSignal
    && !executionSignal
    && /\b(?:only|just)\b/.test(taskText);

  const enabled = videoSignal && executionSignal && !explicitlyPlanOnly;

  // Explicit quality bar — not inferred from platform names alone.
  const productionSignal = /\b(?:production(?:-level|-ready)?|post[- ]ready|publish(?:able)?|final(?:ized)?|broadcast[- ]ready)\b/.test(taskText);
  // Draft/preview language wins over platform defaults unless production is also stated.
  const draftSignal = !productionSignal && /\b(?:draft|rough cut|quick edit|quick cut|wip|preview(?: cut)?|scratch)\b/.test(taskText);
  const platformDeliverable = /\b(?:tiktoks?|reels?|youtube shorts?|shorts?|podcast clips?|long[- ]to[- ]shorts?|highlight clips?)\b/.test(taskText);
  const renderSignal = /\b(?:render|export)\b/.test(taskText);
  // Social / talking-head edits that should land fully in the Trooper editor.
  const socialEditorPipeline = platformDeliverable
    || /\b(?:podcast|interview|talking[- ]head|clip(?:s)? for (?:tiktok|reels?|shorts?))\b/.test(taskText);

  let tier = 'none';
  if (enabled) {
    if (productionSignal) tier = 'production';
    else if (draftSignal) tier = 'draft';
    else if (platformDeliverable || renderSignal) tier = 'standard';
    else tier = 'standard'; // create/edit/package without draft/production language
  }

  const requiresRender = enabled && tier !== 'draft';
  const contract = {
    enabled,
    tier,
    // Continuations are expensive full agent re-entries — keep them tight.
    maxContinuationAttempts: tier === 'production' ? 2 : (tier === 'draft' ? 1 : 1),
    requiresMutation: enabled,
    requiresRenderStart: requiresRender,
    requiresRenderStatus: requiresRender,
  };

  // Full visual QA only for production-tier runs.
  if (enabled && tier === 'production') {
    contract.requiresDesignStyle = true;
    contract.requiresBrandCheck = true;
    contract.requiresPerception = true;
    contract.requiresFrameCapture = true;
    contract.requiresFrameInspection = true;
    contract.requiresLint = true;
  }

  // FrameDeck-style defaults: platform/social work always gets style + captions + hook title
  // so the Trooper editor opens with a real short, not bare cuts.
  if (enabled && tier !== 'draft' && socialEditorPipeline) {
    contract.requiresDesignStyle = true;
    contract.requiresCaptions = true;
    contract.requiresAnimatedTitlePackaging = true;
  }

  if (enabled && /\b(?:captions?|subtitles?|closed captions?|cc)\b/.test(taskText)) {
    contract.requiresCaptions = true;
  }
  if (enabled && /\b(?:animated|motion)\s+(?:title|headline|text)|(?:title|headline)\s+animation\b/.test(taskText)) {
    contract.requiresAnimatedTitlePackaging = true;
  }
  if (enabled && /\b(?:zoom|push[- ]?in|punch[- ]?in|ken burns|reframe)\b/.test(taskText)) {
    contract.requiresZoomPackaging = true;
  }
  if (enabled && /\b(?:transition|crossfade|dissolve|wipe|flash[- ]?cut|slide)\b/.test(taskText)) {
    contract.requiresTransitionPackaging = true;
  }
  if (enabled && /\b(?:effects?|filter|vignette|grain|glow|greenscreen|green screen|sepia|neon)\b/.test(taskText)) {
    contract.requiresEffectPackaging = true;
  }
  if (enabled && /\b(?:motion graphics?|animated explainer|explainer video|html(?:-in-|\s+in\s+)canvas|shaders?|webgl|light leaks?|starburst|text highlights?|animated callouts?|layered graphics?|add layers?)\b/.test(taskText)) {
    contract.requiresRemotionCapabilities = true;
    contract.requiresMotionSceneCreate = true;
    contract.requiresMotionSceneRender = true;
    contract.requiresMotionSceneStatus = true;
  }
  return contract;
}

export function evaluateVideoExecutionCompletion(toolLog = [], contract = {}) {
  const tools = normalizedToolNames(toolLog);
  const mutation = hasAny(VIDEO_MUTATION_TOOLS, tools);
  const renderStart = hasAny(VIDEO_RENDER_START_TOOLS, tools);
  const renderStatus = hasAny(VIDEO_RENDER_STATUS_TOOLS, tools);
  const captions = hasAny(VIDEO_CAPTION_TOOLS, tools);
  const designStyle = hasAny(VIDEO_DESIGN_STYLE_TOOLS, tools);
  const remotionCapabilities = hasAny(VIDEO_REMOTION_CAPABILITY_TOOLS, tools);
  const motionSceneCreate = hasAny(VIDEO_MOTION_CREATE_TOOLS, tools);
  const motionSceneRender = hasAny(VIDEO_MOTION_RENDER_TOOLS, tools);
  const motionSceneStatus = hasAny(VIDEO_MOTION_STATUS_TOOLS, tools);
  const successfulEntries = successfulToolEntries(toolLog);
  const brandCheck = successfulEntries.some((entry) => (
    VIDEO_BRAND_TOOLS.has(String(entry.tool || '').trim().toLowerCase())
    && String(entry.params?.action || 'get').trim().toLowerCase() === 'get'
  ));
  const lastMutationIndex = successfulEntries.reduce((latest, entry, index) => (
    VIDEO_MUTATION_TOOLS.has(String(entry.tool || '').trim().toLowerCase()) ? index : latest
  ), -1);
  const perception = successfulEntries.some((entry) => (
    VIDEO_PERCEPTION_TOOLS.has(String(entry.tool || '').trim().toLowerCase())
    && entry.params?.faces === true
  ));
  const frameCaptureIndex = successfulEntries.findIndex((entry, index) => (
    index > lastMutationIndex
    && VIDEO_FRAME_TOOLS.has(String(entry.tool || '').trim().toLowerCase())
    && Array.isArray(entry.params?.frames)
    && entry.params.frames.length >= 3
  ));
  const frameCapture = frameCaptureIndex >= 0;
  const frameInspectionIndex = frameCapture ? successfulEntries.findIndex((entry, index) => {
    if (index <= frameCaptureIndex) return false;
    const tool = String(entry.tool || '').trim().toLowerCase();
    if (!FRAME_INSPECTION_TOOLS.has(tool)) return false;
    return /(?:Videos\/[^/]+\/thumbnails\/frame_|\/thumbnails\/frame_)/i.test(JSON.stringify(entry.params || {}));
  }) : -1;
  const frameInspection = frameInspectionIndex >= 0;
  const lint = successfulEntries.some((entry, index) => (
    index > Math.max(lastMutationIndex, frameInspectionIndex)
    && VIDEO_LINT_TOOLS.has(String(entry.tool || '').trim().toLowerCase())
    && (() => {
      const payload = (entry.result && typeof entry.result === 'object')
        ? entry.result
        : safeJsonParse(entry.summary);
      return !payload || (payload.ok !== false && Number(payload.errors || 0) === 0);
    })()
  ));
  const renderComplete = successfulEntries.some((entry) => {
    if (!VIDEO_RENDER_STATUS_TOOLS.has(String(entry.tool || '').trim().toLowerCase())) return false;
    const payload = (entry.result && typeof entry.result === 'object')
      ? entry.result
      : safeJsonParse(entry.summary);
    const job = payload?.job || payload?.render || {};
    const status = String(payload?.status || job?.status || '').trim().toLowerCase();
    const output = payload?.outputPath || payload?.url || job?.outputPath || job?.url || null;
    return ['complete', 'completed', 'succeeded', 'ready'].includes(status) && Boolean(output);
  });
  const motionSceneComplete = successfulEntries.some((entry) => {
    if (!VIDEO_MOTION_STATUS_TOOLS.has(String(entry.tool || '').trim().toLowerCase())) return false;
    const payload = (entry.result && typeof entry.result === 'object')
      ? entry.result
      : safeJsonParse(entry.summary);
    const job = payload?.job || payload?.render || payload?.latestRender || payload?.scene?.latestRender || {};
    const status = String(payload?.status || job?.status || payload?.scene?.renderStatus || '').trim().toLowerCase();
    const output = payload?.outputPath || payload?.path || payload?.assetId
      || job?.outputPath || job?.path || job?.assetId || payload?.scene?.outputAssetId || null;
    return ['complete', 'completed', 'succeeded', 'ready'].includes(status) && Boolean(output);
  });
  // HyperFrames often fails (empty WEBM / missing worker). After an explicit failed
  // motion status/render, do not block the whole production export forever.
  const motionSceneFailed = (Array.isArray(toolLog) ? toolLog : []).some((entry) => {
    const tool = String(entry?.tool || '').trim().toLowerCase();
    if (!VIDEO_MOTION_STATUS_TOOLS.has(tool) && !VIDEO_MOTION_RENDER_TOOLS.has(tool)
      && tool !== 'video_motion_scene_create') {
      return false;
    }
    const payload = (entry.result && typeof entry.result === 'object')
      ? entry.result
      : safeJsonParse(entry.summary);
    const job = payload?.job || payload?.render || {};
    const status = String(payload?.status || job?.status || payload?.scene?.renderStatus || '').trim().toLowerCase();
    const err = String(payload?.error || job?.error || payload?.message || entry?.summary || '');
    if (entry?.success === false || entry?.is_error === true) return true;
    if (['failed', 'error'].includes(status)) return true;
    if (/hyperframes|empty webm|worker|motion_output|motion_worker|unavailable/i.test(err)) return true;
    return false;
  });
  const motionDegraded = Boolean(
    (contract?.requiresMotionSceneCreate || contract?.requiresMotionSceneRender || contract?.requiresMotionSceneStatus)
    && motionSceneFailed
    && !motionSceneComplete
    && mutation
  );
  const packageEvidence = (entry) => {
    const result = (entry.result && typeof entry.result === 'object')
      ? entry.result
      : safeJsonParse(entry.summary);
    return { ...(result?.packaging || result?.appliedPackaging || {}), ...(entry.params || {}) };
  };
  const packagedTitle = successfulEntries.some((entry) => {
    if (!VIDEO_PACKAGE_TOOLS.has(String(entry.tool || '').trim().toLowerCase())) return false;
    const evidence = packageEvidence(entry);
    return typeof evidence.title === 'string' && evidence.title.trim().length > 0;
  });
  const packagedZoom = successfulEntries.some((entry) => (
    VIDEO_PACKAGE_TOOLS.has(String(entry.tool || '').trim().toLowerCase())
    && typeof packageEvidence(entry).zoomTemplateId === 'string'
    && packageEvidence(entry).zoomTemplateId.trim().length > 0
  ));
  const packagedTransition = successfulEntries.some((entry) => (
    VIDEO_PACKAGE_TOOLS.has(String(entry.tool || '').trim().toLowerCase())
    && typeof packageEvidence(entry).transitionId === 'string'
    && packageEvidence(entry).transitionId.trim().length > 0
  ));
  const packagedEffect = successfulEntries.some((entry) => {
    if (!VIDEO_PACKAGE_TOOLS.has(String(entry.tool || '').trim().toLowerCase())) return false;
    const evidence = packageEvidence(entry);
    return (typeof evidence.effectId === 'string' && evidence.effectId.trim().length > 0)
      || evidence.greenscreen === true;
  });
  const missing = [];
  if (contract?.requiresMutation && !mutation) missing.push('timeline mutation');
  if (contract?.requiresBrandCheck && !brandCheck) missing.push('brand guideline check');
  if (contract?.requiresDesignStyle && !designStyle) missing.push('design style preset');
  if (contract?.requiresPerception && !perception) missing.push('face-aware perception');
  if (contract?.requiresCaptions && !captions) missing.push('captions');
  if (contract?.requiresAnimatedTitlePackaging && !packagedTitle) missing.push('animated title packaging');
  if (contract?.requiresZoomPackaging && !packagedZoom) missing.push('zoom/reframe packaging');
  if (contract?.requiresTransitionPackaging && !packagedTransition) missing.push('transition packaging');
  if (contract?.requiresEffectPackaging && !packagedEffect) missing.push('effect packaging');
  if (contract?.requiresRemotionCapabilities && !remotionCapabilities) missing.push('Remotion capability selection');
  if (contract?.requiresMotionSceneCreate && !motionSceneCreate && !motionDegraded) missing.push('motion scene creation');
  if (contract?.requiresMotionSceneRender && !motionSceneRender && !motionDegraded) missing.push('motion scene render start');
  if (contract?.requiresMotionSceneStatus && !motionSceneStatus && !motionDegraded) missing.push('motion scene status check');
  if (contract?.requiresMotionSceneStatus && motionSceneStatus && !motionSceneComplete && !motionDegraded) {
    missing.push('completed motion scene output');
  }
  if (contract?.requiresFrameCapture && !frameCapture) missing.push('post-edit representative frames');
  if (contract?.requiresFrameInspection && !frameInspection) missing.push('visual frame inspection');
  if (contract?.requiresLint && !lint) missing.push('post-edit video lint');
  if (contract?.requiresRenderStart && !renderStart) missing.push('render start');
  if (contract?.requiresRenderStatus && !renderStatus) missing.push('render status check');
  if (contract?.requiresRenderStatus && renderStatus && !renderComplete) missing.push('completed render output');
  return {
    complete: contract?.enabled !== true || missing.length === 0,
    mutation,
    renderStart,
    renderStatus,
    captions,
    designStyle,
    brandCheck,
    perception,
    frameCapture,
    frameInspection,
    lint,
    renderComplete,
    packagedTitle,
    packagedZoom,
    packagedTransition,
    packagedEffect,
    remotionCapabilities,
    motionSceneCreate,
    motionSceneRender,
    motionSceneStatus,
    motionSceneComplete,
    motionDegraded,
    missing,
    tools,
  };
}

/**
 * True when the agent's final message is genuinely asking the human to decide
 * something (plan approval, option selection, missing constraint) rather than
 * claiming completion. Completion contracts must NOT bulldoze such turns with
 * a continuation — "plan first, then ask" is legitimate work, and forcing
 * execution past an open question overrides the human.
 *
 * Heuristic on the closing section of the response: a question mark near the
 * end, or an explicit decision request phrase. Deliberately conservative —
 * a status line that happens to contain "?" mid-message does not count.
 */
export function responseRequestsUserDecision(response = '') {
  const text = String(response || '').trim();
  if (!text) return false;
  const tail = text.slice(-600);
  const lines = tail.split('\n').map((line) => line.trim()).filter(Boolean);
  const closing = lines.slice(-4).join('\n');
  const decisionPhrases = /\b(?:want me to|should i|shall i|would you like|do you want|let me know|which (?:one|option|clips?|version)|confirm (?:before|to)|approve|go ahead|proceed\?|or adjust|pick (?:one|an option)|choose (?:one|an option)|before i (?:proceed|continue|start|render))\b/i;
  const endsWithQuestion = /\?\s*(?:[)\]"'*_`]*)\s*$/.test(closing);
  if (endsWithQuestion) return true;
  return decisionPhrases.test(closing) && /\?/.test(tail);
}

export function buildVideoExecutionContinuation({ evaluation, attempt = 1 } = {}) {
  const missing = Array.isArray(evaluation?.missing) && evaluation.missing.length > 0
    ? evaluation.missing.join(', ')
    : 'required video deliverable actions';
  const successfulTools = Array.isArray(evaluation?.tools) && evaluation.tools.length > 0
    ? evaluation.tools.join(', ')
    : 'none';
  return `[SYSTEM CONTINUATION — VIDEO RUN INCOMPLETE, ATTEMPT ${attempt}]
Do not provide another plan or status-only answer. The prior turn ended without: ${missing}.
Successful tools so far: ${successfulTools}.

Continue the existing project now (FrameDeck-style editor pipeline). Reuse the project and analysis already in this session. Do not request transcript page 0 again.
Priority order — only do steps still missing:
1) Cuts: video_cut_range / video_make_shorts / transcript keep-cut
2) Design: video_set_design_style (podcast-short or kinetic-social)
3) Subtitles: video_captions_generate (required for TikTok/shorts)
4) Hook title: video_package_short with title (upper-third; no HyperFrames unless the human asked)
5) If motion was required and failed twice: remove unbaked scenes and continue
6) Production QA only if required: video_frames + lint
7) video_render_start → poll until completed outputPath
Then report projectUrl (editor) + outputPath. If a required tool fails, return the exact tool error instead of claiming completion.`;
}

export const __testables = {
  VIDEO_MUTATION_TOOLS,
  VIDEO_RENDER_START_TOOLS,
  VIDEO_RENDER_STATUS_TOOLS,
  VIDEO_CAPTION_TOOLS,
  VIDEO_PACKAGE_TOOLS,
  VIDEO_DESIGN_STYLE_TOOLS,
  VIDEO_BRAND_TOOLS,
  VIDEO_PERCEPTION_TOOLS,
  VIDEO_FRAME_TOOLS,
  VIDEO_LINT_TOOLS,
  VIDEO_REMOTION_CAPABILITY_TOOLS,
  VIDEO_MOTION_CREATE_TOOLS,
  VIDEO_MOTION_RENDER_TOOLS,
  VIDEO_MOTION_STATUS_TOOLS,
  FRAME_INSPECTION_TOOLS,
  VIDEO_EXECUTION_RULES_START,
};
