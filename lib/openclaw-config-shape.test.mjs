import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getOpenClawAgentList,
  hydrateOpenClawAgentList,
  migrateOpenClawAgentRoster,
  migrateOpenClawMediaModels,
} from './openclaw-config-shape.mjs';

test('agent roster migration converts legacy arrays to keyed entries and preserves settings', () => {
  const config = {
    agents: {
      list: [
        { id: 'main', default: true, name: 'Team Lead', model: 'openrouter/z-ai/glm-5.3-flash' },
        { id: 'builder', name: 'Builder', tools: { allow: ['read'] } },
      ],
    },
  };

  assert.equal(migrateOpenClawAgentRoster(config), true);
  assert.equal(config.agents.list, undefined);
  assert.deepEqual(config.agents.entries, {
    builder: { name: 'Builder', tools: { allow: ['read'] } },
    main: { default: true, name: 'Team Lead', model: 'openrouter/z-ai/glm-5.3-flash' },
  });
  assert.equal(migrateOpenClawAgentRoster(config), false);
});

test('keyed entries and legacy list are merged by id with list values taking precedence', () => {
  const config = {
    agents: {
      entries: { main: { name: 'Modern', model: 'openai/gpt-6-luna' }, worker: { name: 'Worker' } },
      list: [{ id: 'main', name: 'Legacy override' }],
    },
  };

  assert.deepEqual(getOpenClawAgentList(config), [
    { id: 'main', name: 'Legacy override', model: 'openai/gpt-6-luna' },
    { id: 'worker', name: 'Worker' },
  ]);
  hydrateOpenClawAgentList(config);
  assert.equal(config.agents.list[1].id, 'worker');
});

test('media generation routes move to current mediaModels slots without overwriting explicit slots', () => {
  const config = {
    agents: {
      defaults: {
        imageGenerationModel: { primary: 'openrouter/black-forest-labs/flux.1-pro' },
        videoGenerationModel: 'openrouter/bytedance/seedance',
        musicGenerationModel: 'openrouter/udio/udio-1.5',
        mediaModels: { image: 'openai/gpt-image-2' },
      },
    },
  };

  assert.equal(migrateOpenClawMediaModels(config), true);
  assert.deepEqual(config.agents.defaults.mediaModels, {
    image: 'openai/gpt-image-2',
    video: 'openrouter/bytedance/seedance',
    music: 'openrouter/udio/udio-1.5',
  });
  assert.equal(config.agents.defaults.imageGenerationModel, undefined);
  assert.equal(config.agents.defaults.videoGenerationModel, undefined);
  assert.equal(config.agents.defaults.musicGenerationModel, undefined);
  assert.equal(migrateOpenClawMediaModels(config), false);
});
