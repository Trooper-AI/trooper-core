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
  assert.match(middleware, /token !== BRIDGE_AUTH_TOKEN/);
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
