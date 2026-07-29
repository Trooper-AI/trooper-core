import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../', import.meta.url);

function read(relativePath) {
  return fs.readFileSync(new URL(relativePath, root), 'utf8');
}

test('gateway startup scripts keep OpenClaw state private', () => {
  for (const relativePath of ['entrypoint.sh', 'startup.sh', 'acpx-bootstrap.sh', 'setup-openclaw-full.sh']) {
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

test('ACPX is installed and verified before an ACP-enabled gateway starts', () => {
  const bootstrap = read('acpx-bootstrap.sh');
  const entrypoint = read('entrypoint.sh');
  const startup = read('startup.sh');
  const dockerfile = read('Dockerfile');

  assert.match(bootstrap, /plugins inspect acpx --runtime --json/);
  assert.match(bootstrap, /plugins install @openclaw\/acpx/);
  assert.match(bootstrap, /node_modules\/@openclaw\/acpx\/package\.json/);
  assert.match(bootstrap, /plugin\?\.status === "loaded"/);
  assert.match(bootstrap, /could not install @openclaw\/acpx/);
  assert.match(bootstrap, /failed runtime inspection after installation/);
  assert.doesNotMatch(bootstrap, /\bchown\b/i, 'ACPX stays owned by the node runtime user');
  assert.ok(
    bootstrap.indexOf('plugins inspect acpx --runtime --json') < bootstrap.indexOf('plugins install @openclaw/acpx'),
    'bootstrap must inspect before it attempts an install',
  );
  assert.match(dockerfile, /COPY acpx-bootstrap\.sh \/opt\/acpx-bootstrap\.sh/);
  assert.match(entrypoint, /\/opt\/acpx-bootstrap\.sh/);
  assert.match(entrypoint, /TROOPER_ACPX_BOOTSTRAPPED=1/);
  assert.match(startup, /TROOPER_ACPX_BOOTSTRAPPED/);
  assert.match(startup, /\/opt\/acpx-bootstrap\.sh/);

  const setup = read('setup-openclaw-full.sh');
  assert.match(setup, /entrypoint: \["\/bin\/bash", "\/opt\/entrypoint\.sh"\]/);
  assert.match(setup, /startup\.sh:\/opt\/startup\.sh:ro/);
  assert.doesNotMatch(setup, /chown -R root:root \/home\/node\/\.openclaw\/npm/);
});

test('bridge auth profile writes and backups use owner-only permissions', () => {
  const source = read('index.mjs');
  assert.match(source, /writeFileSync\(target \+ '\.bak', existing, \{ mode: 0o600 \}\)/);
  assert.match(source, /chown 1000:1000 \$\{target\}[\s\S]{0,80}chmod 600 \$\{target\}/);
  assert.doesNotMatch(source, /chmod 664 \$\{target\}/);
});
