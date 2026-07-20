import path from 'path';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';

/**
 * Control-plane-pushed runtime env overrides (bridge-token-auth'd
 * POST /config/runtime-env). Lets Railway backfill non-secret configuration
 * onto the existing fleet without an upgrade or systemd env-file surgery.
 *
 * STRICTLY allowlisted — this must never become a generic remote env writer.
 * Values are persisted, applied to process.env immediately, and re-applied
 * at boot before dependent subsystems initialize.
 */

export const RUNTIME_ENV_ALLOWLIST = Object.freeze([
  // Public Firebase project id: enables ID-token verification for direct
  // browser→bridge connections. Not a secret.
  'FIREBASE_PROJECT_ID',
]);

export const DEFAULT_RUNTIME_ENV_OVERRIDES_PATH = '/opt/openclaw-data/runtime-env-overrides.json';

export function runtimeEnvOverridesPath(env = process.env) {
  return env.TROOPER_RUNTIME_ENV_OVERRIDES_PATH
    || (existsSync('/opt/openclaw-data')
      ? DEFAULT_RUNTIME_ENV_OVERRIDES_PATH
      : path.resolve('data/runtime-env-overrides.json'));
}

export function readRuntimeEnvOverrides(statePath = runtimeEnvOverridesPath()) {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    if (!parsed || typeof parsed.values !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed.values).filter(([key]) => RUNTIME_ENV_ALLOWLIST.includes(key)),
    );
  } catch {
    return {};
  }
}

/**
 * Persist allowlisted overrides and apply them to process.env.
 * @returns {{ applied: string[], rejected: string[] }}
 */
export function applyRuntimeEnvOverrides(values = {}, {
  statePath = runtimeEnvOverridesPath(),
  env = process.env,
} = {}) {
  const applied = [];
  const rejected = [];
  const current = readRuntimeEnvOverrides(statePath);
  for (const [key, value] of Object.entries(values || {})) {
    if (!RUNTIME_ENV_ALLOWLIST.includes(key) || typeof value !== 'string' || value.length > 200) {
      rejected.push(key);
      continue;
    }
    current[key] = value.trim();
    applied.push(key);
  }
  if (applied.length) {
    const directory = path.dirname(statePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ values: current, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    renameSync(temporaryPath, statePath);
    for (const key of applied) {
      if (!env[key]) env[key] = current[key];
    }
  }
  return { applied, rejected };
}

/** Boot hook: load persisted overrides into process.env (never overwrites real env). */
export function loadRuntimeEnvOverridesAtBoot({
  statePath = runtimeEnvOverridesPath(),
  env = process.env,
} = {}) {
  const overrides = readRuntimeEnvOverrides(statePath);
  for (const [key, value] of Object.entries(overrides)) {
    if (!env[key]) env[key] = value;
  }
  return Object.keys(overrides);
}
