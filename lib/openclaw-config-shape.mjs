function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

/** Read OpenClaw agent records from either the retired list or current keyed entries. */
export function getOpenClawAgentList(config) {
  const agents = isRecord(config?.agents) ? config.agents : {};
  const merged = new Map();

  if (isRecord(agents.entries)) {
    for (const [rawId, entry] of Object.entries(agents.entries)) {
      const id = String(rawId || '').trim();
      if (!id || !isRecord(entry)) continue;
      merged.set(id, { ...entry, id });
    }
  }

  if (Array.isArray(agents.list)) {
    for (const entry of agents.list) {
      const id = String(entry?.id || '').trim();
      if (!id || !isRecord(entry)) continue;
      merged.set(id, { ...(merged.get(id) || {}), ...entry, id });
    }
  }

  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Provide the old in-memory list to bridge code while retaining disk compatibility. */
export function hydrateOpenClawAgentList(config) {
  if (!isRecord(config)) return config;
  const agents = isRecord(config.agents) ? config.agents : null;
  if (!agents) return config;
  agents.list = getOpenClawAgentList(config);
  return config;
}

/** Persist agent records in the OpenClaw 2026.11 keyed schema. */
export function migrateOpenClawAgentRoster(config) {
  const agents = config?.agents;
  if (!isRecord(agents)) return false;

  const entries = {};
  for (const agent of getOpenClawAgentList(config)) {
    const { id, ...settings } = agent;
    entries[id] = settings;
  }

  const changed = Object.hasOwn(agents, 'list')
    || !isRecord(agents.entries)
    || JSON.stringify(agents.entries) !== JSON.stringify(entries);
  if (!changed) return false;

  agents.entries = entries;
  delete agents.list;
  return true;
}

/** Move retired generation model fields into OpenClaw 2026.11 mediaModels slots. */
export function migrateOpenClawMediaModels(config) {
  const defaults = config?.agents?.defaults;
  if (!isRecord(defaults)) return false;

  const legacyToSlot = {
    imageGenerationModel: 'image',
    videoGenerationModel: 'video',
    musicGenerationModel: 'music',
  };
  const mediaModels = isRecord(defaults.mediaModels) ? { ...defaults.mediaModels } : {};
  let changed = false;

  for (const [legacyKey, slot] of Object.entries(legacyToSlot)) {
    if (!Object.hasOwn(defaults, legacyKey)) continue;
    if (!Object.hasOwn(mediaModels, slot)) mediaModels[slot] = defaults[legacyKey];
    delete defaults[legacyKey];
    changed = true;
  }

  if (changed) {
    if (Object.keys(mediaModels).length) defaults.mediaModels = mediaModels;
    else delete defaults.mediaModels;
  }
  return changed;
}
