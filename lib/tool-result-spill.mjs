/**
 * Tool-result spill.
 *
 * The `raw` field of a tool_result payload is the one unbounded string in the
 * event pipeline: a big `exec`/`read`/fetch result is persisted verbatim into
 * run_events.data AND messages.tool_events / task comment toolEvents. This
 * module externalizes oversized raw text at the persistence point: the full
 * body goes to a private spill file and the persisted payload keeps a locator
 * plus a first/last excerpt, so the UI still gets something readable and the
 * database stays bounded.
 *
 * Best-effort by contract: if the spill write fails for ANY reason the caller
 * keeps the full inline text — losing data is worse than storing it fat.
 *
 * Env:
 *   TROOPER_SPILL            '1' (default on) — '0' disables spilling.
 *   TROOPER_SPILL_THRESHOLD  byte threshold (default 262144 = 256KB).
 *   TROOPER_SPILL_DIR        override spill directory (default: the data dir
 *                            next to the SQLite DB, /opt/openclaw-data on a
 *                            provisioned host, ./data locally).
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import path from 'path';

export const DEFAULT_SPILL_THRESHOLD_BYTES = 256 * 1024;
export const SPILL_EXCERPT_BYTES = 2048;

/** Resolve env-driven settings once; callers may pass explicit settings in tests. */
export function resolveSpillSettings(env = process.env) {
  const raw = String(env?.TROOPER_SPILL ?? '1').trim().toLowerCase();
  const enabled = !(raw === '0' || raw === 'off' || raw === 'false');
  const parsed = Number(env?.TROOPER_SPILL_THRESHOLD);
  const thresholdBytes = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_SPILL_THRESHOLD_BYTES;
  const dir = String(env?.TROOPER_SPILL_DIR || '').trim()
    // Mirror db/index.mjs's data-dir choice: the Hetzner volume when present,
    // ./data for local dev.
    || (existsSync('/opt/openclaw-data') ? '/opt/openclaw-data/tool-result-spill' : './data/tool-result-spill');
  return { enabled, thresholdBytes, dir };
}

/** Write the full text to a private file (0700 dir, 0600 file, random name). */
export function spillToolResultText(text, { dir, name = null } = {}) {
  if (!dir) throw new Error('spillToolResultText requires a dir');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fileName = name || `spill-${Date.now()}-${randomBytes(6).toString('hex')}.txt`;
  const filePath = path.join(dir, fileName);
  writeFileSync(filePath, text, { mode: 0o600, flag: 'wx' }); // wx: random name must not exist
  return { path: filePath, byteLength: Buffer.byteLength(text) };
}

/** First/last excerpt with an explicit truncation marker naming the locator. */
export function buildSpillExcerptText(text, { path: filePath, byteLength, excerptBytes = SPILL_EXCERPT_BYTES } = {}) {
  const buffer = Buffer.from(text);
  const head = buffer.subarray(0, excerptBytes).toString('utf8');
  const tail = buffer.subarray(Math.max(excerptBytes, buffer.length - excerptBytes)).toString('utf8');
  return `${head}\n…[tool result truncated: ${byteLength} bytes total; full text spilled to ${filePath}]…\n${tail}`;
}

let cachedDefaultSettings = null;

/**
 * Spill `text` when it crosses the threshold. Returns:
 *   { spilled: false, text }                              — inline, unchanged
 *   { spilled: true, text: excerpt, locator: {...} }       — externalized
 * Never throws; any failure falls back to the inline full text.
 */
export function maybeSpillToolResultText(text, settings = null) {
  if (typeof text !== 'string') return { spilled: false, text };
  try {
    const resolved = settings || (cachedDefaultSettings ||= resolveSpillSettings());
    if (!resolved.enabled) return { spilled: false, text };
    const byteLength = Buffer.byteLength(text);
    if (byteLength <= resolved.thresholdBytes) return { spilled: false, text };

    const { path: filePath } = spillToolResultText(text, { dir: resolved.dir });
    const excerpt = buildSpillExcerptText(text, { path: filePath, byteLength });
    return {
      spilled: true,
      text: excerpt,
      locator: {
        spilled: true,
        path: filePath,
        byteLength,
        excerptBytes: SPILL_EXCERPT_BYTES,
      },
    };
  } catch (err) {
    // Best effort: keep the full inline text rather than lose it.
    try { console.warn(`[tool-result-spill] spill failed — keeping full text inline: ${err?.message || err}`); } catch { /* ignore */ }
    return { spilled: false, text };
  }
}

/** Test hook: forget the memoized env settings. */
export function resetSpillSettingsCache() {
  cachedDefaultSettings = null;
}
