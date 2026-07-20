import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const bridgeSource = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');

test('long gateway plugin operations run outside the bridge event loop', () => {
 assert.match(bridgeSource, /new Worker\(new URL\('\.\/lib\/gateway-plugin-worker\.mjs'/);
 assert.match(bridgeSource, /app\.post\('\/gateway\/plugins\/install-package', async/);
 assert.match(bridgeSource, /await runGatewayPluginWorker\('install-package'/);
 assert.doesNotMatch(
  bridgeSource,
  /app\.post\('\/gateway\/plugins\/install-package'[\s\S]{0,500}installOpenClawNpmPlugin\([^)]*execSync/,
 );
});

test('gateway plugin worker has a bounded lifetime', () => {
 assert.match(bridgeSource, /worker\.terminate\(\)/);
 assert.match(bridgeSource, /GATEWAY_PLUGIN_WORKER_TIMEOUT/);
});

test('admin restart-services also restarts the Trooper org runtime', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');
  const restartBlock = source.slice(source.indexOf("app.post('/admin/restart-services'"), source.indexOf("app.post('/admin/restart-services'") + 3500);
  assert.match(restartBlock, /systemctl restart \$\{unit\}/);
  assert.match(restartBlock, /'trooper-org-runtime', 'openclaw-poller'/);
});
