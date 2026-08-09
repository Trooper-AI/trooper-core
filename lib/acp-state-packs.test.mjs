import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { arbitrateSessionState } from './acp-state-rules.mjs';
import {
  acpStatePacksStatus,
  classifyAcpObservation,
  explainAcpObservation,
  reloadAcpStatePacks,
  resetAcpStatePacksForTest,
} from './acp-state-packs.mjs';

// Each test starts from the bundled packs; override tests reload against a temp dir.
test.beforeEach(() => {
  resetAcpStatePacksForTest();
  reloadAcpStatePacks({ dir: path.join(os.tmpdir(), 'no-such-pack-dir') });
});

// The exact quota blob the observation tests pin — buried behind a truncated
// system-prompt fragment, quota sentence at the end. Classification must say quota,
// not turn_failed, and never prompt-echo.
const BURIED_QUOTA = [
  'ACP_TURN_FAILED Internal error: eir browser. ### Editing constraints You default to ASCII',
  'x'.repeat(400),
  "ERROR: You've hit your usage limit. try again at Aug 30th, 2026 5:38 PM. Some(UsageLimitExceeded)",
].join(' ');

test('bundled packs compile cleanly for every shipped harness', () => {
  const status = acpStatePacksStatus();
  assert.ok(status.packs.length >= 6);
  for (const entry of status.packs) {
    assert.equal(entry.source, 'bundled', `${entry.id} should be bundled in tests`);
    assert.deepEqual(entry.warnings, [], `${entry.id} should compile without warnings`);
    assert.ok(entry.ruleCount > 0);
  }
});

test('quota text classifies as failed/quota_exhausted for any harness via the common pack', () => {
  const result = classifyAcpObservation('codex', { text: 'Some(UsageLimitExceeded)' });
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'quota_exhausted');
});

test('a quota error buried under a prompt fragment still reads as quota, not turn_failed', () => {
  const result = classifyAcpObservation('codex', { text: BURIED_QUOTA });
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'quota_exhausted');
});

test('a pure system-prompt dump is a skip — it must not classify as anything', () => {
  const dump = `You are Codex. Always follow AGENTS.md and SOUL.md. Mission Floor. ${'x'.repeat(900)}`;
  const result = classifyAcpObservation('codex', { text: dump });
  assert.equal(result.skipStateUpdate, true);
  const verdict = arbitrateSessionState({ structuredStatus: 'working', ruleResult: result });
  assert.equal(verdict.status, 'working');
  assert.equal(verdict.source, 'structured');
});

test('a Claude permission prompt reads as awaiting_user with blocker evidence', () => {
  const result = classifyAcpObservation('claude', {
    text: 'Do you want to allow Claude to run `npm install`?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently',
  });
  assert.equal(result.state, 'awaiting_user');
  assert.equal(result.blockerEvidence, true);
  const verdict = arbitrateSessionState({ structuredStatus: 'working', ruleResult: result });
  assert.equal(verdict.attention, 'awaiting_user');
  assert.equal(verdict.status, 'working');
});

test('quota text near prompt language still classifies as quota — negative evidence holds', () => {
  const result = classifyAcpObservation('claude', {
    text: 'Do you want to continue? 1. Yes — but usage limit reached. Some(UsageLimitExceeded)',
  });
  assert.equal(result.state, 'failed');
  assert.equal(result.reason, 'quota_exhausted');
});

test('harness aliases resolve to the same pack', () => {
  const viaAlias = classifyAcpObservation('claude-code', {
    text: 'Do you want to proceed?\n1. Yes',
  });
  assert.equal(viaAlias?.state, 'awaiting_user');
});

test('a typed permission event classifies as awaiting_user regardless of harness', () => {
  const result = classifyAcpObservation('opencode', { eventType: 'permission_request', text: '' });
  assert.equal(result.state, 'awaiting_user');
  assert.equal(result.blockerEvidence, true);
});

test('explain returns per-rule traces across the harness and common packs', () => {
  const explain = explainAcpObservation('claude', { text: 'Some(UsageLimitExceeded)' });
  assert.equal(explain.result.reason, 'quota_exhausted');
  assert.equal(explain.packs.length, 2);
  const commonTrace = explain.packs.find((p) => p.packId === 'common');
  const quotaRule = commonTrace.evaluatedRules.find((r) => r.id === 'quota_exhausted');
  assert.equal(quotaRule.matched, true);
  assert.ok(quotaRule.regionPreview.includes('UsageLimitExceeded'));
});

test('a valid disk override replaces the bundled pack and reports its source', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-packs-'));
  fs.writeFileSync(
    path.join(dir, 'claude.json'),
    JSON.stringify({
      id: 'claude',
      version: '2099.01.01.1',
      minEngineVersion: 1,
      aliases: ['claude-code'],
      rules: [
        { id: 'custom', state: 'awaiting_user', blockerEvidence: true, priority: 999, contains: ['magic phrase'] },
      ],
    })
  );
  reloadAcpStatePacks({ dir });
  const status = acpStatePacksStatus();
  const claude = status.packs.find((p) => p.id === 'claude');
  assert.equal(claude.version, '2099.01.01.1');
  assert.ok(claude.source.startsWith('override:'));
  assert.equal(classifyAcpObservation('claude', { text: 'magic phrase' }).state, 'awaiting_user');
});

test('a broken disk override is ignored with a warning — bundled rules keep serving', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-packs-'));
  fs.writeFileSync(path.join(dir, 'claude.json'), '{ not json');
  reloadAcpStatePacks({ dir });
  const status = acpStatePacksStatus();
  const claude = status.packs.find((p) => p.id === 'claude');
  assert.equal(claude.source, 'bundled');
  assert.ok(claude.warnings.some((w) => w.includes('not valid JSON')));
  // Bundled behavior is intact.
  assert.equal(
    classifyAcpObservation('claude', { text: 'Do you want to proceed?\n1. Yes' })?.state,
    'awaiting_user'
  );
});
