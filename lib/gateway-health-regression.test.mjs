import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bridgeSource = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');

test('gateway health reads cached container state and refreshes Docker asynchronously', () => {
  const start = bridgeSource.indexOf('function readGatewayContainerStatus');
  const end = bridgeSource.indexOf('\nlet gatewayOutageState', start);
  const source = bridgeSource.slice(start, end);

  assert.ok(start >= 0 && end > start, 'gateway container status source must be present');
  assert.match(source, /gatewayContainerStatusCache/);
  assert.doesNotMatch(source, /docker inspect/);

  const refreshStart = bridgeSource.indexOf('function refreshGatewayContainerStatus');
  const refreshEnd = bridgeSource.indexOf('\nfunction readGatewayContainerStatus', refreshStart);
  const refreshSource = bridgeSource.slice(refreshStart, refreshEnd);
  assert.match(refreshSource, /execFile\(/);
  assert.doesNotMatch(refreshSource, /execSync\(/);
});

test('automatic outage snapshots never run blocking diagnostic commands', () => {
  const start = bridgeSource.indexOf('function maybeCaptureGatewayProblemSnapshot');
  const end = bridgeSource.indexOf("\napp.get('/health'", start);
  const source = bridgeSource.slice(start, end);

  assert.ok(start >= 0 && end > start, 'automatic snapshot source must be present');
  assert.match(source, /includeCommands:\s*false/);
  assert.doesNotMatch(source, /heavy:\s*true/);
});

test('gateway repair routes never block the event loop with synchronous Docker commands', () => {
  const patchStart = bridgeSource.indexOf("app.post('/gateway/patch-auth'");
  const restartStart = bridgeSource.indexOf("app.post('/gateway/restart'");
  const restartEnd = bridgeSource.indexOf("\napp.post('/gateway/plugins/sync'", restartStart);
  const patchSource = bridgeSource.slice(patchStart, restartStart);
  const restartSource = bridgeSource.slice(restartStart, restartEnd);

  assert.ok(patchStart >= 0 && restartStart > patchStart && restartEnd > restartStart);
  assert.match(patchSource, /async \(req, res\)/);
  assert.match(restartSource, /async \(req, res\)/);
  assert.doesNotMatch(patchSource, /execSync\(/);
  assert.doesNotMatch(restartSource, /execSync\(/);
  assert.match(restartSource, /heavy:\s*false/);
  assert.match(restartSource, /includeCommands:\s*false/);
});

test('gateway watchdog leaves intentional reconnects alone', () => {
  const start = bridgeSource.indexOf('function startGatewayProcessWatchdog(');
  const end = bridgeSource.indexOf('\nexport { bridgeWS }', start);
  const source = bridgeSource.slice(start, end);

  assert.ok(start >= 0 && end > start, 'gateway watchdog source must be present');
  const reconnectGuard = source.indexOf('gateway.expectedReconnectUntil');
  const failureCount = source.indexOf('consecutiveFailures += 1');
  assert.ok(reconnectGuard >= 0 && failureCount > reconnectGuard);
  assert.match(source, /consecutiveFailures\s*=\s*0;\s*return;/);
});

test('startup plugin retry waits until the gateway reconnect grace has elapsed', () => {
  const start = bridgeSource.indexOf('setTimeout(() => {\n  void syncBridgeOwnedGatewayPluginsAsync(\'startup-retry\')');
  const end = bridgeSource.indexOf('\n // Soft-start:', start);
  const source = bridgeSource.slice(start, end);

  assert.ok(start >= 0 && end > start, 'startup plugin retry timer must be present');
  assert.match(source, /Math\.max\(90_000, Number\(process\.env\.OPENCLAW_PLUGIN_STARTUP_RETRY_MS \|\| 90_000\)\)/);
});
