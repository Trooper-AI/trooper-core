// Cross-provider fallback chains for OpenClaw's native image_generate tool.
//
// Trooper's model routing writes agents.defaults.imageGenerationModel as
// { primary, fallbacks } into openclaw.json. Historically every entry in that
// chain pointed at the same provider (OpenRouter), so a single provider-level
// failure (billing hard limit, auth, rate limit) killed the entire chain even
// when the org had working credentials for other image-capable providers.
//
// This module computes the extra fallback entries needed to make the chain
// span every image-capable provider the org actually has credentials for.
// It is pure: credential detection is injected by the caller.

/** Default image model per OpenClaw image provider (see the tool's provider catalog). */
export const IMAGE_PROVIDER_DEFAULT_MODELS = Object.freeze({
 openai: 'openai/gpt-image-2',
 google: 'google/gemini-3.1-flash-image-preview',
 fal: 'fal/fal-ai/flux/dev',
 xai: 'xai/grok-imagine-image',
 minimax: 'minimax/image-01',
 openrouter: 'openrouter/google/gemini-3.1-flash-image-preview',
});

/**
 * Priority order for auto-appended cross-provider fallbacks. Native providers
 * first (distinct billing domains); OpenRouter last because it is usually the
 * primary already and shares one billing account across all its models.
 */
export const IMAGE_FALLBACK_PROVIDER_ORDER = Object.freeze([
 'openai',
 'google',
 'fal',
 'xai',
 'minimax',
 'openrouter',
]);

/** First path segment of a `provider/model` ref, lowercased ('' when absent). */
export function imageProviderFromModelRef(modelRef) {
 const ref = String(modelRef || '').trim();
 const slash = ref.indexOf('/');
 if (slash <= 0) return '';
 return ref.slice(0, slash).toLowerCase();
}

/**
 * Build the augmented fallback list for an image generation chain.
 *
 * Keeps the caller-provided fallbacks (deduped, primary excluded) and appends
 * the default image model of every credentialed provider that is not already
 * represented anywhere in the chain. Providers without credentials are never
 * added — a fallback that cannot authenticate is a dead chain link.
 *
 * @param {object} args
 * @param {string} args.primary - primary `provider/model` ref; empty disables augmentation
 * @param {string[]} [args.fallbacks] - explicit fallback refs (user/org configured)
 * @param {(provider: string) => boolean} [args.hasProviderCredential]
 * @returns {{ fallbacks: string[], added: string[] }}
 */
export function buildCrossProviderImageFallbacks({
 primary,
 fallbacks = [],
 hasProviderCredential = () => false,
} = {}) {
 const primaryRef = String(primary || '').trim();
 const seenRefs = new Set(primaryRef ? [primaryRef] : []);
 const normalizedFallbacks = [];
 for (const raw of Array.isArray(fallbacks) ? fallbacks : []) {
  const ref = String(raw || '').trim();
  if (!ref || seenRefs.has(ref)) continue;
  seenRefs.add(ref);
  normalizedFallbacks.push(ref);
 }
 if (!primaryRef) return { fallbacks: normalizedFallbacks, added: [] };

 const chainProviders = new Set(
  [primaryRef, ...normalizedFallbacks].map(imageProviderFromModelRef).filter(Boolean),
 );
 const added = [];
 for (const provider of IMAGE_FALLBACK_PROVIDER_ORDER) {
  if (chainProviders.has(provider)) continue;
  const model = IMAGE_PROVIDER_DEFAULT_MODELS[provider];
  if (!model || seenRefs.has(model)) continue;
  let hasCredential = false;
  try {
   hasCredential = Boolean(hasProviderCredential(provider));
  } catch {
   hasCredential = false;
  }
  if (!hasCredential) continue;
  chainProviders.add(provider);
  seenRefs.add(model);
  added.push(model);
 }
 return { fallbacks: [...normalizedFallbacks, ...added], added };
}
