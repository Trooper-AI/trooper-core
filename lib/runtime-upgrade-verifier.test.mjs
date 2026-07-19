import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const source = readFileSync(join(process.cwd(), 'scripts', 'verify-managed-upgrade.sh'), 'utf8');

test('bridge-only upgrade health ignores unrelated Trooper application ports', () => {
  assert.match(source, /if \[\[ "\$SCOPE" != "bridge" \]\]; then/);
  assert.match(source, /bridge\|http:\/\/127\.0\.0\.1:3002\/healthz/);
  assert.match(source, /gateway\|http:\/\/127\.0\.0\.1:18789\/health/);
  assert.match(source, /org-runtime\|http:\/\/127\.0\.0\.1:3101\/health/);
  assert.match(source, /trooper-server\|http:\/\/127\.0\.0\.1:3001\/health/);
});

test('upgrade journal records the failed scoped endpoints before rollback', () => {
  assert.match(source, /failed_endpoints="\$\(failed_health_endpoints\)"/);
  assert.match(source, /\$\{SCOPE\} health checks failed after upgrade/);
});
