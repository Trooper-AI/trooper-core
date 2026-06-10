function parsePathname(suffix = '') {
  try {
    return new URL(suffix || '/', 'http://slot.local').pathname || '/';
  } catch {
    return String(suffix || '/').split('?')[0] || '/';
  }
}

export function hasManagerAuthHeaders(headers = {}, authToken = '') {
  if (!authToken) return false;
  return String(headers.authorization || headers.Authorization || '') === `Bearer ${authToken}`;
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

export function resolveProxyTarget({ slot, suffix, headers = {}, authToken = '' }) {
  const bridgeCandidate = isBridgeCandidatePath(suffix);
  const authed = hasManagerAuthHeaders(headers, authToken);
  const publicBridgePath = isPublicBridgeRuntimePath(suffix);
  if (bridgeCandidate && !authed && !publicBridgePath) {
    return { error: 'unauthorized' };
  }
  const routeToBridge = bridgeCandidate && (authed || publicBridgePath);
  return {
    routeToBridge,
    targetPort: routeToBridge ? slot.ports.bridge : slot.ports.gateway,
  };
}
