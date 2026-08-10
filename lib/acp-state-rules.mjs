// Declarative ACP session-state rules — the engine behind harness "state packs".
//
// Today the bridge decides what an ACP session is doing by scattering regexes across
// modules: failure buckets in `acp-session-observation.mjs`, `looksLikeAcpFailureText`
// in `acp-event-stream.mjs`, and heuristics like "idle with no assistant output means
// failed". Every new CLI error string is a code change and a redeploy, and states the
// product needs — "waiting for a human to approve something" — have nowhere to live
// (backlog OC-12: structured run states, "stop scraping `?` from text").
//
// This module ports the detection model from herdr (Apache-2.0), a terminal agent
// runtime that classifies coding agents from observed text with declarative rule
// packs: priority-ordered rules, region pre-slicing, boolean gates with negative
// evidence, an explicit "this text is an echo, do not touch state" escape hatch, and
// a per-rule evidence trace for debugging. Rules are data (JSON packs, see
// `acp-state-packs.mjs`), so classification updates ship without a deploy.
//
// The engine is pure and dependency-free: it sees an *observation bundle* — the text
// facts the bridge already has for a session — and returns a classification plus, on
// request, a trace of every rule with exactly the text it looked at. It never decides
// alone: `arbitrateSessionState` merges rule output with the gateway's structured
// status, and the structured status is authoritative whenever it is definitive
// (herdr's rule: a complete integration signal silences the text scanner).
//
// Observation bundle fields, all optional strings:
//   text           assistant/chat text under evaluation (ANSI already stripped)
//   errorText      error payload / stderr tail packed into a failure message
//   snapshotStatus the gateway session snapshot's status string
//   eventType      the originating event type, when classifying a single event
//
// Rule regions select which field (and slice) a rule reads:
//   text | text_tail(N) | error_text | snapshot_status | event_type
//
// Matcher semantics (all case-insensitive, matching the regex soup this replaces):
//   contains[]   every entry must appear in the region
//   regex[]      every entry must match somewhere in the region
//   lineRegex[]  every entry must match some single line of the region
// Gates `all` / `any` / `not` nest recursively: all → every child matches; any →
// at least one child matches (empty means no constraint); not → no child matches.
// A rule's own matchers AND its gates must all pass for the rule to match.
//
// Arbitration: every rule is evaluated (no short-circuit); the highest `priority`
// match wins, ties keep the earlier rule. No match means "the packs have no opinion"
// and the caller keeps its existing behavior.

export const ACP_STATE_RULES_ENGINE_VERSION = 1;

// Compile-time caps, taken from herdr's manifest loader. They bound pathological
// packs before any evaluation happens; a pack over any cap fails to compile.
export const MAX_RULES_PER_PACK = 128;
export const MAX_GATE_DEPTH = 8;
export const MAX_TOTAL_GATES = 512;
export const MAX_MATCHERS_PER_GATE = 32;
export const MAX_TOTAL_MATCHERS = 1024;
export const MAX_MATCHER_LENGTH = 512;
export const MAX_TEXT_TAIL_LINES = 500;

// How much of the region each trace entry preserves. Enough to see what a rule saw,
// small enough to return for every rule of every pack in one response.
export const TRACE_REGION_PREVIEW_CHARS = 240;

export const RULE_STATES = Object.freeze([
  'working',
  'awaiting_user',
  'idle',
  'failed',
  'unknown',
]);

// Failure reasons the control plane already understands (shared/acpFailure buckets),
// plus room for packs to introduce finer ones without an engine change.
export const KNOWN_FAILURE_REASONS = Object.freeze([
  'quota_exhausted',
  'auth_required',
  'session_stale',
  'turn_failed',
]);

const REGION_NAMES = Object.freeze(['text', 'error_text', 'snapshot_status', 'event_type']);
const TEXT_TAIL_RE = /^text_tail\((\d{1,3})\)$/;

const RULE_KEYS = Object.freeze([
  'id',
  'state',
  'reason',
  'priority',
  'region',
  'blockerEvidence',
  'skipStateUpdate',
  'contains',
  'regex',
  'lineRegex',
  'all',
  'any',
  'not',
]);
const GATE_KEYS = Object.freeze(['contains', 'regex', 'lineRegex', 'all', 'any', 'not']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asStringArray(value, label, errors) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array of strings`);
    return [];
  }
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      errors.push(`${label} entries must be non-empty strings`);
      continue;
    }
    if (entry.length > MAX_MATCHER_LENGTH) {
      errors.push(`${label} entry exceeds ${MAX_MATCHER_LENGTH} chars`);
      continue;
    }
    out.push(entry);
  }
  return out;
}

// Regexes come from pack files, which admins can override on disk — never trust them
// to compile. Case-insensitive to match the `contains` semantics and the historical
// FAILURE_RE behavior this engine replaces.
function compileRegexes(patterns, label, errors) {
  const out = [];
  for (const pattern of patterns) {
    try {
      out.push(new RegExp(pattern, 'i'));
    } catch {
      errors.push(`${label} has invalid regex: ${pattern}`);
    }
  }
  return out;
}

function compileGate(raw, path, budget, errors, depth = 1) {
  if (!isPlainObject(raw)) {
    errors.push(`${path} must be an object`);
    return null;
  }
  if (depth > MAX_GATE_DEPTH) {
    errors.push(`${path} exceeds max gate depth ${MAX_GATE_DEPTH}`);
    return null;
  }
  for (const key of Object.keys(raw)) {
    if (!GATE_KEYS.includes(key)) errors.push(`${path} has unknown key "${key}"`);
  }
  budget.gates += 1;
  if (budget.gates > MAX_TOTAL_GATES) {
    errors.push(`pack exceeds ${MAX_TOTAL_GATES} total gates`);
    return null;
  }

  const contains = asStringArray(raw.contains, `${path}.contains`, errors).map((s) => s.toLowerCase());
  const regexSrc = asStringArray(raw.regex, `${path}.regex`, errors);
  const lineRegexSrc = asStringArray(raw.lineRegex, `${path}.lineRegex`, errors);
  const matcherCount = contains.length + regexSrc.length + lineRegexSrc.length;
  if (matcherCount > MAX_MATCHERS_PER_GATE) {
    errors.push(`${path} exceeds ${MAX_MATCHERS_PER_GATE} matchers`);
    return null;
  }
  budget.matchers += matcherCount;
  if (budget.matchers > MAX_TOTAL_MATCHERS) {
    errors.push(`pack exceeds ${MAX_TOTAL_MATCHERS} total matchers`);
    return null;
  }

  const compileNested = (list, key) => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) {
      errors.push(`${path}.${key} must be an array`);
      return [];
    }
    return list
      .map((child, i) => compileGate(child, `${path}.${key}[${i}]`, budget, errors, depth + 1))
      .filter(Boolean);
  };

  return {
    contains,
    regex: compileRegexes(regexSrc, `${path}.regex`, errors),
    lineRegex: compileRegexes(lineRegexSrc, `${path}.lineRegex`, errors),
    all: compileNested(raw.all, 'all'),
    any: compileNested(raw.any, 'any'),
    not: compileNested(raw.not, 'not'),
  };
}

function gateMatches(gate, region, regionLower, regionLines) {
  for (const needle of gate.contains) {
    if (!regionLower.includes(needle)) return false;
  }
  for (const re of gate.regex) {
    if (!re.test(region)) return false;
  }
  for (const re of gate.lineRegex) {
    if (!regionLines.some((line) => re.test(line))) return false;
  }
  for (const child of gate.all) {
    if (!gateMatches(child, region, regionLower, regionLines)) return false;
  }
  if (gate.any.length > 0) {
    if (!gate.any.some((child) => gateMatches(child, region, regionLower, regionLines))) return false;
  }
  for (const child of gate.not) {
    if (gateMatches(child, region, regionLower, regionLines)) return false;
  }
  return true;
}

function validateRegion(raw, path, errors) {
  if (raw === undefined) return 'text';
  if (typeof raw !== 'string') {
    errors.push(`${path}.region must be a string`);
    return 'text';
  }
  if (REGION_NAMES.includes(raw)) return raw;
  const tail = TEXT_TAIL_RE.exec(raw);
  if (tail) {
    const lines = Number(tail[1]);
    if (lines >= 1 && lines <= MAX_TEXT_TAIL_LINES) return raw;
  }
  errors.push(`${path}.region "${raw}" is not a known region`);
  return 'text';
}

// Region extraction happens once per rule evaluation, on demand. Slicing is plain
// string work — nothing here allocates beyond the tail join.
export function regionText(region, observation) {
  const obs = observation || {};
  if (region === 'error_text') return typeof obs.errorText === 'string' ? obs.errorText : '';
  if (region === 'snapshot_status') return typeof obs.snapshotStatus === 'string' ? obs.snapshotStatus : '';
  if (region === 'event_type') return typeof obs.eventType === 'string' ? obs.eventType : '';
  const text = typeof obs.text === 'string' ? obs.text : '';
  const tail = TEXT_TAIL_RE.exec(region || '');
  if (tail) {
    const lines = text.split('\n');
    const keep = Number(tail[1]);
    return lines.length > keep ? lines.slice(lines.length - keep).join('\n') : text;
  }
  return text;
}

// Compile a raw pack (parsed JSON) into an evaluable form. Never throws: returns
// `{ pack, errors }` and the caller decides whether errors disqualify the pack —
// a broken local override must fall back to the bundled pack, not take the bridge down.
export function compileStatePack(raw) {
  const errors = [];
  if (!isPlainObject(raw)) {
    return { pack: null, errors: ['pack must be an object'] };
  }
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : null;
  if (!id) errors.push('pack.id must be a non-empty string');
  const version = typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : '0';
  const minEngineVersion = Number.isInteger(raw.minEngineVersion) ? raw.minEngineVersion : 1;
  if (minEngineVersion > ACP_STATE_RULES_ENGINE_VERSION) {
    // An old bridge must ignore a pack written for a newer engine rather than
    // half-apply it — same gate herdr uses for manifest/engine compatibility.
    errors.push(
      `pack requires engine ${minEngineVersion}, this bridge has ${ACP_STATE_RULES_ENGINE_VERSION}`
    );
  }
  const aliases = asStringArray(raw.aliases, 'pack.aliases', errors).map((a) => a.toLowerCase());

  if (!Array.isArray(raw.rules)) {
    errors.push('pack.rules must be an array');
    return { pack: null, errors };
  }
  if (raw.rules.length > MAX_RULES_PER_PACK) {
    errors.push(`pack exceeds ${MAX_RULES_PER_PACK} rules`);
    return { pack: null, errors };
  }

  const budget = { gates: 0, matchers: 0 };
  const rules = [];
  const seenIds = new Set();
  raw.rules.forEach((rawRule, index) => {
    const path = `rules[${index}]`;
    if (!isPlainObject(rawRule)) {
      errors.push(`${path} must be an object`);
      return;
    }
    for (const key of Object.keys(rawRule)) {
      if (!RULE_KEYS.includes(key)) errors.push(`${path} has unknown key "${key}"`);
    }
    const ruleId = typeof rawRule.id === 'string' && rawRule.id.trim() ? rawRule.id.trim() : `rule_${index}`;
    if (seenIds.has(ruleId)) errors.push(`${path} duplicates rule id "${ruleId}"`);
    seenIds.add(ruleId);
    if (!RULE_STATES.includes(rawRule.state)) {
      errors.push(`${path}.state "${rawRule.state}" is not one of ${RULE_STATES.join('|')}`);
      return;
    }
    const priority = Number.isInteger(rawRule.priority) ? rawRule.priority : 0;
    const region = validateRegion(rawRule.region, path, errors);
    const gate = compileGate(
      {
        contains: rawRule.contains,
        regex: rawRule.regex,
        lineRegex: rawRule.lineRegex,
        all: rawRule.all,
        any: rawRule.any,
        not: rawRule.not,
      },
      path,
      budget,
      errors
    );
    if (!gate) return;
    rules.push({
      id: ruleId,
      state: rawRule.state,
      reason: typeof rawRule.reason === 'string' && rawRule.reason ? rawRule.reason : null,
      priority,
      region,
      blockerEvidence: rawRule.blockerEvidence === true,
      skipStateUpdate: rawRule.skipStateUpdate === true,
      gate,
    });
  });

  if (!id || errors.some((e) => e.startsWith('pack ') || e.startsWith('pack.'))) {
    // Structural pack-level problems disqualify the pack outright; per-rule issues
    // above already dropped only the offending rules.
    if (!id || minEngineVersion > ACP_STATE_RULES_ENGINE_VERSION || !rules.length) {
      return { pack: null, errors };
    }
  }

  return {
    pack: { id, version, minEngineVersion, aliases, rules },
    errors,
  };
}

// Evaluate every rule; highest priority wins, ties keep the earlier rule. Returns
// null when no rule matched — the packs have no opinion and the caller's existing
// classification stands untouched.
export function evaluateStatePack(pack, observation) {
  if (!pack || !Array.isArray(pack.rules)) return null;
  let best = null;
  for (const rule of pack.rules) {
    const region = regionText(rule.region, observation);
    if (!region) continue;
    if (!gateMatches(rule.gate, region, region.toLowerCase(), region.split('\n'))) continue;
    if (!best || rule.priority > best.priority) best = rule;
  }
  if (!best) return null;
  return {
    state: best.state,
    reason: best.reason,
    ruleId: best.id,
    priority: best.priority,
    blockerEvidence: best.blockerEvidence,
    skipStateUpdate: best.skipStateUpdate,
  };
}

// The debugging product: every rule, whether it matched, and a preview of exactly
// the text it evaluated. This is what makes rule packs maintainable by people who
// did not write the engine — port of `herdr agent explain`.
export function explainStatePack(pack, observation) {
  const evaluated = [];
  let best = null;
  if (pack && Array.isArray(pack.rules)) {
    for (const rule of pack.rules) {
      const region = regionText(rule.region, observation);
      const matched =
        region.length > 0 && gateMatches(rule.gate, region, region.toLowerCase(), region.split('\n'));
      if (matched && (!best || rule.priority > best.priority)) best = rule;
      evaluated.push({
        id: rule.id,
        state: rule.state,
        reason: rule.reason,
        priority: rule.priority,
        region: rule.region,
        blockerEvidence: rule.blockerEvidence,
        skipStateUpdate: rule.skipStateUpdate,
        matched,
        regionBytes: region.length,
        regionPreview: region.slice(0, TRACE_REGION_PREVIEW_CHARS),
      });
    }
  }
  return {
    engineVersion: ACP_STATE_RULES_ENGINE_VERSION,
    packId: pack?.id ?? null,
    packVersion: pack?.version ?? null,
    result: best
      ? {
          state: best.state,
          reason: best.reason,
          ruleId: best.id,
          priority: best.priority,
          blockerEvidence: best.blockerEvidence,
          skipStateUpdate: best.skipStateUpdate,
        }
      : null,
    evaluatedRules: evaluated,
  };
}

// Statuses the gateway/registry reports that are final and trustworthy on their own.
// When the structured channel says one of these, the text scanner stands down —
// herdr's "complete integration signal is the sole authority" rule.
const HARD_TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'closed']);

// Merge the structured status with the rule verdict into what the bridge should
// publish. Deliberately additive on the wire: `status` stays within the strings the
// control plane already knows; new information rides in `attention` and `reason`.
//
// Returns { status, attention, reason, source } where source names the authority
// that decided ('structured' | 'rules' | 'merged').
export function arbitrateSessionState({ structuredStatus, ruleResult }) {
  const status = typeof structuredStatus === 'string' && structuredStatus ? structuredStatus : 'unknown';

  if (!ruleResult || ruleResult.skipStateUpdate) {
    // No opinion, or the matched screen/text is an echo (system-prompt dump,
    // transcript replay) that must not disturb the published state.
    return { status, attention: null, reason: null, source: 'structured' };
  }

  if (HARD_TERMINAL_STATUSES.has(status)) {
    // A definitive terminal from the structured channel wins outright. The one
    // refinement rules may add is a failure reason when the session already failed —
    // handled below, but completed/cancelled/closed take no annotations.
    return { status, attention: null, reason: null, source: 'structured' };
  }

  if (ruleResult.state === 'failed') {
    // Failure classification is the packs' home turf — this branch replaces the
    // scattered FAILURE_RE call sites.
    return { status: 'failed', attention: null, reason: ruleResult.reason ?? null, source: 'rules' };
  }

  if (status === 'failed') {
    // Already failed structurally; rules cannot resurrect it, only annotate.
    return { status, attention: null, reason: ruleResult.reason ?? null, source: 'merged' };
  }

  if (ruleResult.state === 'awaiting_user' && ruleResult.blockerEvidence) {
    // Visible blocker evidence overrides a non-terminal status — the agent may be
    // "working" by process signals while sitting on an approval prompt. The status
    // string is preserved for wire compatibility; attention carries the new fact.
    return { status, attention: 'awaiting_user', reason: ruleResult.reason ?? null, source: 'rules' };
  }

  // Everything else (idle/working/unknown opinions) defers to the structured status:
  // text evidence is weaker than process evidence for non-blocking states.
  return { status, attention: null, reason: null, source: 'structured' };
}
