import test from 'node:test';
import assert from 'node:assert/strict';
import {
 IMAGE_PROVIDER_DEFAULT_MODELS,
 IMAGE_FALLBACK_PROVIDER_ORDER,
 imageProviderFromModelRef,
 buildCrossProviderImageFallbacks,
} from './image-generation-routing.mjs';

test('imageProviderFromModelRef extracts the provider prefix', () => {
 assert.equal(imageProviderFromModelRef('openrouter/google/gemini-3.1-flash-image-preview'), 'openrouter');
 assert.equal(imageProviderFromModelRef('openai/gpt-image-2'), 'openai');
 assert.equal(imageProviderFromModelRef('OpenAI/gpt-image-2'), 'openai');
 assert.equal(imageProviderFromModelRef('gpt-image-2'), '');
 assert.equal(imageProviderFromModelRef(''), '');
 assert.equal(imageProviderFromModelRef(null), '');
});

test('appends credentialed providers missing from an all-OpenRouter chain', () => {
 const creds = new Set(['openai', 'google', 'openrouter']);
 const { fallbacks, added } = buildCrossProviderImageFallbacks({
  primary: 'openrouter/google/gemini-3.1-flash-image-preview',
  fallbacks: [
   'openrouter/google/gemini-3-pro-image-preview',
   'openrouter/openai/gpt-5.4-image-2',
  ],
  hasProviderCredential: (provider) => creds.has(provider),
 });
 assert.deepEqual(added, ['openai/gpt-image-2', 'google/gemini-3.1-flash-image-preview']);
 assert.deepEqual(fallbacks, [
  'openrouter/google/gemini-3-pro-image-preview',
  'openrouter/openai/gpt-5.4-image-2',
  'openai/gpt-image-2',
  'google/gemini-3.1-flash-image-preview',
 ]);
});

test('never adds providers without credentials', () => {
 const { fallbacks, added } = buildCrossProviderImageFallbacks({
  primary: 'openrouter/google/gemini-3.1-flash-image-preview',
  fallbacks: [],
  hasProviderCredential: () => false,
 });
 assert.deepEqual(added, []);
 assert.deepEqual(fallbacks, []);
});

test('skips providers already represented anywhere in the chain', () => {
 const creds = new Set(['openai', 'google']);
 const { added } = buildCrossProviderImageFallbacks({
  primary: 'openai/gpt-image-1.5',
  fallbacks: ['google/gemini-3-pro-image-preview'],
  hasProviderCredential: (provider) => creds.has(provider),
 });
 // openai covered by primary, google covered by explicit fallback — nothing to add.
 assert.deepEqual(added, []);
});

test('keeps user fallbacks first and dedupes exact refs and the primary', () => {
 const creds = new Set(['openai']);
 const { fallbacks } = buildCrossProviderImageFallbacks({
  primary: 'openrouter/google/gemini-3.1-flash-image-preview',
  fallbacks: [
   'openrouter/google/gemini-3.1-flash-image-preview', // dup of primary — dropped
   'openrouter/openai/gpt-5.4-image-2',
   'openrouter/openai/gpt-5.4-image-2', // exact dup — dropped
  ],
  hasProviderCredential: (provider) => creds.has(provider),
 });
 assert.deepEqual(fallbacks, [
  'openrouter/openai/gpt-5.4-image-2',
  'openai/gpt-image-2',
 ]);
});

test('no primary disables augmentation but still normalizes fallbacks', () => {
 const { fallbacks, added } = buildCrossProviderImageFallbacks({
  primary: '',
  fallbacks: ['openai/gpt-image-2', 'openai/gpt-image-2', '  '],
  hasProviderCredential: () => true,
 });
 assert.deepEqual(added, []);
 assert.deepEqual(fallbacks, ['openai/gpt-image-2']);
});

test('append order follows IMAGE_FALLBACK_PROVIDER_ORDER with openrouter last', () => {
 const { added } = buildCrossProviderImageFallbacks({
  primary: 'minimax/image-01',
  fallbacks: [],
  hasProviderCredential: () => true,
 });
 assert.deepEqual(added, [
  IMAGE_PROVIDER_DEFAULT_MODELS.openai,
  IMAGE_PROVIDER_DEFAULT_MODELS.google,
  IMAGE_PROVIDER_DEFAULT_MODELS.fal,
  IMAGE_PROVIDER_DEFAULT_MODELS.xai,
  IMAGE_PROVIDER_DEFAULT_MODELS.openrouter,
 ]);
 assert.equal(IMAGE_FALLBACK_PROVIDER_ORDER.at(-1), 'openrouter');
});

test('a throwing credential probe is treated as no credential', () => {
 const { added } = buildCrossProviderImageFallbacks({
  primary: 'openrouter/google/gemini-3.1-flash-image-preview',
  fallbacks: [],
  hasProviderCredential: () => { throw new Error('boom'); },
 });
 assert.deepEqual(added, []);
});
