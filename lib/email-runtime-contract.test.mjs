import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

test('agent email endpoints stay feature-gated and proxy through Mission Control', () => {
  const bridge = read('index.mjs');

  assert.match(bridge, /process\.env\.TROOPER_EMAIL_ENABLED/);
  assert.match(bridge, /app\.post\('\/email\/send'/);
  assert.match(bridge, /app\.get\('\/email\/inbox'/);
  assert.match(bridge, /\/api\/runtime-email\/\$\{encodeURIComponent\(ORG_ID\)\}/);
});

test('fresh and shared runtime services receive the agent email enable flag', () => {
  const setup = read('setup-openclaw-full.sh');

  assert.match(setup, /TROOPER_EMAIL_ENABLED=.*\{\{TROOPER_EMAIL_ENABLED\}\}/);
  assert.equal(
    (setup.match(/Environment=TROOPER_EMAIL_ENABLED=\$\{TROOPER_EMAIL_ENABLED\}/g) || []).length,
    2,
  );
});
