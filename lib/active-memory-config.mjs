function cloneJson(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : {};
}

export function hardenActiveMemoryConfigForBridge(openclawConfig) {
  const next = cloneJson(openclawConfig);
  const entry = next.plugins?.entries?.['active-memory'];
  if (!entry || typeof entry !== 'object') return { config: next, changed: false };
  const before = JSON.stringify(next);
  if (!entry.config || typeof entry.config !== 'object' || Array.isArray(entry.config)) entry.config = {};
  const cfg = entry.config;
  delete cfg.modelFallbackPolicy;
  cfg.agents = ['main'];
  cfg.allowedChatTypes = ['direct'];
  cfg.queryMode = 'message';
  cfg.promptStyle = cfg.promptStyle || 'balanced';
  cfg.timeoutMs = Math.min(Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : 5000, 5000);
  cfg.maxSummaryChars = Math.min(Number(cfg.maxSummaryChars) > 0 ? Number(cfg.maxSummaryChars) : 220, 220);
  cfg.persistTranscripts = false;
  cfg.thinking = 'off';
  cfg.logging = false;
  return { config: next, changed: JSON.stringify(next) !== before };
}
