// Single source for the OpenClaw container startup script.
//
// `startup.sh` existed in three places that had already drifted:
//   1. this repo's startup.sh, baked into the image — the correct one
//   2. a heredoc in setup-openclaw-full.sh, written at provision time
//   3. a template literal inside index.mjs's ensureOpenClawStartupScript(), used by the runtime
//      "repair" path
//
// Copy 3 was the stalest: it was missing the ACPX bootstrap fallback, the persistent CLI-home
// symlinks, and the fast permission pass. So a repair — triggered on boot, on admin restart, and
// on patch-auth — silently *downgraded* a correct file.
//
// The repair path now reads copy 1 instead of carrying its own. The important property is the
// refusal: if the canonical script cannot be found or looks truncated, the repair does nothing
// rather than writing something worse than what is already on disk.
//
// fs is injected so resolution and the refusal can be tested without touching a real filesystem.

import { existsSync as fsExistsSync, readFileSync as fsReadFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The bridge runs from a git clone (/opt/openclaw-bridge/index.mjs), so the canonical script sits
// beside it. The absolute path is a fallback for callers running from elsewhere.
export function canonicalStartupScriptCandidates(moduleDir) {
  const bridgeRoot = dirname(moduleDir);
  return [
    join(bridgeRoot, 'startup.sh'),
    '/opt/openclaw-bridge/startup.sh',
  ];
}

// A correct startup.sh is ~127 lines. Anything much shorter is a truncated or partial file, and
// writing it over a working one would break the container on next boot.
export const MIN_PLAUSIBLE_LENGTH = 400;

// Markers that must be present. These are precisely the features copy 3 lacked, so their absence
// means we are about to write the stale variant this module exists to eliminate.
export const REQUIRED_MARKERS = Object.freeze([
  'GATEWAY_PORT',
  'node dist/index.js gateway',
]);

export function isPlausibleStartupScript(text) {
  if (typeof text !== 'string' || text.length < MIN_PLAUSIBLE_LENGTH) return false;
  if (!text.startsWith('#!')) return false;
  return REQUIRED_MARKERS.every((marker) => text.includes(marker));
}

// Returns `{path, text}` for the canonical script, or null when none is usable. Callers must
// treat null as "do not write".
export function readCanonicalStartupScript({
  moduleDir = dirname(fileURLToPath(import.meta.url)),
  existsSync = fsExistsSync,
  readFileSync = fsReadFileSync,
} = {}) {
  for (const path of canonicalStartupScriptCandidates(moduleDir)) {
    try {
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      if (!isPlausibleStartupScript(text)) continue;
      return { path, text };
    } catch {
      // Try the next candidate; an unreadable path is not fatal on its own.
    }
  }
  return null;
}
