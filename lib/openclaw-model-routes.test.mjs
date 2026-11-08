import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePersistedOpenClawModelRoutes } from './openclaw-model-routes.mjs';

const normalize = (model) => String(model).replace(/^openai-codex\//, 'openai/');

test('migrates persisted primary, fallback, media, subagent, and per-agent model routes', () => {
  const config = {
    agents: {
      defaults: {
        model: { primary: 'openai-codex/gpt-5.6-luna', fallbacks: ['openai-codex/gpt-5.6-terra'] },
        imageModel: 'openai-codex/gpt-5.6-luna',
        pdfModel: 'openai-codex/gpt-5.6-terra',
        subagents: { model: 'openai-codex/gpt-5.6-luna' },
        models: { 'openai-codex/gpt-5.6-luna': { alias: 'Fast' } },
      },
      list: [{ id: 'main', model: { primary: 'openai-codex/gpt-5.6-luna' } }],
    },
  };

  assert.equal(normalizePersistedOpenClawModelRoutes(config, normalize), true);
  assert.deepEqual(config.agents.defaults.model, {
    primary: 'openai/gpt-5.6-luna',
    fallbacks: ['openai/gpt-5.6-terra'],
  });
  assert.equal(config.agents.defaults.imageModel, 'openai/gpt-5.6-luna');
  assert.equal(config.agents.defaults.pdfModel, 'openai/gpt-5.6-terra');
  assert.equal(config.agents.defaults.subagents.model, 'openai/gpt-5.6-luna');
  assert.deepEqual(config.agents.defaults.models, { 'openai/gpt-5.6-luna': { alias: 'Fast' } });
  assert.deepEqual(config.agents.list[0].model, { primary: 'openai/gpt-5.6-luna' });
});

test('does not change already canonical or unrelated model routes', () => {
  const config = { agents: { defaults: { model: { primary: 'openai/gpt-6-luna', fallbacks: ['openrouter/qwen/qwen3.7-max'] } } } };
  assert.equal(normalizePersistedOpenClawModelRoutes(config, normalize), false);
  assert.deepEqual(config.agents.defaults.model, {
    primary: 'openai/gpt-6-luna',
    fallbacks: ['openrouter/qwen/qwen3.7-max'],
  });
});
