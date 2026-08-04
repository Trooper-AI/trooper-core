/**
 * ACP spawn host / bind policy for Trooper ↔ OpenClaw.
 *
 * Trooper channel chat runs on OpenClaw hook/webchat sessions
 * (`agent:…:hook:trooper:…`, Trooper Bridge). OpenClaw rejects conversation
 * bindings there ("Conversation bindings are unavailable for webchat"), so
 * `--bind here` cannot be the default for Trooper-hosted spawns.
 *
 * Child observation for `--bind off` comes from history polling plus the
 * trooper-acp-event-relay gateway plugin — not from conversation bindings.
 */

export function acpParentSessionKey(channel = 'general') {
  const slug = String(channel || 'general')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'general';
  return `agent:main:hook:trooper:acp:channel:${slug}`;
}

export function isConversationBindCapableSession(sessionKey = '') {
  const key = String(sessionKey || '').trim().toLowerCase();
  if (!key) return false;
  // Trooper's OpenClaw hosts are hook sessions surfaced as webchat.
  if (key.includes(':hook:trooper:')) return false;
  if (/\bwebchat\b/.test(key)) return false;
  // Bare main / Control UI sessions also reject conversation bindings.
  if (key === 'main' || key === 'agent:main' || /^agent:main:(main|webchat)\b/.test(key)) {
    return false;
  }
  return true;
}

/**
 * Prefer a bind-capable parent when the caller supplies one; otherwise host
 * ACP slash-commands on Trooper's dedicated per-channel ACP control session.
 * Never keep channel chat / Trooper Bridge keys as the ACP control host.
 */
export function resolveAcpControlSessionKey({
  requestedParentSessionKey = '',
  channel = 'general',
} = {}) {
  const requested = String(requestedParentSessionKey || '').trim();
  if (requested && isConversationBindCapableSession(requested)) {
    return requested;
  }
  return acpParentSessionKey(channel);
}

export function resolveAcpSpawnBindMode(controlSessionKey = '') {
  return isConversationBindCapableSession(controlSessionKey) ? 'here' : 'off';
}

export function isAcpConversationBindingsUnavailableError(text = '') {
  return /conversation bindings are unavailable/i.test(String(text || ''));
}
