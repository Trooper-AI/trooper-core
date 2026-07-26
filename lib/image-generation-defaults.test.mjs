import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_GENERATION_DRAFT_DEFAULTS,
  buildImageGenerationDefaultsPrompt,
  buildImageGenerationEventMetadata,
  isImageGenerationTool,
} from './image-generation-defaults.mjs';

test('image generation draft policy uses a 1K low-quality, JPEG-friendly request', () => {
  assert.deepEqual(IMAGE_GENERATION_DRAFT_DEFAULTS, {
    quality: 'low',
    resolution: '1K',
    size: '1024x1024',
    outputFormat: 'jpeg',
    openai: { outputCompression: 75 },
  });
  const prompt = buildImageGenerationDefaultsPrompt();
  assert.match(prompt, /quality: "low"/);
  assert.match(prompt, /resolution: "1K"/);
  assert.match(prompt, /size: "1024x1024"/);
  assert.match(prompt, /Only raise quality\/resolution.*explicitly asks/);
});

test('image generation tool detection includes native and legacy names only', () => {
  assert.equal(isImageGenerationTool('image_generate'), true);
  assert.equal(isImageGenerationTool('generate_image'), true);
  assert.equal(isImageGenerationTool('video_generate'), false);
});

test('image generation event metadata retains requested settings and provider normalization', () => {
  const metadata = buildImageGenerationEventMetadata({
    tool: 'image_generate',
    params: {
      prompt: 'do not copy this into metadata',
      quality: 'low',
      resolution: '1K',
      size: '1024x1024',
      outputFormat: 'jpeg',
      openai: { outputCompression: 75, user: 'must-not-leak' },
    },
    details: {
      provider: 'openrouter',
      model: 'google/gemini-3.1-flash-image-preview',
      normalization: {
        requested: { resolution: '1K', outputFormat: 'jpeg' },
        applied: { resolution: '1K' },
        ignoredOverrides: ['outputFormat'],
      },
    },
  });

  assert.deepEqual(metadata, {
    requested: {
      size: '1024x1024',
      resolution: '1K',
      quality: 'low',
      outputFormat: 'jpeg',
      openai: { outputCompression: 75 },
    },
    applied: { resolution: '1K' },
    normalization: {
      requested: { resolution: '1K', outputFormat: 'jpeg' },
      applied: { resolution: '1K' },
      ignoredOverrides: ['outputFormat'],
    },
    ignoredOverrides: ['outputFormat'],
    provider: 'openrouter',
    model: 'google/gemini-3.1-flash-image-preview',
  });
});

test('metadata leaves unrelated tools alone', () => {
  assert.equal(buildImageGenerationEventMetadata({ tool: 'write', params: { path: 'a.md' } }), null);
});
