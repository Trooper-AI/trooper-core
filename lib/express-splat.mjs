/**
 * Express 5 named wildcards (`/files/{*filePath}`) populate `req.params.filePath`
 * as an ARRAY of path segments. `String(array)` joins with commas, so
 * `/files/opt/openclaw-data/workspace/x.png` becomes the nonsense path
 * `/opt,openclaw-data,workspace,x.png` and 404s.
 *
 * Always join splat params with `/` before using them as a filesystem path.
 */
export function joinExpressSplat(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join('/');
  return String(value || '');
}

/** Absolute path from an Express 5 `{*param}` capture (`/a/b`). */
export function requestSplatPath(params, key) {
  const raw = params?.[key] ?? params?.[0];
  const joined = joinExpressSplat(raw);
  if (!joined) return '/';
  return joined.startsWith('/') ? joined : `/${joined}`;
}
