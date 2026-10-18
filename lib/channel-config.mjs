function cloneJson(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : {};
}

function normalizeOptionalSecret(value) {
  if (value === undefined) return undefined;
  if (value === null) return '';
  let normalized = String(value).replace(/^\uFEFF/, '').trim();
  const firstLine = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  normalized = firstLine || '';
  let changed = true;
  while (changed && normalized) {
    const next = normalized
      .replace(/^['"`]+|['"`]+$/g, '')
      .replace(/^TELEGRAM_BOT_TOKEN\s*=\s*/i, '')
      .replace(/^telegram(?:Bot)?Token\s*[:=]\s*/i, '')
      .trim();
    changed = next !== normalized;
    normalized = next;
  }
  return normalized;
}

export function extractTelegramTokenFromPayload(payload = {}) {
  if (payload.telegramToken !== undefined) return normalizeOptionalSecret(payload.telegramToken);
  if (payload.telegramBotToken !== undefined) return normalizeOptionalSecret(payload.telegramBotToken);
  return undefined;
}

export function buildTelegramEnvUpdates(payload = {}) {
  const token = extractTelegramTokenFromPayload(payload);
  if (token === undefined) return {};
  return { TELEGRAM_BOT_TOKEN: token };
}

export function applyTelegramTokenToOpenClawConfig(openclawConfig, tokenValue) {
  if (tokenValue === undefined) {
    return { config: cloneJson(openclawConfig), changed: false, configured: false };
  }
  const next = cloneJson(openclawConfig);
  const before = JSON.stringify(next);
  if (!next.channels || typeof next.channels !== 'object' || Array.isArray(next.channels)) next.channels = {};
  const existingTelegram = next.channels.telegram && typeof next.channels.telegram === 'object' && !Array.isArray(next.channels.telegram)
    ? next.channels.telegram
    : {};
  const token = normalizeOptionalSecret(tokenValue);
  const telegram = { ...existingTelegram };
  // OpenClaw 2026.7 rejects channels.telegram.mode. Polling is the default.
  delete telegram.mode;
  if (token) {
    telegram.botToken = token;
    telegram.enabled = true;
    const allowFrom = Array.isArray(telegram.allowFrom)
      ? telegram.allowFrom.map((entry) => String(entry || '').trim()).filter(Boolean)
      : [];
    if (!telegram.dmPolicy) {
      telegram.dmPolicy = allowFrom.length > 0 ? 'allowlist' : 'open';
    }
    telegram.allowFrom = allowFrom.length > 0 ? allowFrom : ['*'];
  } else {
    delete telegram.botToken;
    telegram.enabled = false;
  }
  next.channels.telegram = telegram;
  if (token) allowTelegramPlugin(next);
  return { config: next, changed: JSON.stringify(next) !== before, configured: Boolean(token) };
}

// plugins.allow is exclusive. A list that names other plugins and omits
// "telegram" keeps the bundled channel from loading, so the bot never replies
// and the Channels page stays "not configured". Only append when a list
// already exists — creating one would hide every other plugin.
function allowTelegramPlugin(config) {
  if (!config.plugins || typeof config.plugins !== 'object' || Array.isArray(config.plugins)) {
    config.plugins = {};
  }
  if (!config.plugins.entries || typeof config.plugins.entries !== 'object' || Array.isArray(config.plugins.entries)) {
    config.plugins.entries = {};
  }
  const existing = config.plugins.entries.telegram;
  const entry = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  entry.enabled = true;
  config.plugins.entries.telegram = entry;
  if (Array.isArray(config.plugins.allow) && !config.plugins.allow.includes('telegram')) {
    config.plugins.allow.push('telegram');
  }
  if (Array.isArray(config.plugins.deny)) {
    config.plugins.deny = config.plugins.deny.filter((pluginId) => pluginId !== 'telegram');
  }
}

// Gateway start: a token already in the env or the config must still allowlist
// the plugin. A later config rewrite that only touches agents.list otherwise
// leaves Flower silent.
export function ensureTelegramChannelReady(openclawConfig, { envToken = '' } = {}) {
  const next = cloneJson(openclawConfig);
  const configuredToken = String(next.channels?.telegram?.botToken || '').trim();
  const fromEnv = normalizeOptionalSecret(envToken);
  if (!configuredToken && fromEnv) {
    return applyTelegramTokenToOpenClawConfig(next, fromEnv);
  }
  if (!configuredToken || next.channels?.telegram?.enabled === false) {
    return { config: next, changed: false, configured: false };
  }
  const before = JSON.stringify(next);
  allowTelegramPlugin(next);
  return {
    config: next,
    changed: JSON.stringify(next) !== before,
    configured: true,
  };
}
