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

test('OpenClaw config and managed plugins converge before gateway startup', () => {
  const bootstrap = read('acpx-bootstrap.sh');
  const entrypoint = read('entrypoint.sh');
  const startup = read('startup.sh');
  const dockerfile = read('Dockerfile');
  const doctor = read('doctor-migrate.sh');
  const configStage = read('openclaw-config-stage.mjs');

  assert.match(bootstrap, /ACPX_PLUGIN_SPEC="npm:@openclaw\/acpx@\$ACPX_PLUGIN_VERSION"/);
  assert.match(bootstrap, /plugin-version '\$ACPX_STATE_DIR' '\@openclaw\/acpx'/);
  assert.match(bootstrap, /plugins install '\$ACPX_PLUGIN_SPEC'/);
  assert.doesNotMatch(bootstrap, /node dist\/index\.js plugins inspect/);
  assert.match(bootstrap, /does not match the gateway image pin/);
  assert.match(bootstrap, /could not install @openclaw\/acpx/);
  assert.doesNotMatch(bootstrap, /\bchown\b/i, 'ACPX stays owned by the node runtime user');
  assert.match(doctor, /config validate/);
  assert.match(doctor, /doctor --fix --non-interactive/);
  assert.match(doctor, /\.trooper-doctor-backups/);
  assert.match(doctor, /chmod 600/);
  assert.match(doctor, /node '\$CONFIG_STAGE_TOOL' park/);
  assert.match(doctor, /node '\$CONFIG_STAGE_TOOL' restore/);
  assert.match(doctor, /npm:\@openclaw\/lobster/);
  assert.match(configStage, /delete acp\.maxConcurrentSessions/);
  assert.match(configStage, /writeAtomic\(sidecarOrStateRoot, saved, 0o600\)/);
  assert.match(doctor, /exit 1/);
  assert.ok(
    startup.indexOf('/opt/doctor-migrate.sh') < startup.indexOf('/opt/acpx-bootstrap.sh'),
    'config migration must finish before ACPX validates the OpenClaw config',
  );
  assert.match(dockerfile, /COPY doctor-migrate\.sh \/opt\/doctor-migrate\.sh/);
  assert.match(dockerfile, /COPY acpx-bootstrap\.sh \/opt\/acpx-bootstrap\.sh/);
  assert.match(dockerfile, /COPY openclaw-config-stage\.mjs \/opt\/openclaw-config-stage\.mjs/);
  assert.doesNotMatch(entrypoint, /\/opt\/acpx-bootstrap\.sh/);
  assert.match(startup, /TROOPER_ACPX_BOOTSTRAPPED/);
  assert.match(startup, /\/opt\/acpx-bootstrap\.sh/);

  const setup = read('setup-openclaw-full.sh');
  assert.match(setup, /entrypoint: \["\/bin\/bash", "\/opt\/entrypoint\.sh"\]/);
  assert.match(setup, /startup\.sh:\/opt\/startup\.sh:ro/);
  assert.doesNotMatch(setup, /chown -R root:root \/home\/node\/\.openclaw\/npm/);

  const generatedStartup = setup.match(/cat > \/opt\/openclaw-data\/startup\.sh << 'STARTUP'\n([\s\S]*?)\nSTARTUP/);
  assert.ok(generatedStartup, 'managed setup must define the mounted gateway startup script');
  const startupScript = generatedStartup[1];
  assert.match(startupScript, /\/opt\/doctor-migrate\.sh/);
  assert.match(startupScript, /\/opt\/acpx-bootstrap\.sh/);
  assert.ok(
    startupScript.indexOf('/opt/doctor-migrate.sh') < startupScript.indexOf('/opt/acpx-bootstrap.sh')
      && startupScript.indexOf('/opt/acpx-bootstrap.sh') < startupScript.indexOf('node dist/index.js gateway'),
    'the mounted startup must migrate config, prepare ACPX, and only then launch the gateway',
  );
});

test('ACP config repair preserves settings while dropping the retired session limit', () => {
  const source = read('index.mjs');
  const setup = read('setup-openclaw-full.sh');
  assert.match(source, /removed retired acp\.maxConcurrentSessions/);
  assert.doesNotMatch(source, /allowedAgents:[\s\S]{0,120}maxConcurrentSessions/);
  assert.doesNotMatch(setup, /"maxConcurrentSessions": 3/);
});

test('bridge auth profile writes and backups use owner-only permissions', () => {
  const source = read('index.mjs');
  assert.match(source, /writeFileSync\(target \+ '\.bak', existing, \{ mode: 0o600 \}\)/);
  assert.match(source, /chown 1000:1000 \$\{target\}[\s\S]{0,80}chmod 600 \$\{target\}/);
  assert.doesNotMatch(source, /chmod 664 \$\{target\}/);
});
