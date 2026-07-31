import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';

const source = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');

test('workspace files and vision calls remain behind bridge authentication', () => {
  const middlewareStart = source.indexOf('// Auth middleware');
  const middlewareEnd = source.indexOf('// Firebase auth middleware');
  const middleware = source.slice(middlewareStart, middlewareEnd);

  assert.ok(middlewareStart >= 0);
  assert.ok(middlewareEnd > middlewareStart);
  assert.doesNotMatch(middleware, /req\.path\.startsWith\('\/files\/'\)/);
  assert.doesNotMatch(middleware, /req\.path === '\/files'/);
  assert.doesNotMatch(middleware, /req\.path === '\/llm\/vision'/);
  assert.doesNotMatch(middleware, /req\.path === '\/deploy-logs'/);
  assert.doesNotMatch(middleware, /req\.path === '\/deploy-logs-raw'/);
  assert.match(middleware, /evaluateBridgeAuth\(/);
  // The historical fail-open line must never return: an unset token used to
  // let every admin/gateway/config/debug route through unauthenticated.
  assert.doesNotMatch(middleware, /if \(!BRIDGE_AUTH_TOKEN\) return next\(\)/);
});

test('per-route bridge auth helper fails closed like the middleware', () => {
  const helperStart = source.indexOf('function requireBridgeAuth');
  const helperEnd = source.indexOf('app.post(\'/admin/ensure-local-model-auth\'', helperStart);
  const helper = source.slice(helperStart, helperEnd);

  assert.ok(helperStart >= 0);
  assert.ok(helperEnd > helperStart);
  assert.match(helper, /evaluateBridgeAuth\(/);
  assert.doesNotMatch(helper, /no token configured = dev mode/);
});

test('temporary provisioning log server requires the bridge token', () => {
  const setupSource = readFileSync(new URL('../setup-openclaw-full.sh', import.meta.url), 'utf8');

  assert.match(setupSource, /expected = 'Bearer \$BRIDGE_AUTH_TOKEN'/);
  assert.match(setupSource, /self\.headers\.get\('Authorization'\) == expected/);
  assert.match(setupSource, /elif self\.path=='\/deploy-logs':\n\s+if not self\.authorized\(\): return/);
  assert.match(setupSource, /elif self\.path=='\/deploy-logs-raw':\n\s+if not self\.authorized\(\): return/);
  assert.match(setupSource, /managed deployments require BRIDGE_AUTH_TOKEN/);
  assert.match(setupSource, /managed deployments require RUNTIME_AUTH_SECRET/);
});
