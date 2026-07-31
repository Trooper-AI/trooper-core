/**
 * Negotiated gateway capabilities from the connect handshake.
 *
 * The gateway's hello-ok reply advertises `features: {methods, events}` —
 * the authoritative list of what this gateway build supports. The bridge
 * historically ignored it and discovered capabilities by regex-matching
 * error strings and retrying method-name permutations. This module parses
 * the handshake once so callers can ask before probing.
 *
 * Zero-regression rule: advertised features may under-report (scope-gated
 * or lazily-registered methods), so consumers ORDER their candidates by
 * advertised support — they never drop a candidate. When no handshake data
 * is available (older gateways), every query returns null/unchanged and
 * behavior is identical to the probe-only past.
 */

export const GATEWAY_FEATURES_SCHEMA_VERSION = 1;

function toStringSet(value) {
  if (!value) return new Set();
  const items = Array.isArray(value) ? value : (typeof value === 'object' ? Object.keys(value) : []);
  return new Set(items.map((item) => String(item || '').trim()).filter(Boolean));
}

export function parseGatewayFeatures(connectResult, { now = Date.now } = {}) {
  const features = connectResult?.features;
  if (!features || typeof features !== 'object') return null;
  const methods = toStringSet(features.methods);
  const events = toStringSet(features.events);
  if (!methods.size && !events.size) return null;
  return Object.freeze({
    schemaVersion: GATEWAY_FEATURES_SCHEMA_VERSION,
    methods,
    events,
    raw: features,
    receivedAt: now(),
  });
}

/** true | false | null — null means "no handshake data, don't infer". */
export function hasGatewayMethod(features, method) {
  if (!features?.methods?.size) return null;
  return features.methods.has(String(method || ''));
}

export function hasGatewayEvent(features, event) {
  if (!features?.events?.size) return null;
  return features.events.has(String(event || ''));
}

/**
 * Supported-first ordering of method candidates. Never removes a candidate:
 * with handshake data, unsupported names sink to the end as fallback; with
 * none, the caller's order is returned unchanged.
 */
export function orderMethodCandidates(features, candidates = []) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
  if (!features?.methods?.size) return list;
  const supported = list.filter((method) => features.methods.has(method));
  const unknown = list.filter((method) => !features.methods.has(method));
  return [...supported, ...unknown];
}

/** JSON-safe summary for the /capabilities payloads. */
export function summarizeGatewayFeatures(features) {
  if (!features) return null;
  return {
    schemaVersion: features.schemaVersion,
    methods: [...features.methods].sort(),
    events: [...features.events].sort(),
    receivedAt: features.receivedAt,
  };
}
