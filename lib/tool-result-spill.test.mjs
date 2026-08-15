import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SPILL_THRESHOLD_BYTES,
  SPILL_EXCERPT_BYTES,
  buildSpillExcerptText,
  maybeSpillToolResultText,
  resolveSpillSettings,
  spillToolResultText,
} from './tool-result-spill.mjs';

const makeDir = () => mkdtempSync(path.join(tmpdir(), 'tool-result-spill-test-'));
const settingsFor = (dir, overrides = {}) => ({ enabled: true, thresholdBytes: 1024, dir, ...overrides });
const bigText = (bytes, fill = 'a') => `HEAD-MARKER ${fill.repeat(bytes)} TAIL-MARKER`;

test('settings default: on, 256KB threshold', () => {
  const settings = resolveSpillSettings({});
  assert.equal(settings.enabled, true);
  assert.equal(settings.thresholdBytes, DEFAULT_SPILL_THRESHOLD_BYTES);
  assert.ok(settings.dir);
});

test('settings: TROOPER_SPILL=0 disables, threshold and dir are overridable', () => {
  const settings = resolveSpillSettings({
    TROOPER_SPILL: '0',
    TROOPER_SPILL_THRESHOLD: '2048',
    TROOPER_SPILL_DIR: '/tmp/custom-spill',
  });
  assert.equal(settings.enabled, false);
  assert.equal(settings.thresholdBytes, 2048);
  assert.equal(settings.dir, '/tmp/custom-spill');
});

test('a garbage threshold falls back to the default', () => {
  assert.equal(resolveSpillSettings({ TROOPER_SPILL_THRESHOLD: 'lots' }).thresholdBytes, DEFAULT_SPILL_THRESHOLD_BYTES);
  assert.equal(resolveSpillSettings({ TROOPER_SPILL_THRESHOLD: '-5' }).thresholdBytes, DEFAULT_SPILL_THRESHOLD_BYTES);
});

test('text at or under the threshold stays inline, untouched', () => {
  const dir = makeDir();
  const text = 'x'.repeat(1024);
  const outcome = maybeSpillToolResultText(text, settingsFor(dir));
  assert.deepEqual(outcome, { spilled: false, text });
});

test('text over the threshold is spilled: full body on disk, excerpt + locator returned', () => {
  const dir = makeDir();
  const text = bigText(300_000);
  const outcome = maybeSpillToolResultText(text, settingsFor(dir));

  assert.equal(outcome.spilled, true);
  assert.equal(outcome.locator.byteLength, Buffer.byteLength(text));
  assert.equal(outcome.locator.excerptBytes, SPILL_EXCERPT_BYTES);
  assert.ok(outcome.locator.path.startsWith(dir));

  // Full body is on disk, byte-exact.
  assert.equal(readFileSync(outcome.locator.path, 'utf8'), text);

  // The persisted replacement keeps head + tail and names the locator.
  assert.ok(outcome.text.startsWith('HEAD-MARKER'));
  assert.ok(outcome.text.endsWith('TAIL-MARKER'));
  assert.ok(outcome.text.includes(`${Buffer.byteLength(text)} bytes total`));
  assert.ok(outcome.text.includes(outcome.locator.path));
  assert.ok(outcome.text.length < text.length);
});

test('spill files are private: 0600 file in a 0700 directory', (t) => {
  if (process.platform === 'win32') return t.skip('POSIX modes only');
  const dir = path.join(makeDir(), 'nested');
  const outcome = maybeSpillToolResultText(bigText(4096), settingsFor(dir));
  assert.equal(outcome.spilled, true);
  assert.equal(statSync(outcome.locator.path).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('disabled settings never spill, whatever the size', () => {
  const dir = makeDir();
  const text = bigText(4096);
  const outcome = maybeSpillToolResultText(text, settingsFor(dir, { enabled: false }));
  assert.deepEqual(outcome, { spilled: false, text });
});

test('non-string input is returned as-is', () => {
  for (const value of [null, undefined, 42, { raw: 'x' }]) {
    assert.deepEqual(maybeSpillToolResultText(value, settingsFor(makeDir())), { spilled: false, text: value });
  }
});

test('any spill failure keeps the full inline text (best-effort contract)', () => {
  // Point the spill dir at an existing FILE so mkdir must fail.
  const parent = makeDir();
  const blocker = path.join(parent, 'not-a-dir');
  writeFileSync(blocker, 'occupied');
  const text = bigText(4096);
  const outcome = maybeSpillToolResultText(text, settingsFor(blocker));
  assert.deepEqual(outcome, { spilled: false, text });
});

test('multibyte content survives spilling without throwing', () => {
  const dir = makeDir();
  const text = '🚀émoji—content '.repeat(400); // > 1KB threshold, multibyte throughout
  const outcome = maybeSpillToolResultText(text, settingsFor(dir));
  assert.equal(outcome.spilled, true);
  assert.equal(readFileSync(outcome.locator.path, 'utf8'), text);
  assert.equal(outcome.locator.byteLength, Buffer.byteLength(text));
});

test('spillToolResultText refuses to overwrite an existing file name', () => {
  const dir = makeDir();
  spillToolResultText('one', { dir, name: 'fixed.txt' });
  assert.throws(() => spillToolResultText('two', { dir, name: 'fixed.txt' }));
  assert.equal(readFileSync(path.join(dir, 'fixed.txt'), 'utf8'), 'one');
});

test('excerpt of a short-but-over-threshold text still contains both ends', () => {
  const text = 'S'.repeat(3000);
  const excerpt = buildSpillExcerptText(text, { path: '/tmp/x', byteLength: 3000 });
  assert.ok(excerpt.includes('truncated: 3000 bytes'));
  assert.ok(excerpt.startsWith('S'.repeat(10)));
  assert.ok(excerpt.endsWith('S'.repeat(10)));
});
