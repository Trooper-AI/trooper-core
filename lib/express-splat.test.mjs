import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { joinExpressSplat, requestSplatPath } from './express-splat.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('joinExpressSplat uses slashes, not commas', () => {
  assert.equal(
    joinExpressSplat(['opt', 'openclaw-data', 'workspace', 'Channels', 'general', 'x.png']),
    'opt/openclaw-data/workspace/Channels/general/x.png',
  );
  assert.equal(joinExpressSplat('already/a/path'), 'already/a/path');
  assert.equal(joinExpressSplat(''), '');
});

test('requestSplatPath rebuilds the absolute file path Express 5 split apart', () => {
  assert.equal(
    requestSplatPath({
      filePath: ['opt', 'openclaw-data', 'workspace', 'Channels', 'general', 'screenshot-mobile.png'],
    }, 'filePath'),
    '/opt/openclaw-data/workspace/Channels/general/screenshot-mobile.png',
  );
  assert.equal(
    requestSplatPath({ filePath: 'Channels/general/index.html' }, 'filePath'),
    '/Channels/general/index.html',
  );
});

test('Express 5 /files/{*filePath} splat is an array and our joiner restores it', async () => {
  const app = express();
  app.get('/files/{*filePath}', (req, res) => {
    res.json({ requestedPath: requestSplatPath(req.params, 'filePath') });
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/files/opt/openclaw-data/workspace/Channels/general/x.png`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      requestedPath: '/opt/openclaw-data/workspace/Channels/general/x.png',
    });
  } finally {
    server.close();
  }
});

test('bridge file route does not String() the Express 5 splat array', () => {
  const index = readFileSync(join(root, 'index.mjs'), 'utf8');
  assert.match(index, /requestSplatPath\(req\.params, 'filePath'\)/);
  assert.equal(index.includes("String(req.params.filePath || req.params[0] || '')"), false);
  assert.equal(index.includes('${req.params.path}'), false);
});
