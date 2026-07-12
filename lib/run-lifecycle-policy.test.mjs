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
