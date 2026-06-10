import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, root), 'utf8');
}

test('gateway startup scripts keep OpenClaw state private', () => {
  for (const relativePath of ['entrypoint.sh', 'startup.sh', 'setup-openclaw-full.sh']) {
    const source = read(relativePath);
    assert.doesNotMatch(source, /chmod 66[46] .*openclaw/i, relativePath);
    assert.doesNotMatch(source, /chmod 777 .*openclaw/i, relativePath);
    assert.doesNotMatch(source, /find .*\.openclaw .*chmod 66[46]/i, relativePath);
  }

  const setup = read('setup-openclaw-full.sh');
  assert.match(setup, /User=root[\s\S]{0,300}ExecStart=\/usr\/bin\/node \/opt\/openclaw-bridge\/index\.mjs/);
  assert.match(setup, /find \/opt\/openclaw-data\/config -type d -exec chmod 700/);
  assert.match(setup, /find \/opt\/openclaw-data\/config -name '\*\.json' -exec chmod 600/);
});

test('bridge auth profile writes and backups use owner-only permissions', () => {
  const source = read('index.mjs');
  assert.match(source, /writeFileSync\(target \+ '\.bak', existing, \{ mode: 0o600 \}\)/);
  assert.match(source, /chown 1000:1000 \$\{target\}[\s\S]{0,80}chmod 600 \$\{target\}/);
  assert.doesNotMatch(source, /chmod 664 \$\{target\}/);
});
