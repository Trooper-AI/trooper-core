import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACP_STATE_RULES_ENGINE_VERSION,
  MAX_RULES_PER_PACK,
  TRACE_REGION_PREVIEW_CHARS,
  arbitrateSessionState,
  compileStatePack,
  evaluateStatePack,
  explainStatePack,
  regionText,
} from './acp-state-rules.mjs';

function pack(rules, extra = {}) {
  const { pack: compiled, errors } = compileStatePack({
    id: 'test',
    version: '1',
    minEngineVersion: 1,
    rules,
    ...extra,
  });
  return { compiled, errors };
}

// ── compilation ────────────────────────────────────────────────────────────────

test('a well-formed pack compiles with no errors', () => {
  const { compiled, errors } = pack([
    { id: 'r1', state: 'failed', reason: 'quota_exhausted', priority: 10, contains: ['usage limit'] },
  ]);
  assert.ok(compiled);
  assert.deepEqual(errors, []);
  assert.equal(compiled.rules.length, 1);
});

test('unknown rule keys are reported — packs are operator-editable data, typos must surface', () => {
  const { errors } = pack([{ id: 'r1', state: 'idle', contians: ['oops'] }]);
  assert.ok(errors.some((e) => e.includes('unknown key "contians"')));
});

test('a rule with an unrecognized state is dropped and reported, the rest survive', () => {
  const { compiled, errors } = pack([
    { id: 'bad', state: 'meditating', contains: ['om'] },
    { id: 'good', state: 'failed', contains: ['boom'] },
  ]);
  assert.ok(errors.some((e) => e.includes('meditating')));
  assert.deepEqual(compiled.rules.map((r) => r.id), ['good']);
});

test('an invalid regex is reported without sinking the pack', () => {
  const { compiled, errors } = pack([
    { id: 'r1', state: 'failed', regex: ['('] },
    { id: 'r2', state: 'failed', contains: ['boom'] },
  ]);
  assert.ok(errors.some((e) => e.includes('invalid regex')));
  assert.equal(compiled.rules.length, 2);
});

test('a pack demanding a newer engine is rejected outright', () => {
  const { compiled, errors } = pack(
    [{ id: 'r1', state: 'idle', contains: ['x'] }],
    { minEngineVersion: ACP_STATE_RULES_ENGINE_VERSION + 1 }
  );
  assert.equal(compiled, null);
  assert.ok(errors.some((e) => e.includes('requires engine')));
});

test('rule-count and gate-depth caps bound pathological packs', () => {
  const many = Array.from({ length: MAX_RULES_PER_PACK + 1 }, (_, i) => ({
    id: `r${i}`, state: 'idle', contains: ['x'],
  }));
  assert.equal(pack(many).compiled, null);

  let nested = { contains: ['deep'] };
  for (let i = 0; i < 12; i += 1) nested = { all: [nested] };
  const { errors } = pack([{ id: 'deep', state: 'idle', ...nested }]);
  assert.ok(errors.some((e) => e.includes('max gate depth')));
});

// ── regions ────────────────────────────────────────────────────────────────────

test('regions route to the right observation fields', () => {
  const obs = { text: 'body', errorText: 'stderr', snapshotStatus: 'idle', eventType: 'message' };
  assert.equal(regionText('text', obs), 'body');
  assert.equal(regionText('error_text', obs), 'stderr');
  assert.equal(regionText('snapshot_status', obs), 'idle');
  assert.equal(regionText('event_type', obs), 'message');
});

test('text_tail(N) keeps only the last N lines — a prompt at the end must not be masked by a long transcript', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
  assert.equal(regionText('text_tail(3)', { text: lines.join('\n') }), 'line 97\nline 98\nline 99');
  assert.equal(regionText('text_tail(200)', { text: 'a\nb' }), 'a\nb');
});

test('an empty region never matches — absence of text is not evidence', () => {
  const { compiled } = pack([{ id: 'r1', state: 'failed', region: 'error_text', regex: ['.*'] }]);
  assert.equal(evaluateStatePack(compiled, { text: 'plenty of text, no errorText' }), null);
});

// ── matching semantics ─────────────────────────────────────────────────────────

test('contains entries must ALL match, case-insensitively', () => {
  const { compiled } = pack([{ id: 'r1', state: 'failed', contains: ['usage LIMIT', 'exceeded'] }]);
  assert.ok(evaluateStatePack(compiled, { text: 'Usage limit was Exceeded today' }));
  assert.equal(evaluateStatePack(compiled, { text: 'usage limit only' }), null);
});

test('lineRegex must match within a single line, not across lines', () => {
  const { compiled } = pack([{ id: 'r1', state: 'idle', lineRegex: ['^ready now$'] }]);
  assert.ok(evaluateStatePack(compiled, { text: 'busy\nready now\nmore' }));
  assert.equal(evaluateStatePack(compiled, { text: 'ready\nnow' }), null);
});

test('any-gates need one branch, not-gates are negative evidence', () => {
  const { compiled } = pack([
    {
      id: 'prompt',
      state: 'awaiting_user',
      blockerEvidence: true,
      contains: ['do you want'],
      any: [{ contains: ['yes'] }, { contains: ['allow'] }],
      not: [{ contains: ['usage limit'] }],
    },
  ]);
  assert.ok(evaluateStatePack(compiled, { text: 'Do you want to proceed? 1. Yes' }));
  assert.equal(evaluateStatePack(compiled, { text: 'Do you want to proceed? maybe' }), null);
  // The negative branch: identical prompt language plus quota text must not read as a prompt.
  assert.equal(
    evaluateStatePack(compiled, { text: 'Do you want to proceed? 1. Yes — usage limit reached' }),
    null
  );
});

test('highest priority wins; ties keep the earlier rule', () => {
  const { compiled } = pack([
    { id: 'low', state: 'idle', priority: 1, contains: ['x'] },
    { id: 'high', state: 'failed', priority: 9, contains: ['x'] },
    { id: 'tie', state: 'working', priority: 9, contains: ['x'] },
  ]);
  const result = evaluateStatePack(compiled, { text: 'x' });
  assert.equal(result.ruleId, 'high');
  assert.equal(result.state, 'failed');
});

// ── explain ────────────────────────────────────────────────────────────────────

test('explain lists every rule with matched flags and a bounded region preview', () => {
  const { compiled } = pack([
    { id: 'hit', state: 'failed', contains: ['boom'] },
    { id: 'miss', state: 'idle', contains: ['calm'] },
  ]);
  const explain = explainStatePack(compiled, { text: `boom ${'x'.repeat(1000)}` });
  assert.equal(explain.result.ruleId, 'hit');
  assert.deepEqual(
    explain.evaluatedRules.map((r) => [r.id, r.matched]),
    [['hit', true], ['miss', false]]
  );
  assert.ok(explain.evaluatedRules[0].regionPreview.length <= TRACE_REGION_PREVIEW_CHARS);
  assert.ok(explain.evaluatedRules[0].regionBytes > TRACE_REGION_PREVIEW_CHARS);
});

// ── arbitration ────────────────────────────────────────────────────────────────

test('a hard structured terminal silences the rules entirely', () => {
  const verdict = arbitrateSessionState({
    structuredStatus: 'completed',
    ruleResult: { state: 'failed', reason: 'quota_exhausted', blockerEvidence: false, skipStateUpdate: false },
  });
  assert.deepEqual(verdict, { status: 'completed', attention: null, reason: null, source: 'structured' });
});

test('a failed rule verdict overrides a live structured status', () => {
  const verdict = arbitrateSessionState({
    structuredStatus: 'working',
    ruleResult: { state: 'failed', reason: 'quota_exhausted', blockerEvidence: false, skipStateUpdate: false },
  });
  assert.equal(verdict.status, 'failed');
  assert.equal(verdict.reason, 'quota_exhausted');
  assert.equal(verdict.source, 'rules');
});

test('awaiting_user with blocker evidence sets attention but preserves the wire status', () => {
  const verdict = arbitrateSessionState({
    structuredStatus: 'working',
    ruleResult: { state: 'awaiting_user', reason: 'permission_prompt', blockerEvidence: true, skipStateUpdate: false },
  });
  assert.equal(verdict.status, 'working');
  assert.equal(verdict.attention, 'awaiting_user');
});

test('awaiting_user WITHOUT blocker evidence defers to the structured status', () => {
  const verdict = arbitrateSessionState({
    structuredStatus: 'working',
    ruleResult: { state: 'awaiting_user', reason: null, blockerEvidence: false, skipStateUpdate: false },
  });
  assert.equal(verdict.attention, null);
  assert.equal(verdict.source, 'structured');
});

test('a skip-state match leaves the published state untouched — echoes are not evidence', () => {
  const verdict = arbitrateSessionState({
    structuredStatus: 'working',
    ruleResult: { state: 'unknown', reason: null, blockerEvidence: false, skipStateUpdate: true },
  });
  assert.deepEqual(verdict, { status: 'working', attention: null, reason: null, source: 'structured' });
});

test('an already-failed structured status keeps failing but accepts a reason annotation', () => {
  const verdict = arbitrateSessionState({
    structuredStatus: 'failed',
    ruleResult: { state: 'awaiting_user', reason: 'quota_exhausted', blockerEvidence: true, skipStateUpdate: false },
  });
  assert.equal(verdict.status, 'failed');
  assert.equal(verdict.reason, 'quota_exhausted');
});

test('no rule opinion means the structured status passes through unchanged', () => {
  assert.deepEqual(arbitrateSessionState({ structuredStatus: 'working', ruleResult: null }), {
    status: 'working', attention: null, reason: null, source: 'structured',
  });
  assert.equal(arbitrateSessionState({ structuredStatus: '', ruleResult: null }).status, 'unknown');
});
