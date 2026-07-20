import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived signed tokens that let the browser fetch file/media bytes
 * DIRECTLY from this bridge (`GET /files/*?fat=<token>`) instead of proxying
 * every byte through the Railway control plane.
 *
 * Key derivation: HMAC(bridgeAuthToken, 'trooper-file-access'). Both sides
 * already hold the bridge token, so no new secret needs distributing; rotating
 * the bridge token rotates these tokens with it. The mint side lives in
 * Trooper server/lib/direct-file-token.js — keep the algorithm identical
 * (golden-vector tests exist in both repos).
 */

export const DIRECT_FILE_AUDIENCE = 'trooper-direct-files';
export const DEFAULT_DIRECT_FILE_TTL_MS = 5 * 60 * 1000;

export function deriveFileAccessSecret(bridgeAuthToken) {
  const token = String(bridgeAuthToken || '').trim();
  if (!token) return null;
  return createHmac('sha256', token).update('trooper-file-access').digest('hex');
}

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function signatureFor(encodedPayload, secret) {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

export function createDirectFileAccessToken({
  bridgeAuthToken,
  orgId,
  userId,
  pathPrefix = null,
  now = Date.now(),
  ttlMs = DEFAULT_DIRECT_FILE_TTL_MS,
} = {}) {
  const secret = deriveFileAccessSecret(bridgeAuthToken);
  if (!secret) {
    const error = new Error('Direct file access signing requires the bridge auth token');
    error.code = 'direct_file_signing_unavailable';
    error.statusCode = 503;
    throw error;
  }
  if (!orgId || !userId) {
    const error = new Error('orgId and userId are required');
    error.code = 'invalid_direct_file_subject';
    error.statusCode = 400;
    throw error;
  }
  const payload = {
    aud: DIRECT_FILE_AUDIENCE,
    orgId: String(orgId),
    userId: String(userId),
    ...(pathPrefix ? { pathPrefix: String(pathPrefix) } : {}),
    issuedAt: now,
    expiresAt: now + Math.max(30_000, Number(ttlMs) || DEFAULT_DIRECT_FILE_TTL_MS),
  };
  const encodedPayload = encode(JSON.stringify(payload));
  return {
    token: `${encodedPayload}.${signatureFor(encodedPayload, secret)}`,
    expiresAt: payload.expiresAt,
  };
}

export function verifyDirectFileAccessToken(token, {
  bridgeAuthToken,
  path = null,
  now = Date.now(),
} = {}) {
  const secret = deriveFileAccessSecret(bridgeAuthToken);
  if (!secret || !token) return null;
  const [encodedPayload, providedSignature, extra] = String(token).split('.');
  if (!encodedPayload || !providedSignature || extra) return null;
  const expectedSignature = signatureFor(encodedPayload, secret);
  const expectedBuffer = Buffer.from(expectedSignature);
  const providedBuffer = Buffer.from(providedSignature);
  if (expectedBuffer.length !== providedBuffer.length || !timingSafeEqual(expectedBuffer, providedBuffer)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    if (payload.aud !== DIRECT_FILE_AUDIENCE) return null;
    if (!payload.userId || !Number.isFinite(payload.expiresAt) || payload.expiresAt <= now) return null;
    if (payload.pathPrefix && path != null && !String(path).startsWith(payload.pathPrefix)) return null;
    return payload;
  } catch {
    return null;
  }
}
