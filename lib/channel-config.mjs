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
  return { config: next, changed: JSON.stringify(next) !== before, configured: Boolean(token) };
}
