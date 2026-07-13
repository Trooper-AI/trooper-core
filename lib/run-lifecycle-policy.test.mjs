import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { classifyOpenClawLifecycleSignal } from './run-lifecycle-policy.mjs';

test('lifecycle error is non-terminal while OpenClaw still owns the run', () => {
  assert.deepEqual(
    classifyOpenClawLifecycleSignal({
      phase: 'error',
      error: 'CLI transcript compaction failed: session file locked (timeout 60000ms)',
    }),
    { phase: 'error', terminal: false, successful: null },
  );
});

test('only explicit OpenClaw completion states are terminal', () => {
  assert.equal(classifyOpenClawLifecycleSignal({ phase: 'end' }).terminal, true);
  assert.equal(classifyOpenClawLifecycleSignal({ phase: 'failed' }).terminal, true);
  assert.equal(classifyOpenClawLifecycleSignal({ phase: 'aborted' }).terminal, true);
  assert.equal(classifyOpenClawLifecycleSignal({ phase: 'start' }).terminal, false);
});

test('active agent requests survive gateway reconnects without a bridge timeout', () => {
  const source = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');

  assert.match(source, /opts\.timeoutMs\)\) \? Number\(opts\.timeoutMs\) : 0/);
  assert.doesNotMatch(source, /const timeoutMs = .*: 600000/);
  assert.match(source, /preserveAcrossReconnect: !steerMode/);
  assert.match(source, /if \(pending\.preserveAcrossReconnect === true\) \{\s*pending\.transportDetached = true;\s*continue;/);
  assert.match(source, /const lifecycleSignal = stream === 'lifecycle'[\s\S]*?if \(pending\?\.transportDetached === true\)/);
});

test('steering across an assistant transcript boundary continues as a normal follow-up', () => {
  const source = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');

  assert.match(source, /cannot continue from message role\\s\*:\\s\*assistant/i);
  assert.match(source, /reason: 'assistant_transcript_boundary'/);
  assert.match(source, /steer: false,[\s\S]*sessionKey,[\s\S]*idempotencyKey: randomUUID\(\)/);
});

test('headless browser tools cannot announce a visible VNC session or recording', () => {
  const source = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');

  assert.match(source, /visibleBrowserViewport = hasVisibleBrowserViewport/);
  assert.match(source, /isDesktopTool\(data\?\.tool\) && visibleBrowserViewport/);
  assert.match(source, /isBrowserTool\(data\?\.tool\) && visibleBrowserViewport/);
  assert.doesNotMatch(source, /browserSessionActive \|\| isBrowserTask/);
});
