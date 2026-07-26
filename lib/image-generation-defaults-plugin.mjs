// Gateway-side enforcement for Trooper's economical image-generation default.
//
// OpenClaw accepts image quality/geometry on each image_generate call. A bridge
// system prompt tells the model what to send, but cannot guarantee that the
// model includes those optional arguments. This plugin uses the documented
// before_tool_call hook to merge the draft settings into the *actual* native
// tool request immediately before provider execution.

export const IMAGE_GENERATION_DEFAULTS_PLUGIN_ID = 'trooper-image-generation-defaults';

/**
 * Build an OpenClaw plugin that defaults ordinary image generations to a
 * compact 1K JPEG. It retains only compact in-memory high-detail settings per
 * run/session when a human explicitly requests high resolution or an upscale;
 * raw user text is never persisted or sent outside the gateway.
 */
export function buildImageGenerationDefaultsPluginFiles() {
  const manifest = {
    id: IMAGE_GENERATION_DEFAULTS_PLUGIN_ID,
    configSchema: {
      type: 'object',
      additionalProperties: true,
    },
  };

  const packageJson = {
    name: IMAGE_GENERATION_DEFAULTS_PLUGIN_ID,
    version: '1.0.0',
    type: 'module',
    main: 'index.js',
    openclaw: { extensions: ['./index.js'] },
  };

  const entry = `// trooper-image-generation-defaults — enforce low-cost native image defaults.
const DRAFT = Object.freeze({
  quality: 'low',
  resolution: '1K',
  size: '1024x1024',
  outputFormat: 'jpeg',
  openai: Object.freeze({ outputCompression: 75 }),
});

// Keep this intentionally narrow. Terms such as "detailed" or "beautiful"
// are common style language and must never opt a request out of the draft
// default. Only an explicit high-resolution/print/upscale request does.
const EXPLICIT_HIGH_DETAIL_RE = /(?:\\b(?:2k|4k|8k|hd|uhd)\\b|\\bhigh[-\\s]?resolution\\b|\\bhigh[-\\s]?res\\b|\\bprint[-\\s]?(?:quality|ready)\\b|\\bupscal(?:e|ed|ing)\\b|\\bquality\\s*(?:=|:)\\s*high\\b|\\bsize\\s*(?:=|:)\\s*(?:2048|3072|3840|4096)x(?:2048|2160|3072|3840|4096)\\b)/i;
const scopes = new Map();

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function scopeKeys(event, ctx) {
  const keys = [];
  const runId = event?.runId || ctx?.runId;
  const sessionKey = ctx?.sessionKey || event?.sessionKey;
  if (runId) keys.push('run:' + String(runId));
  if (sessionKey) keys.push('session:' + String(sessionKey));
  return keys;
}

function highDetailForScope(event, ctx) {
  const runId = event?.runId || ctx?.runId;
  if (runId) return scopes.get('run:' + String(runId));
  const sessionKey = ctx?.sessionKey || event?.sessionKey;
  return sessionKey ? scopes.get('session:' + String(sessionKey)) : null;
}

function highDetailSettingsForHumanRequest(text) {
  const value = String(text || '');
  if (!EXPLICIT_HIGH_DETAIL_RE.test(value)) return null;
  // OpenClaw's portable resolution contract is 1K/2K/4K. Generic high-res,
  // print, and upscale asks receive the conservative high-quality 2K setting;
  // a literal 4K request remains 4K.
  const resolution = /\\b(?:4k|8k)\\b/i.test(value) ? '4K' : '2K';
  return { quality: 'high', resolution };
}

function wantsTransparentOutput(params) {
  const background = String(params?.background || params?.openai?.background || '').trim().toLowerCase();
  return background === 'transparent';
}

function isGenerate(params) {
  const action = String(params?.action || 'generate').trim().toLowerCase();
  return action === 'generate';
}

function mergeDraftDefaults(input) {
  const params = object(input);
  const next = { ...params };
  let changed = false;
  const set = (key, value) => {
    if (next[key] === value) return;
    next[key] = value;
    changed = true;
  };

  // Tool params are model-controlled. Without a high-detail marker from the
  // originating human prompt, overwrite rather than merely fill them so a
  // model cannot silently select an expensive 2K/4K/high request.
  set('quality', DRAFT.quality);
  set('resolution', DRAFT.resolution);
  if (next.aspectRatio) {
    if (Object.prototype.hasOwnProperty.call(next, 'size')) {
      delete next.size;
      changed = true;
    }
  } else {
    set('size', DRAFT.size);
  }

  const transparent = wantsTransparentOutput(next);
  if (transparent) {
    const transparentFormat = String(next.outputFormat || '').trim().toLowerCase();
    // OpenClaw requires PNG/WebP for provider-transparent outputs. Do not let
    // a model combine transparent background with JPEG and lose alpha.
    if (transparentFormat !== 'png' && transparentFormat !== 'webp') set('outputFormat', 'png');
  } else {
    set('outputFormat', DRAFT.outputFormat);
  }

  // JPEG/WebP outputs can be compressed; never force JPEG/compression onto a
  // transparent image because that would discard alpha.
  const outputFormat = String(next.outputFormat || '').trim().toLowerCase();
  if (!transparent && (outputFormat === 'jpeg' || outputFormat === 'webp')) {
    const openai = object(next.openai);
    if (openai.outputCompression !== DRAFT.openai.outputCompression) {
      next.openai = { ...openai, outputCompression: DRAFT.openai.outputCompression };
      changed = true;
    }
  }

  return changed ? next : null;
}

function mergeExplicitHighDetailDefaults(input, highDetail) {
  const params = object(input);
  const next = { ...params };
  let changed = false;
  const set = (key, value) => {
    if (next[key] === value) return;
    next[key] = value;
    changed = true;
  };

  // The high-detail marker comes from the original human message. Tool
  // arguments still come from the model, so a generic "upscale" request must
  // not inherit an arbitrary 4K/oversized setting. Only a literal human 4K
  // request can keep 4K; every other high-detail ask is capped at 2K.
  set('quality', highDetail.quality);
  set('resolution', highDetail.resolution);
  if (highDetail.resolution === '2K') {
    if (next.aspectRatio) {
      if (Object.prototype.hasOwnProperty.call(next, 'size')) {
        delete next.size;
        changed = true;
      }
    } else {
      set('size', '2048x2048');
    }
  }
  return changed ? next : null;
}

export default function register(api) {
  const on = api && typeof api.on === 'function' ? api.on.bind(api) : null;
  if (!on) return;

  // before_agent_run is the only gateway hook that receives the originating
  // human prompt. Store only compact requested settings so before_tool_call
  // can honor a real high-resolution/upscale request without retaining user
  // content.
  on('before_agent_run', (event, ctx) => {
    const highDetail = highDetailSettingsForHumanRequest(event?.prompt);
    for (const key of scopeKeys(event, ctx)) scopes.set(key, highDetail);
  }, { priority: 80 });

  on('before_tool_call', (event, ctx) => {
    if (String(event?.toolName || '').trim().toLowerCase() !== 'image_generate') return;
    const params = object(event?.params);
    if (!isGenerate(params)) return;

    // Prefer a run marker whenever the gateway supplies one. Do not let a
    // high-res parent request leak into a distinct child run that happens to
    // share the same session key.
    const userRequestedHighDetail = highDetailForScope(event, ctx);
    if (userRequestedHighDetail) {
      const rewritten = mergeExplicitHighDetailDefaults(params, userRequestedHighDetail);
      return rewritten ? { params: rewritten } : undefined;
    }

    const rewritten = mergeDraftDefaults(params);
    return rewritten ? { params: rewritten } : undefined;
  }, { priority: 100 });

  on('agent_end', (event, ctx) => {
    for (const key of scopeKeys(event, ctx)) scopes.delete(key);
  });
}
`;

  return [
    { path: 'openclaw.plugin.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: 'package.json', content: `${JSON.stringify(packageJson, null, 2)}\n` },
    { path: 'index.js', content: entry },
  ];
}
