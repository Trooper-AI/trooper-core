/**
 * Bridge auth evaluation — fail closed when no token is configured.
 *
 * Historically an unset BRIDGE_AUTH_TOKEN made every non-exempt route
 * (admin, gateway, config, debug, webhooks) pass through unauthenticated,
 * while shared-node-manager.mjs correctly refused with a 503 in the same
 * situation. This module is the single evaluator both the global middleware
 * and the per-route requireBridgeAuth helper consume, mirroring the
 * shared-node-manager response contract: 503 {error, message} when auth is
 * not configured, 401 on a missing/invalid token. Local development opts
 * back into the old permissive behavior explicitly with
 * BRIDGE_ALLOW_UNAUTHENTICATED_DEV=1 — loud opt-in instead of silent
 * fail-open.
 */

export const BRIDGE_AUTH_UNCONFIGURED_ERROR = 'bridge_auth_not_configured';

export function evaluateBridgeAuth({
  configuredToken = '',
  authorizationHeader = '',
  allowUnauthenticatedDev = false,
} = {}) {
  const token = String(configuredToken || '').trim();
  if (!token) {
    if (allowUnauthenticatedDev) return { ok: true, mode: 'unauthenticated_dev' };
    return {
      ok: false,
      status: 503,
      body: {
        error: BRIDGE_AUTH_UNCONFIGURED_ERROR,
        message: 'Bridge authorization is not configured. Set BRIDGE_AUTH_TOKEN, or set BRIDGE_ALLOW_UNAUTHENTICATED_DEV=1 for local development.',
      },
    };
  }
  const header = String(authorizationHeader || '');
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  if (presented !== token) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'unauthorized',
        message: 'Missing or invalid bridge auth token',
      },
    };
  }
  return { ok: true, mode: 'token' };
}
