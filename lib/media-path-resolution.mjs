import path from 'node:path';

/**
 * OpenClaw reports generated media with its in-container path
 * (/home/node/.openclaw/media/...). Trooper's bridge can read the same files
 * directly from the host-mounted config/data media roots. Prefer that host
 * file when it exists so transcript `MEDIA:` references do not make the
 * bridge ask the container for a file that only exists on the host mount.
 */
export function resolveHostMediaAlias({
  requestedPath,
  mediaContainerRoot,
  mediaHostRoots = [],
  exists = () => false,
} = {}) {
  const containerRoot = path.resolve(String(mediaContainerRoot || ''));
  const rawPath = String(requestedPath || '').trim();
  if (!containerRoot || !rawPath) return null;

  const prefix = `${containerRoot}${path.sep}`;
  if (!rawPath.startsWith(prefix)) return null;
  const relativePath = rawPath.slice(prefix.length);
  if (!relativePath) return null;

  for (const rawRoot of mediaHostRoots) {
    const hostRoot = path.resolve(String(rawRoot || ''));
    if (!hostRoot) continue;
    const candidate = path.resolve(hostRoot, relativePath);
    // A transcript path must never be able to escape the configured media root.
    if (!candidate.startsWith(`${hostRoot}${path.sep}`)) continue;
    if (exists(candidate)) return candidate;
  }
  return null;
}
