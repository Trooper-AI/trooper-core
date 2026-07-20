import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'index.mjs'), 'utf8');

test('POST /upgrade supports delegated async mode with a 202 acceptance contract', () => {
  assert.match(source, /if \(request\.async === true\) \{/);
  assert.match(source, /res\.status\(202\)\.json\(\{ accepted: true, operationId: acceptedOperationId \}\)/);
  // Validation and conflict checks happen BEFORE the 202 acceptance
  assert.match(source, /validateRuntimeUpgradeRequest\(request\);[\s\S]{0,1400}res\.status\(202\)/);
  assert.match(source, /runtime_upgrade_in_progress'[\s\S]{0,800}res\.status\(202\)/);
});

test('async conflict check applies the same 15-minute journal freshness window', () => {
  assert.match(source, /journalUpdatedAt > Date\.now\(\) - \(15 \* 60 \* 1000\)/);
  assert.match(source, /isRuntimeUpgradeActive\(journalState\) && journalIsFresh/);
});

test('performManagedRuntimeUpgrade adopts a caller-supplied operationId', () => {
  assert.match(source, /const requestedOperationId = String\(request\.operationId \|\| ''\)\.trim\(\)/);
  assert.match(source, /\/\^\[A-Za-z0-9_-\]\{8,80\}\$\/\.test\(requestedOperationId\)/);
  // Detached execution passes the accepted id through
  assert.match(source, /request: \{ \.\.\.request, operationId: acceptedOperationId \}/);
});

test('delegated execution runs detached and never rejects the HTTP response', () => {
  assert.match(source, /\)\(\)\.catch\(\(err\) => \{[\s\S]{0,300}Delegated runtime upgrade failed/);
  // Restart scheduling still happens for the detached path
  assert.match(source, /await scheduleManagedRuntimeServiceRestart\(result\.scope, result\.operationId\);\s*\}\)\(\)/);
});

test('synchronous non-async mode is preserved for older control planes', () => {
  assert.match(source, /const result = await performManagedRuntimeUpgrade\(\{ request \}\);/);
  assert.match(source, /res\.json\(\{ \.\.\.result, verifier \}\)/);
});
