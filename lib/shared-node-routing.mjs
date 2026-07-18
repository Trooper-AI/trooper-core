function parsePathname(suffix = '') {
  try {
    return new URL(suffix || '/', 'http://slot.local').pathname || '/';
  } catch {
    return String(suffix || '/').split('?')[0] || '/';
  }
}

export function extractBearerToken(headers = {}) {
  const raw = String(headers.authorization || headers.Authorization || '').trim();
  if (!raw) return '';
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] || '').trim() : '';
}

export function hasManagerAuthHeaders(headers = {}, authToken = '') {
  if (!authToken) return false;
  return extractBearerToken(headers) === String(authToken || '').trim();
}

/**
 * Tokens that grant access only to this slot (never cross-slot).
 */
export function listSlotScopedTokens(slot = {}) {
  const tokens = [
    slot.bridgeAuthToken,
    slot.slotAuthToken,
    slot.slotBridgeAuthToken,
    // Gateway token is also per-slot; allow for proxy bootstrap probes.
    slot.gatewayToken,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return [...new Set(tokens)];
}

/**
 * Authorize access to a specific workspace slot.
 *
 * - managerAuthToken: host-wide control plane token (all slots)
 * - slot tokens: only valid for THIS slot's bridge/gateway secrets
 *
 * requireManager=true for start/stop/pause/list-all (never slot-token).
 */
export function authorizeSlotAccess({
  headers = {},
  managerAuthToken = '',
  slot = null,
  requireManager = false,
} = {}) {
  const presented = extractBearerToken(headers);
  if (!presented) {
    return { ok: false, reason: 'missing_token', role: null };
  }

  const manager = String(managerAuthToken || '').trim();
  if (manager && presented === manager) {
    return { ok: true, reason: 'manager', role: 'manager' };
  }

  if (requireManager) {
    return { ok: false, reason: 'manager_required', role: null };
  }

  if (!slot || typeof slot !== 'object') {
    return { ok: false, reason: 'invalid_token', role: null };
  }

  const slotTokens = listSlotScopedTokens(slot);
  if (slotTokens.includes(presented)) {
    return { ok: true, reason: 'slot', role: 'slot' };
  }

  // Explicitly not a manager token and not this slot — could be another slot's token.
  return { ok: false, reason: 'cross_slot_or_invalid', role: null };
}

export function isBridgeCandidatePath(suffix = '') {
  const pathname = parsePathname(suffix);
  if (pathname === '/health' || pathname === '/healthz' || pathname === '/readyz') return true;
  if (pathname === '/stats' || pathname === '/system-stats' || pathname === '/ws') return true;
  if (/^\/(admin|webhook|agents|recording|llm|debug|files|skills|gateway|config|cron|logs|version|upgrade)(\/|$)/.test(pathname)) return true;
  if (pathname === '/api/memories' || pathname.startsWith('/api/memories/')) return true;
  if (/^\/api\/organizations\/[^/]+\/memory(\/|$)/.test(pathname)) return true;
  return false;
}

export function isPublicBridgeRuntimePath(suffix = '') {
  const pathname = parsePathname(suffix);
  return pathname === '/health' || pathname === '/healthz' || pathname === '/readyz';
}

/**
 * Resolve where a proxy path should land and whether the caller is authorized.
 *
 * Auth rules for bridge candidate paths (non-public):
 *   - manager token OR this slot's bridge/gateway token
 *   - never another slot's token (checked by only matching THIS slot's secrets)
 *
 * Gateway paths stay on the gateway port; OpenClaw still applies its own token auth.
 */
export function resolveProxyTarget({
  slot,
  suffix,
  headers = {},
  authToken = '',
  managerAuthToken = '',
} = {}) {
  const manager = String(managerAuthToken || authToken || '').trim();
  const bridgeCandidate = isBridgeCandidatePath(suffix);
  const publicBridgePath = isPublicBridgeRuntimePath(suffix);

  if (bridgeCandidate && !publicBridgePath) {
    const auth = authorizeSlotAccess({
      headers,
      managerAuthToken: manager,
      slot,
      requireManager: false,
    });
    if (!auth.ok) {
      return { error: 'unauthorized', reason: auth.reason };
    }
    return {
      routeToBridge: true,
      targetPort: slot.ports.bridge,
      authRole: auth.role,
    };
  }

  // Public health + gateway paths
  if (bridgeCandidate && publicBridgePath) {
    return {
      routeToBridge: true,
      targetPort: slot.ports.bridge,
      authRole: 'public',
    };
  }

  return {
    routeToBridge: false,
    targetPort: slot.ports.gateway,
    authRole: 'gateway',
  };
}
