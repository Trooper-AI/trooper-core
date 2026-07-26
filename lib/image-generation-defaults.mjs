// Shared image-generation defaults for the Trooper bridge.
//
// OpenClaw exposes quality/geometry as per-tool-call arguments rather than
// config defaults. Keep the policy here for consistent bridge prompt guidance
// and event metadata; the companion gateway plugin enforces it at the native
// tool boundary. An explicit human high-resolution/upscale request can still
// override the draft setting.

export const IMAGE_GENERATION_DRAFT_DEFAULTS = Object.freeze({
  quality: 'low',
  resolution: '1K',
  size: '1024x1024',
  outputFormat: 'jpeg',
  openai: Object.freeze({
    outputCompression: 75,
  }),
});

const IMAGE_GENERATION_TOOL_RE = /^(?:image_generate|generate_image)$/i;
const GENERATION_SETTING_KEYS = Object.freeze([
  'model',
  'size',
  'aspectRatio',
  'resolution',
  'quality',
  'outputFormat',
  'background',
  'count',
]);
const OPENAI_SETTING_KEYS = Object.freeze([
  'background',
  'moderation',
  'outputCompression',
]);

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pickKnownSettings(value, keys) {
  if (!isPlainObject(value)) return {};
  const picked = {};
  for (const key of keys) {
    const candidate = value[key];
    if (candidate === undefined || candidate === null || candidate === '') continue;
    if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') {
      picked[key] = candidate;
    }
  }
  return picked;
}

function pickOpenAiSettings(value) {
  const picked = pickKnownSettings(value?.openai, OPENAI_SETTING_KEYS);
  return Object.keys(picked).length ? { openai: picked } : {};
}

function firstObject(...candidates) {
  return candidates.find(isPlainObject) || null;
}

function pickNormalization(normalization) {
  if (!isPlainObject(normalization)) return null;
  const requested = firstObject(normalization.requested, normalization.request);
  const applied = firstObject(
    normalization.applied,
    normalization.effective,
    normalization.settings,
    normalization.output,
  );
  const ignoredOverrides = Array.isArray(normalization.ignoredOverrides)
    ? normalization.ignoredOverrides.filter((entry) => typeof entry === 'string')
    : [];
  const next = {
    ...(requested ? { requested: { ...pickKnownSettings(requested, GENERATION_SETTING_KEYS), ...pickOpenAiSettings(requested) } } : {}),
    ...(applied ? { applied: { ...pickKnownSettings(applied, GENERATION_SETTING_KEYS), ...pickOpenAiSettings(applied) } } : {}),
    ...(ignoredOverrides.length ? { ignoredOverrides } : {}),
  };
  return Object.keys(next).length ? next : null;
}

/** Returns true for both OpenClaw's native and Trooper's legacy image tools. */
export function isImageGenerationTool(tool) {
  return IMAGE_GENERATION_TOOL_RE.test(String(tool || '').trim());
}

/**
 * A compact policy appended to every bridge system prompt. It is defense in
 * depth alongside the gateway's before_tool_call enforcement: OpenClaw accepts
 * these fields on individual image_generate calls, not under agents.defaults.
 */
export function buildImageGenerationDefaultsPrompt() {
  return `[SYSTEM RULE — IMAGE GENERATION DEFAULTS]
For every native image_generate call, keep the configured image model/fallback routing; do not add a per-call model override.
Unless the human explicitly asks for high resolution, HD, 2K/4K, print quality, or an upscale, make a low-cost draft request with quality: "low", resolution: "1K", outputFormat: "jpeg", and openai: { outputCompression: 75 }.
If the human did not request an aspect ratio, also pass size: "1024x1024". If they did request a non-square composition, pass that aspectRatio while keeping resolution: "1K"; do not silently select a 2K/4K or oversized size.
Only raise quality/resolution or regenerate/upscale from a completed image after the human explicitly asks. Keep the actual quality, resolution, size, and outputFormat in the tool arguments so the run record can show what was requested and what the provider applied.`;
}

/**
 * Normalizes the non-sensitive image settings that should accompany a tool
 * event. OpenClaw reports cross-provider remapping under details.normalization;
 * retaining it lets the UI distinguish the requested 1K draft from what a
 * provider actually accepted, without copying prompts or credentials.
 */
export function buildImageGenerationEventMetadata({
  tool,
  params = {},
  result = null,
  details = null,
} = {}) {
  if (!isImageGenerationTool(tool)) return null;

  const requested = {
    ...pickKnownSettings(params, GENERATION_SETTING_KEYS),
    ...pickOpenAiSettings(params),
  };
  const resultObject = isPlainObject(result) ? result : {};
  const detailsObject = isPlainObject(details) ? details : {};
  const normalization = pickNormalization(firstObject(
    detailsObject.normalization,
    resultObject?.details?.normalization,
    resultObject.normalization,
  ));
  const applied = {
    ...pickKnownSettings(firstObject(
      detailsObject.appliedSettings,
      detailsObject.applied,
      resultObject.appliedSettings,
      resultObject.applied,
      normalization?.applied,
    ), GENERATION_SETTING_KEYS),
    ...pickOpenAiSettings(firstObject(
      detailsObject.appliedSettings,
      detailsObject.applied,
      resultObject.appliedSettings,
      resultObject.applied,
      normalization?.applied,
    )),
  };
  const ignoredOverrides = [
    ...(Array.isArray(detailsObject.ignoredOverrides) ? detailsObject.ignoredOverrides : []),
    ...(Array.isArray(resultObject.ignoredOverrides) ? resultObject.ignoredOverrides : []),
    ...(Array.isArray(normalization?.ignoredOverrides) ? normalization.ignoredOverrides : []),
  ].filter((entry, index, list) => typeof entry === 'string' && list.indexOf(entry) === index);
  const provider = String(detailsObject.provider || resultObject.provider || '').trim();
  const model = String(detailsObject.model || resultObject.model || '').trim();

  return {
    requested,
    ...(Object.keys(applied).length ? { applied } : {}),
    ...(normalization ? { normalization } : {}),
    ...(ignoredOverrides.length ? { ignoredOverrides } : {}),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}
