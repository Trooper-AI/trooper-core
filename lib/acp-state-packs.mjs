// ACP state packs — the rule data for `acp-state-rules.mjs`, plus loading/override.
//
// Bundled packs ship with the bridge and encode what the scattered regexes knew:
// the failure buckets from `shared/acpFailure` (quota / auth / stale / turn-failed),
// the "this is a system-prompt echo, not live state" detection, and — new — the
// approval-prompt evidence that gives sessions an `awaiting_user` attention state
// the old regexes could never express (backlog OC-12).
//
// Operators can override any pack by dropping `<packId>.json` into the override
// directory (`TROOPER_ACP_STATE_PACK_DIR`, default under /opt/openclaw-data). An
// override that fails to compile is reported and IGNORED — the bundled pack keeps
// serving, because a typo in a JSON file must never take classification down.
// `reloadAcpStatePacks()` swaps the whole registry atomically; wire it to an admin
// route so packs update without a restart (herdr's manifest hot-reload).
//
// Classification always evaluates two packs: `common` (harness-independent failure
// and echo rules) and the harness pack. The higher-priority match wins; on a tie
// the harness pack wins as the more specific source.

import fs from 'node:fs';
import path from 'node:path';

import {
  ACP_STATE_RULES_ENGINE_VERSION,
  compileStatePack,
  evaluateStatePack,
  explainStatePack,
} from './acp-state-rules.mjs';

export const DEFAULT_STATE_PACK_DIR = '/opt/openclaw-data/acp-state-packs';

// ── Bundled pack data ──────────────────────────────────────────────────────────
//
// Priorities: failure rules 860–900 (matching the old "failure check runs first"
// order — a quota error inside a prompt-dump blob must classify as quota, which the
// observation tests pin); the echo skip rule sits below them at 500 so it only wins
// when no failure matched; awaiting_user evidence sits at 700–750, above the echo
// (a live approval prompt is not an echo) and below failures.

const COMMON_PACK = {
  id: 'common',
  version: '2026.08.09.1',
  minEngineVersion: 1,
  aliases: [],
  rules: [
    {
      id: 'quota_exhausted',
      state: 'failed',
      reason: 'quota_exhausted',
      priority: 900,
      region: 'text',
      regex: ['\\b(UsageLimitExceeded|Quota exceeded|usage limit|rate limit(?:ed)?|allowance exhausted)\\b'],
    },
    {
      // Port of looksLikeTruncatedStderrPrompt: ACPX packs `Internal error: <stderr
      // tail>` and the tail often starts mid-system-prompt while the quota line sits
      // at the end — an Internal error carrying prompt fragments is almost always a
      // truncated quota failure.
      id: 'truncated_stderr_quota',
      state: 'failed',
      reason: 'quota_exhausted',
      priority: 895,
      region: 'text',
      regex: ['Internal error:'],
      any: [
        { contains: ['editing constraints'] },
        { contains: ['you default to ascii'] },
        { contains: ['agents.md'] },
        { contains: ['soul.md'] },
        { contains: ['mission floor'] },
        { contains: ['available tools'] },
        { regex: ['(their|eir) browser'] },
      ],
    },
    {
      id: 'auth_required',
      state: 'failed',
      reason: 'auth_required',
      priority: 890,
      region: 'text',
      regex: ['\\bAuthentication required\\b'],
    },
    {
      id: 'session_stale',
      state: 'failed',
      reason: 'session_stale',
      priority: 880,
      region: 'text',
      regex: ['\\b(ACP_SESSION_INIT_FAILED|metadata is missing for agent:)\\b'],
    },
    {
      id: 'turn_failed',
      state: 'failed',
      reason: 'turn_failed',
      priority: 860,
      region: 'text',
      regex: ['\\b(ACP_TURN_FAILED|Unhandled error during turn)\\b'],
    },
    {
      // Port of looksLikeSystemPromptDump, as data: two distinct marker families
      // approximate the old "two hits" requirement. Matching text is a bootstrap /
      // transcript echo — classify nothing from it. Lower priority than every
      // failure rule so a real error buried in a dump still classifies.
      id: 'system_prompt_echo',
      state: 'unknown',
      skipStateUpdate: true,
      priority: 500,
      region: 'text',
      all: [
        { any: [{ contains: ['agents.md'] }, { contains: ['soul.md'] }, { contains: ['tools.md'] }, { contains: ['identity.md'] }] },
        { any: [{ regex: ['\\bYou are\\b'] }, { contains: ['always follow'] }, { contains: ['mission floor'] }, { contains: ['available tools'] }] },
      ],
    },
    {
      // If acpx ever forwards ACP permission requests as typed events, recognize
      // them regardless of harness. Harmless while it never matches.
      id: 'typed_permission_event',
      state: 'awaiting_user',
      blockerEvidence: true,
      priority: 750,
      region: 'event_type',
      regex: ['^(permission_request|approval_required|session/request_permission)$'],
    },
  ],
};

const CLAUDE_PACK = {
  id: 'claude',
  version: '2026.08.09.2',
  minEngineVersion: 1,
  aliases: ['claude-code'],
  rules: [
    {
      // Claude Code permission prompts read "Do you want to …?" AND render a
      // numbered option list ("❯ 1. Yes"). Requiring the numbered-yes line keeps
      // ordinary assistant closers ("Do you want me to proceed with deploys
      // too?") from raising a false approval — a false positive here sends a
      // wrong notification AND holds finalization, so precision beats recall.
      // Negative evidence keeps quota/auth text out entirely.
      id: 'permission_prompt',
      state: 'awaiting_user',
      reason: 'permission_prompt',
      blockerEvidence: true,
      priority: 720,
      region: 'text_tail(30)',
      contains: ['do you want'],
      lineRegex: ['^\\s*(?:❯\\s*)?\\d\\.\\s*yes\\b'],
      not: [{ regex: ['\\b(UsageLimitExceeded|usage limit|Quota exceeded)\\b'] }],
    },
    {
      id: 'explicit_permission_language',
      state: 'awaiting_user',
      reason: 'permission_prompt',
      blockerEvidence: true,
      priority: 710,
      region: 'text_tail(30)',
      any: [
        { contains: ['needs your permission'] },
        { contains: ['requested permissions'] },
        { contains: ['waiting for your approval'] },
      ],
    },
  ],
};

const CODEX_PACK = {
  id: 'codex',
  version: '2026.08.09.2',
  minEngineVersion: 1,
  aliases: [],
  rules: [
    {
      // Same precision-over-recall stance as the claude pack: the "allow …"
      // matcher is line-anchored so prose that merely mentions allowing a
      // command does not read as a live prompt.
      id: 'approval_prompt',
      state: 'awaiting_user',
      reason: 'permission_prompt',
      blockerEvidence: true,
      priority: 720,
      region: 'text_tail(30)',
      any: [
        { lineRegex: ['^\\s*allow (this )?(command|tool|action)\\b'] },
        { contains: ['approval required'] },
        { regex: ['\\[y/n\\]'] },
        { contains: ['press enter to approve'] },
      ],
      not: [{ regex: ['\\b(UsageLimitExceeded|usage limit|Quota exceeded)\\b'] }],
    },
  ],
};

const MINIMAL_PACK = (id, aliases = []) => ({
  id,
  version: '2026.08.09.1',
  minEngineVersion: 1,
  aliases,
  rules: [
    {
      id: 'generic_approval_language',
      state: 'awaiting_user',
      reason: 'permission_prompt',
      blockerEvidence: true,
      priority: 700,
      region: 'text_tail(30)',
      any: [
        { contains: ['approval required'] },
        { contains: ['waiting for your approval'] },
        { contains: ['needs your permission'] },
      ],
    },
  ],
});

export const BUNDLED_STATE_PACKS = Object.freeze([
  COMMON_PACK,
  CLAUDE_PACK,
  CODEX_PACK,
  MINIMAL_PACK('opencode'),
  MINIMAL_PACK('kimi', ['kimi-code']),
  MINIMAL_PACK('copilot'),
]);

// ── Registry ──────────────────────────────────────────────────────────────────

function compileBundledOrThrow(raw) {
  const { pack, errors } = compileStatePack(raw);
  if (!pack) {
    // A bundled pack that cannot compile is a programming error, not runtime input.
    throw new Error(`bundled state pack "${raw?.id}" failed to compile: ${errors.join('; ')}`);
  }
  return { pack, warnings: errors, source: 'bundled' };
}

function loadOverride(dir, id) {
  const file = path.join(dir, `${id}.json`);
  let rawText;
  try {
    rawText = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // no override present — the normal case
  }
  let raw;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    return { pack: null, warnings: [`override ${file} is not valid JSON: ${err.message}`], source: `override:${file}` };
  }
  if (raw?.id && raw.id !== id) {
    return { pack: null, warnings: [`override ${file} declares id "${raw.id}", expected "${id}"`], source: `override:${file}` };
  }
  const { pack, errors } = compileStatePack({ ...raw, id });
  if (!pack || pack.rules.length === 0) {
    // An override whose rules all failed to compile would otherwise "win" as an
    // empty pack and silently disable classification for its harness.
    const warnings = errors.length ? errors : ['override compiled to zero rules'];
    return { pack: null, warnings: warnings.map((e) => `override ${file}: ${e}`), source: `override:${file}` };
  }
  return { pack, warnings: errors, source: `override:${file}` };
}

function buildRegistry({ dir }) {
  const entries = new Map(); // packId -> { pack, warnings, source }
  const aliasIndex = new Map(); // alias/lowercased id -> packId
  for (const bundled of BUNDLED_STATE_PACKS) {
    const compiled = compileBundledOrThrow(bundled);
    const override = loadOverride(dir, bundled.id);
    const chosen = override?.pack
      ? override
      : override
        ? { ...compiled, warnings: [...compiled.warnings, ...override.warnings] }
        : compiled;
    entries.set(bundled.id, chosen);
    aliasIndex.set(bundled.id.toLowerCase(), bundled.id);
    for (const alias of chosen.pack.aliases) aliasIndex.set(alias, bundled.id);
  }
  return { entries, aliasIndex, dir, loadedAt: new Date().toISOString() };
}

let registry = null;

function ensureRegistry() {
  if (!registry) {
    registry = buildRegistry({ dir: process.env.TROOPER_ACP_STATE_PACK_DIR || DEFAULT_STATE_PACK_DIR });
  }
  return registry;
}

// Atomic swap: classification in flight keeps the old registry, the next call sees
// the new one. Returns the post-reload status for the admin route to echo.
export function reloadAcpStatePacks({ dir } = {}) {
  registry = buildRegistry({
    dir: dir || process.env.TROOPER_ACP_STATE_PACK_DIR || DEFAULT_STATE_PACK_DIR,
  });
  return acpStatePacksStatus();
}

export function acpStatePacksStatus() {
  const reg = ensureRegistry();
  return {
    engineVersion: ACP_STATE_RULES_ENGINE_VERSION,
    overrideDir: reg.dir,
    loadedAt: reg.loadedAt,
    packs: [...reg.entries.entries()].map(([id, entry]) => ({
      id,
      version: entry.pack.version,
      source: entry.source,
      ruleCount: entry.pack.rules.length,
      warnings: entry.warnings,
    })),
  };
}

function resolvePacks(harness) {
  const reg = ensureRegistry();
  const common = reg.entries.get('common') || null;
  const key = String(harness || '').trim().toLowerCase();
  const packId = reg.aliasIndex.get(key);
  const specific = packId && packId !== 'common' ? reg.entries.get(packId) : null;
  return { common: common?.pack ?? null, specific: specific?.pack ?? null };
}

// Classify one observation for a harness. Returns the engine's rule result (or
// null when no rule matched anywhere) — feed it to `arbitrateSessionState` along
// with the structured status.
export function classifyAcpObservation(harness, observation) {
  const { common, specific } = resolvePacks(harness);
  const fromSpecific = specific ? evaluateStatePack(specific, observation) : null;
  const fromCommon = common ? evaluateStatePack(common, observation) : null;
  if (fromSpecific && fromCommon) {
    // Harness pack wins ties: it is the more specific authority for its own CLI.
    return fromCommon.priority > fromSpecific.priority ? fromCommon : fromSpecific;
  }
  return fromSpecific || fromCommon;
}

// Full evidence trace across both packs — the payload behind
// `GET /acp/sessions/:id/explain`.
export function explainAcpObservation(harness, observation) {
  const { common, specific } = resolvePacks(harness);
  const traces = [];
  if (specific) traces.push(explainStatePack(specific, observation));
  if (common) traces.push(explainStatePack(common, observation));
  return {
    harness: String(harness || '') || null,
    result: classifyAcpObservation(harness, observation),
    packs: traces,
  };
}

// Test hook: force a clean registry so tests can point at a temp override dir.
export function resetAcpStatePacksForTest() {
  registry = null;
}
