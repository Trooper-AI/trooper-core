import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import express from 'express';

const require = createRequire(import.meta.url);
const expressVersion = require('express/package.json').version;

const NAMED_ROUTES = [
  '/files/{*filePath}',
  '/desktop-api/{*subpath}',
  '/api/proxy/{*path}',
  '/runtime/workspaces/:slotId/proxy/{*suffix}',
  '/api/apps/:slug/{*assetPath}',
];

test('Express 5 named wildcards used by the bridge register', () => {
  const app = express();
  for (const route of NAMED_ROUTES) {
    assert.doesNotThrow(() => app.get(route, () => {}), route);
  }
});

test('unnamed Express 5 wildcards that used to crash snapshot /health are gone', () => {
  if (!expressVersion.startsWith('5.')) {
    return;
  }
  for (const route of ['/files/*', '/desktop-api/*', '/api/proxy/:path(*)']) {
    const app = express();
    assert.throws(() => app.get(route, () => {}), /parameter name|Unexpected \(/);
  }
});
