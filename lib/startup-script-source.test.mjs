import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MIN_PLAUSIBLE_LENGTH,
  canonicalStartupScriptCandidates,
  isPlausibleStartupScript,
  readCanonicalStartupScript,
} from './startup-script-source.mjs';

const libDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(libDir);

test('the repo ships a canonical startup.sh that passes the plausibility check', () => {
  const text = readFileSync(join(repoRoot, 'startup.sh'), 'utf8');
  assert.equal(isPlausibleStartupScript(text), true);
});

test('the canonical script still carries the features the stale inline copy lacked', () => {
  // These three are exactly what index.mjs's old template literal was missing. If they ever leave
  // startup.sh, the reason this module exists has been undone.
  const text = readFileSync(join(repoRoot, 'startup.sh'), 'utf8');
  for (const marker of ['acpx-bootstrap', 'link_persistent_cli_home']) {
    assert.ok(text.includes(marker), `canonical startup.sh must retain ${marker}`);
  }
});

test('index.mjs no longer carries its own startup script body', () => {
  // Regression guard against the triplication returning. The repair path must read the canonical
  // file, not embed a copy that drifts.
  const source = readFileSync(join(repoRoot, 'index.mjs'), 'utf8');
  const fnStart = source.indexOf('function ensureOpenClawStartupScript');
  assert.ok(fnStart > -1, 'ensureOpenClawStartupScript should still exist');
  const body = source.slice(fnStart, fnStart + 4000);
  assert.doesNotMatch(body, /node dist\/index\.js gateway/,
    'the repair path must not embed a startup script body');
});

test('resolution looks beside the bridge first, then the deployed path', () => {
  const candidates = canonicalStartupScriptCandidates('/opt/openclaw-bridge/lib');
  assert.deepEqual(candidates, ['/opt/openclaw-bridge/startup.sh', '/opt/openclaw-bridge/startup.sh']);
});

test('a truncated script is refused rather than written over a working one', () => {
  assert.equal(isPlausibleStartupScript('#!/bin/bash\necho hi'), false);
  assert.equal(isPlausibleStartupScript('#!/bin/bash\n' + 'x'.repeat(MIN_PLAUSIBLE_LENGTH)), false,
    'length alone is not enough — required markers must be present');
});

test('a script missing its shebang or required markers is refused', () => {
  const long = 'x'.repeat(MIN_PLAUSIBLE_LENGTH);
  assert.equal(isPlausibleStartupScript(`GATEWAY_PORT node dist/index.js gateway ${long}`), false, 'no shebang');
  assert.equal(isPlausibleStartupScript(`#!/bin/bash\nGATEWAY_PORT ${long}`), false, 'no gateway invocation');
  assert.equal(isPlausibleStartupScript(`#!/bin/bash\nnode dist/index.js gateway ${long}`), false, 'no port handling');
});

test('non-string input is refused', () => {
  for (const value of [undefined, null, 42, {}, []]) {
    assert.equal(isPlausibleStartupScript(value), false);
  }
});

test('readCanonicalStartupScript returns the first plausible candidate', () => {
  const good = `#!/bin/bash\nGATEWAY_PORT=1\nnode dist/index.js gateway\n${'x'.repeat(MIN_PLAUSIBLE_LENGTH)}`;
  const result = readCanonicalStartupScript({
    moduleDir: '/opt/openclaw-bridge/lib',
    existsSync: () => true,
    readFileSync: () => good,
  });
  assert.equal(result.path, '/opt/openclaw-bridge/startup.sh');
  assert.equal(result.text, good);
});

test('readCanonicalStartupScript returns null when nothing usable exists', () => {
  assert.equal(readCanonicalStartupScript({
    moduleDir: '/nowhere/lib', existsSync: () => false, readFileSync: () => '',
  }), null);
});

test('readCanonicalStartupScript returns null rather than a stale-looking script', () => {
  // The whole point: no canonical source means no write, not a downgrade.
  assert.equal(readCanonicalStartupScript({
    moduleDir: '/opt/openclaw-bridge/lib',
    existsSync: () => true,
    readFileSync: () => '#!/bin/bash\necho too short',
  }), null);
});

test('a read failure falls through to the next candidate instead of throwing', () => {
  const good = `#!/bin/bash\nGATEWAY_PORT=1\nnode dist/index.js gateway\n${'x'.repeat(MIN_PLAUSIBLE_LENGTH)}`;
  let call = 0;
  const result = readCanonicalStartupScript({
    moduleDir: '/a/lib',
    existsSync: () => true,
    readFileSync: () => {
      call += 1;
      if (call === 1) throw new Error('EACCES');
      return good;
    },
  });
  assert.equal(result.text, good);
});
