import test from 'node:test';
import assert from 'node:assert/strict';

import {
  IMAGE_GENERATION_DEFAULTS_PLUGIN_ID,
  buildImageGenerationDefaultsPluginFiles,
} from './image-generation-defaults-plugin.mjs';

async function loadPlugin() {
  const files = buildImageGenerationDefaultsPluginFiles();
  const byPath = Object.fromEntries(files.map((file) => [file.path, file.content]));
  const dataUrl = `data:text/javascript;base64,${Buffer.from(byPath['index.js']).toString('base64')}`;
  const mod = await import(dataUrl);
  const hooks = new Map();
  mod.default({
    on(name, handler) {
      hooks.set(name, handler);
    },
  });
  return { files, byPath, hooks };
}

test('the gateway plugin declares a valid OpenClaw plugin package', async () => {
  const { files, byPath, hooks } = await loadPlugin();
  assert.equal(files.length, 3);
  assert.equal(JSON.parse(byPath['openclaw.plugin.json']).id, IMAGE_GENERATION_DEFAULTS_PLUGIN_ID);
  assert.deepEqual(JSON.parse(byPath['package.json']).openclaw.extensions, ['./index.js']);
  assert.deepEqual([...hooks.keys()].sort(), ['agent_end', 'before_agent_run', 'before_tool_call']);
});

test('before_tool_call applies compact defaults to the outgoing native image_generate params', async () => {
  const { hooks } = await loadPlugin();
  const result = hooks.get('before_tool_call')({
    toolName: 'image_generate',
    params: { prompt: 'A friendly mushroom mascot', model: 'must-not-change' },
  }, { runId: 'draft-run', sessionKey: 'agent:main:trooper:draft' });

  assert.deepEqual(result, {
    params: {
      prompt: 'A friendly mushroom mascot',
      model: 'must-not-change',
      quality: 'low',
      resolution: '1K',
      size: '1024x1024',
      outputFormat: 'jpeg',
      openai: { outputCompression: 75 },
    },
  });
});

test('ordinary human requests cannot be escalated by model-supplied high detail tool args', async () => {
  const { hooks } = await loadPlugin();
  const ctx = { runId: 'ordinary-run', sessionKey: 'agent:main:trooper:ordinary' };
  hooks.get('before_agent_run')({ runId: 'ordinary-run', prompt: 'Please make a friendly cat portrait.' }, ctx);

  const result = hooks.get('before_tool_call')({
    toolName: 'image_generate',
    params: {
      prompt: 'A highly detailed 4K friendly cat portrait',
      quality: 'high',
      resolution: '4K',
      size: '3840x2160',
      outputFormat: 'png',
      openai: { outputCompression: 100 },
    },
  }, ctx);

  assert.deepEqual(result, {
    params: {
      prompt: 'A highly detailed 4K friendly cat portrait',
      quality: 'low',
      resolution: '1K',
      size: '1024x1024',
      outputFormat: 'jpeg',
      openai: { outputCompression: 75 },
    },
  });
});

test('ordinary aspect-ratio requests keep their composition but cannot retain an oversized size', async () => {
  const { hooks } = await loadPlugin();
  const result = hooks.get('before_tool_call')({
    toolName: 'image_generate',
    params: { prompt: 'A portrait', aspectRatio: '9:16', size: '3840x2160', resolution: '4K' },
  }, {});

  assert.deepEqual(result, {
    params: {
      prompt: 'A portrait',
      aspectRatio: '9:16',
      quality: 'low',
      resolution: '1K',
      outputFormat: 'jpeg',
      openai: { outputCompression: 75 },
    },
  });
});

test('a high-detail parent marker cannot leak into a different child run in the same session', async () => {
  const { hooks } = await loadPlugin();
  const parent = { runId: 'parent-run', sessionKey: 'agent:main:trooper:shared' };
  hooks.get('before_agent_run')({ runId: 'parent-run', prompt: 'Please create a 4K poster.' }, parent);

  const child = { runId: 'child-run', sessionKey: 'agent:main:trooper:shared' };
  const result = hooks.get('before_tool_call')({
    toolName: 'image_generate',
    params: { prompt: 'A normal child-run draft', quality: 'high', resolution: '4K' },
  }, child);
  assert.equal(result.params.quality, 'low');
  assert.equal(result.params.resolution, '1K');
});

test('the native boundary upgrades an explicit human high-resolution or upscale request', async () => {
  const { hooks } = await loadPlugin();
  const ctx = { runId: 'high-run', sessionKey: 'agent:main:trooper:high' };
  hooks.get('before_agent_run')({ runId: 'high-run', prompt: 'Please upscale the chosen image for a print-ready poster.' }, ctx);

  const upgraded = hooks.get('before_tool_call')({ toolName: 'image_generate', params: {
    prompt: 'A poster from the supplied image',
    outputFormat: 'png',
  } }, ctx);
  assert.deepEqual(upgraded, {
    params: {
      prompt: 'A poster from the supplied image',
      outputFormat: 'png',
      quality: 'high',
      resolution: '2K',
      size: '2048x2048',
    },
  });

  const cappedGenericUpscale = hooks.get('before_tool_call')({ toolName: 'image_generate', params: {
    prompt: 'A poster from the supplied image',
    quality: 'high',
    resolution: '4K',
    size: '3840x2160',
  } }, ctx);
  assert.deepEqual(cappedGenericUpscale, {
    params: {
      prompt: 'A poster from the supplied image',
      quality: 'high',
      resolution: '2K',
      size: '2048x2048',
    },
  });

  hooks.get('before_agent_run')({ runId: 'high-run', prompt: 'Please make a literal 4K poster.' }, ctx);
  const explicit4k = hooks.get('before_tool_call')({ toolName: 'image_generate', params: {
    prompt: 'A poster from the supplied image',
    quality: 'high',
    resolution: '4K',
    size: '3840x2160',
  } }, ctx);
  assert.equal(explicit4k, undefined);

  hooks.get('agent_end')({ runId: 'high-run' }, ctx);
  const afterCleanup = hooks.get('before_tool_call')({ toolName: 'image_generate', params: { prompt: 'A new draft' } }, ctx);
  assert.equal(afterCleanup.params.quality, 'low');
});

test('the native boundary preserves transparent output and skips status/list actions', async () => {
  const { hooks } = await loadPlugin();
  const transparent = hooks.get('before_tool_call')({
    toolName: 'image_generate',
    params: { prompt: 'Transparent sticker', background: 'transparent', outputFormat: 'png' },
  }, {});
  assert.deepEqual(transparent, {
    params: {
      prompt: 'Transparent sticker',
      background: 'transparent',
      outputFormat: 'png',
      quality: 'low',
      resolution: '1K',
      size: '1024x1024',
    },
  });
  const repairedTransparent = hooks.get('before_tool_call')({
    toolName: 'image_generate',
    params: { prompt: 'Transparent sticker', background: 'transparent', outputFormat: 'jpeg' },
  }, {});
  assert.equal(repairedTransparent.params.outputFormat, 'png');
  assert.equal(hooks.get('before_tool_call')({ toolName: 'image_generate', params: { action: 'status' } }, {}), undefined);
  assert.equal(hooks.get('before_tool_call')({ toolName: 'write', params: {} }, {}), undefined);
});
