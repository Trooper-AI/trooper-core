function parsePathname(suffix = '') {
  try {
    return new URL(suffix || '/', 'http://slot.local').pathname || '/';
  } catch {
    return String(suffix || '/').split('?')[0] || '/';
  }
}

export function hasManagerAuthHeaders(headers = {}, authToken = '') {
  if (!authToken) return true;
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

export function isBridgeOnlyPath(suffix = '') {
  const pathname = parsePathname(suffix);
  if (/^\/(admin|webhook|agents|llm|debug|gateway|config|cron|upgrade)(\/|$)/.test(pathname)) return true;
  return false;
}

export function isUserBridgeRuntimePath(suffix = '') {
  const pathname = parsePathname(suffix);
  if (pathname === '/health' || pathname === '/healthz' || pathname === '/readyz') return true;
  if (pathname === '/stats' || pathname === '/system-stats' || pathname === '/ws') return true;
  if (/^\/(recording|files|skills|logs|version)(\/|$)/.test(pathname)) return true;
  if (pathname === '/api/memories' || pathname.startsWith('/api/memories/')) return true;
  if (/^\/api\/organizations\/[^/]+\/memory(\/|$)/.test(pathname)) return true;
  return false;
}

export function resolveProxyTarget({ slot, suffix, headers = {}, authToken = '' }) {
  const bridgeCandidate = isBridgeCandidatePath(suffix);
  const authed = hasManagerAuthHeaders(headers, authToken);
  if (bridgeCandidate && !authed && isBridgeOnlyPath(suffix)) {
    return { error: 'unauthorized' };
  }
  const routeToBridge = bridgeCandidate && (authed || isUserBridgeRuntimePath(suffix));
  return {
    routeToBridge,
    targetPort: routeToBridge ? slot.ports.bridge : slot.ports.gateway,
  };
}
