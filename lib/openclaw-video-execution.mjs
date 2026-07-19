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

const VIDEO_EXECUTION_RULES_START = '<!-- OPENCLAW_VIDEO_EXECUTION_CONTRACT_START -->';
const VIDEO_EXECUTION_RULES_END = '<!-- OPENCLAW_VIDEO_EXECUTION_CONTRACT_END -->';

export const OPENCLAW_VIDEO_EXECUTION_RULES = `${VIDEO_EXECUTION_RULES_START}
## Video execution completion contract

When the human asks to create, edit, package, or render a video, planning and analysis are intermediate work—not completion.

- Do not finalize after only project, media, transcript, perception, highlight, workflow, or skill reads.
- Before the final answer, successfully call a real timeline mutation tool such as \`video_edit\`, \`video_timeline_apply\`, \`video_cut_range\`, \`video_make_shorts\`, or \`video_transcript_keep/cut\`.
- For a draft, production-ready, post-ready, TikTok, Reel, or Short request, also call \`video_render_start\` and \`video_render_status\` (or the equivalent director/motion render tools).
- A truncated transcript page is enough to proceed. Never request transcript page 0 twice. Use \`nextStartIndex\` for another page, or use highlights/perception and make the best editorial choice.
- Keep progress narration short. Tool calls and the resulting project/render are the work product.
- If required tools fail, report the exact failed tool and error. Never label an analysis-only run complete.
${VIDEO_EXECUTION_RULES_END}`;

function normalizedToolNames(toolLog = []) {
  return (Array.isArray(toolLog) ? toolLog : [])
    .filter((entry) => entry && entry.success !== false)
    .map((entry) => String(entry.tool || '').trim().toLowerCase())
    .filter(Boolean);
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
    || /\bvideo_(?:project|edit|timeline|cut|make_shorts|render|transcript|highlights|perception)\b/.test(combined)
    || /\b(?:tiktok|reel|youtube short|video edit|podcast clip|long[- ]to[- ]short)\b/.test(combined);
  const executionSignal = /\b(?:create|make|edit|cut|package|produce|render|generate|turn|convert|deliver|post)\b/.test(taskText);
  const analysisSignal = /\b(?:analy[sz]e|inspect|transcri(?:be|pt)|summarize|plan|recommend|explain|review)\b/.test(taskText);
  const explicitlyPlanOnly = analysisSignal
    && !executionSignal
    && /\b(?:only|just)\b/.test(taskText);

  const enabled = videoSignal && executionSignal && !explicitlyPlanOnly;
  const requiresRender = enabled && /\b(?:production|post[- ]ready|publish|final|draft|render|tiktok|reel|short)\b/.test(taskText);
  return {
    enabled,
    requiresMutation: enabled,
    requiresRenderStart: requiresRender,
    requiresRenderStatus: requiresRender,
  };
}

export function evaluateVideoExecutionCompletion(toolLog = [], contract = {}) {
  const tools = normalizedToolNames(toolLog);
  const mutation = hasAny(VIDEO_MUTATION_TOOLS, tools);
  const renderStart = hasAny(VIDEO_RENDER_START_TOOLS, tools);
  const renderStatus = hasAny(VIDEO_RENDER_STATUS_TOOLS, tools);
  const missing = [];
  if (contract?.requiresMutation && !mutation) missing.push('timeline mutation');
  if (contract?.requiresRenderStart && !renderStart) missing.push('render start');
  if (contract?.requiresRenderStatus && !renderStatus) missing.push('render status check');
  return {
    complete: contract?.enabled !== true || missing.length === 0,
    mutation,
    renderStart,
    renderStatus,
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

Continue the existing project now. Reuse the project and analysis already in this session. Do not request transcript page 0 again. Use highlights/perception or the transcript page already read, choose the strongest workable segment, apply the edit, add the requested packaging, start the render, and check its status. Only then return a concise deliverable report. If a required tool fails, return the exact tool error instead of claiming completion.`;
}

export const __testables = {
  VIDEO_MUTATION_TOOLS,
  VIDEO_RENDER_START_TOOLS,
  VIDEO_RENDER_STATUS_TOOLS,
  VIDEO_EXECUTION_RULES_START,
};
