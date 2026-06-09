import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');

test('control-plane callbacks include shared and per-org runtime credentials', () => {
  assert.match(source, /const ORG_RUNTIME_TOKEN = process\.env\.OPENCLAW_GATEWAY_TOKEN \|\| process\.env\.GATEWAY_TOKEN/);
  assert.match(source, /postRuntimeQuota[\s\S]*'x-runtime-secret': RUNTIME_AUTH_SECRET,[\s\S]*'x-org-runtime-token': ORG_RUNTIME_TOKEN/);
  assert.match(source, /forwardToMissionControl[\s\S]*'x-runtime-secret': RUNTIME_AUTH_SECRET,[\s\S]*'x-org-id': ORG_ID,[\s\S]*'x-org-runtime-token': ORG_RUNTIME_TOKEN/);
});
