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

- Do not finalize after only project, media, transcript, perception, highlight, workflow, or skill reads.
- Before the final answer, successfully call a real timeline mutation tool such as \`video_edit\`, \`video_timeline_apply\`, \`video_cut_range\`, \`video_make_shorts\`, or \`video_transcript_keep/cut\`.
- For production-ready TikTok, Reel, or Short work, successfully call \`video_set_design_style\` with canonical \`styleId\` (never legacy \`style\` or \`lookId\`) before captions and packaging.
- Before production-ready short-form edits, call \`video_perception\` with \`faces:true\` so cuts and reframes use scene, energy, silence, and face evidence instead of guesses.
- Before production styling, call \`video_brand_guidelines\` with \`action:"get"\`. Apply the saved profile when configured; if none exists, use the chosen style pack and never invent a font, logo, or color.
- When the request asks for captions, successfully call \`video_captions_generate\`.
- When the request asks for an animated title, zoom/reframe, transition, or effect, call \`video_package_short\` with the requested \`title\`, \`zoomTemplateId\`, \`transitionId\`, and/or \`effectId\`; do not approximate these fields with generic timeline operations.
- When the request explicitly asks for motion graphics, an explainer, layers, animated highlights/callouts, shaders/WebGL, or HTML-in-canvas work, first call \`video_remotion_capabilities\`, then create a relevant \`video_motion_scene_create\`, call \`video_motion_scene_render\`, and poll \`video_motion_scene_status\` until a completed output is registered on the timeline. Reading a motion skill or creating source alone is not completion.
- Remotion primitives are a capability library, not a mandate to stack every effect. Select the smallest coherent set that explains the narration and survives frame/lint QA.
- After the last production-ready mutation, call \`video_frames\` at representative beginning/middle/end frames, inspect at least one returned still with \`read\`/\`image\`, and run \`video_lint\`. Fix placement, safe-area, font, caption, or overlap problems before rendering.
- For a draft, production-ready, post-ready, TikTok, Reel, or Short request, also call \`video_render_start\` and poll \`video_render_status\` (or the equivalent director/motion render tools) until a terminal completed status and output path exist.
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
  const requiresRender = enabled && /\b(?:production|post[- ]ready|publish|final|draft|render|tiktoks?|reels?|shorts?)\b/.test(taskText);
  const contract = {
    enabled,
    requiresMutation: enabled,
    requiresRenderStart: requiresRender,
    requiresRenderStatus: requiresRender,
  };
  if (enabled && /\b(?:production|post[- ]ready|publish|final|tiktoks?|reels?|shorts?)\b/.test(taskText)) {
    contract.requiresDesignStyle = true;
    contract.requiresBrandCheck = true;
    contract.requiresPerception = true;
    contract.requiresFrameCapture = true;
    contract.requiresFrameInspection = true;
    contract.requiresLint = true;
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
  if (contract?.requiresMotionSceneCreate && !motionSceneCreate) missing.push('motion scene creation');
  if (contract?.requiresMotionSceneRender && !motionSceneRender) missing.push('motion scene render start');
  if (contract?.requiresMotionSceneStatus && !motionSceneStatus) missing.push('motion scene status check');
  if (contract?.requiresMotionSceneStatus && motionSceneStatus && !motionSceneComplete) missing.push('completed motion scene output');
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
    missing,
    tools,
  };
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

Continue the existing project now. Reuse the project and analysis already in this session. Do not request transcript page 0 again. Use highlights/perception or the transcript page already read, choose the strongest workable segment, apply the edit, create and terminally render any required motion scene, add the requested packaging, run post-composite frames/lint, start the whole-project render, and check its status. Only then return a concise deliverable report. If a required tool fails, return the exact tool error instead of claiming completion.`;
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
