/**
 * Migrate persisted model selectors before an upgraded OpenClaw gateway starts.
 * Older Trooper versions stored ChatGPT OAuth routes as openai-codex/*; current
 * OpenClaw uses the canonical openai/* route for those profiles.
 */
export function normalizePersistedOpenClawModelRoutes(config, normalizeModelId) {
  if (!config || typeof config !== 'object' || typeof normalizeModelId !== 'function') return false;
  let changed = false;
  const normalizeId = (value) => {
    if (typeof value !== 'string' || !value.trim()) return value;
    const normalized = normalizeModelId(value);
    if (normalized !== value) changed = true;
    return normalized;
  };
  const normalizeSelection = (selection) => {
    if (typeof selection === 'string') return normalizeId(selection);
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return selection;
    if (typeof selection.primary === 'string') selection.primary = normalizeId(selection.primary);
    if (Array.isArray(selection.fallbacks)) selection.fallbacks = selection.fallbacks.map(normalizeId);
    return selection;
  };

  const defaults = config.agents?.defaults;
  if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
    if (defaults.model !== undefined) defaults.model = normalizeSelection(defaults.model);
    for (const key of ['imageModel', 'pdfModel']) {
      if (typeof defaults[key] === 'string') defaults[key] = normalizeId(defaults[key]);
    }
    if (defaults.mediaModels && typeof defaults.mediaModels === 'object' && !Array.isArray(defaults.mediaModels)) {
      for (const slot of ['image', 'video', 'music']) {
        if (defaults.mediaModels[slot] !== undefined) {
          defaults.mediaModels[slot] = normalizeSelection(defaults.mediaModels[slot]);
        }
      }
    }
    if (defaults.subagents?.model !== undefined) {
      defaults.subagents.model = normalizeSelection(defaults.subagents.model);
    }
    const models = defaults.models;
    if (models && typeof models === 'object' && !Array.isArray(models)) {
      for (const [modelId, entry] of Object.entries(models)) {
        const normalizedId = normalizeId(modelId);
        if (normalizedId === modelId) continue;
        if (!Object.prototype.hasOwnProperty.call(models, normalizedId)) models[normalizedId] = entry;
        delete models[modelId];
      }
    }
  }

  const agentRecords = [
    ...(Array.isArray(config.agents?.list) ? config.agents.list : []),
    ...(config.agents?.entries && typeof config.agents.entries === 'object' && !Array.isArray(config.agents.entries)
      ? Object.values(config.agents.entries)
      : []),
  ];
  for (const agent of agentRecords) {
    if (!agent || typeof agent !== 'object' || Array.isArray(agent)) continue;
    if (agent.model !== undefined) agent.model = normalizeSelection(agent.model);
  }
  return changed;
}
