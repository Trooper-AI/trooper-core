/**
 * Bulk session-status filtering for the control plane's reconcilers.
 *
 * The single-session GET /api/session-status answers one key per request;
 * a reconciler tracking dozens of sub-agent sessions needs one
 * sessions.list call filtered to the keys it cares about, not N requests.
 * The filter is pure so it is testable without a gateway.
 */

export const SESSION_STATUS_BULK_MAX_KEYS = 100;

export function parseSessionStatusKeys(raw) {
  const keys = String(raw || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
  if (!keys.length) return { ok: false, error: 'keys is required (comma-separated session keys)' };
  if (keys.length > SESSION_STATUS_BULK_MAX_KEYS) {
    return { ok: false, error: `too many keys (max ${SESSION_STATUS_BULK_MAX_KEYS})` };
  }
  return { ok: true, keys: [...new Set(keys)] };
}

export function filterSessionsByKeys(listResult, keys = []) {
  const rows = Array.isArray(listResult?.sessions) ? listResult.sessions
    : Array.isArray(listResult?.rows) ? listResult.rows
      : Array.isArray(listResult) ? listResult : [];
  const wanted = new Set(keys);
  const sessions = [];
  for (const row of rows) {
    const key = String(row?.key || row?.sessionKey || '').trim();
    if (!key || !wanted.has(key)) continue;
    sessions.push({
      key,
      status: String(row?.status || row?.state || 'unknown').toLowerCase(),
      ...(row?.runId ? { runId: row.runId } : {}),
      ...(row?.updatedAt ? { updatedAt: row.updatedAt } : {}),
    });
  }
  return sessions;
}
