const DEFAULT_ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/(?:[a-z0-9-]+\.)*trooper\.so$/i,
  /^https:\/\/(?:[a-z0-9-]+\.)*crabhq\.com$/i,
  /^https:\/\/(?:[a-z0-9-]+\.)*trooper\.com$/i,
  /^https?:\/\/localhost(?::\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i,
  // Trooper desktop (Tauri) webview origins — required for Server Console / local bridge fetch
  /^tauri:\/\/localhost$/i,
  /^https?:\/\/tauri\.localhost(?::\d+)?$/i,
  /^asset:\/\/localhost$/i,
  /^https?:\/\/asset\.localhost(?::\d+)?$/i,
];

function normalizeOrigin(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  // tauri:// and custom schemes: URL.origin is reliable in modern Node; fall back to raw.
  try {
    const url = new URL(text);
    if (url.origin && url.origin !== 'null') return url.origin;
  } catch {
    // ignore
  }
  // e.g. tauri://localhost (some environments reject custom-scheme origin equality checks)
  if (/^tauri:\/\/localhost\/?$/i.test(text)) return 'tauri://localhost';
  if (/^asset:\/\/localhost\/?$/i.test(text)) return 'asset://localhost';
  return '';
}

export function parseExplicitCorsOrigins(value = '') {
  return new Set(
    String(value || '')
      .split(',')
      .map(normalizeOrigin)
      .filter(Boolean),
  );
}

export function isAllowedCorsOrigin(
  origin,
  explicitOrigins = process.env.BRIDGE_CORS_ALLOWED_ORIGINS || '',
) {
  if (!origin) return true;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  if (parseExplicitCorsOrigins(explicitOrigins).has(normalized)) return true;
  return DEFAULT_ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(normalized));
}
