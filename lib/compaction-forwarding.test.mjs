import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('live OpenClaw compaction signals are forwarded to Trooper with run identity', () => {
  const source = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');

  assert.match(
    source,
    /if \(stream === 'compaction' && data\)[\s\S]*?onEvent\('compaction',[\s\S]*?runId: runId \|\| mainRunId \|\| null,[\s\S]*?sessionKey/,
  );
});

test('background OpenClaw compaction signals are broadcast instead of discarded', () => {
  const source = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');

  assert.match(
    source,
    /stream === 'lifecycle' \|\| stream === 'compaction'/,
  );
  assert.match(source, /completed: stream === 'compaction' \? data\?\.completed : undefined/);
});
