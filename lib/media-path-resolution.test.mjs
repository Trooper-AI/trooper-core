import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveHostMediaAlias } from './media-path-resolution.mjs';

test('a transcript MEDIA path resolves to the host-backed generated image before container lookup', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'trooper-media-path-'));
  const configMedia = path.join(root, 'config', 'media');
  const dataMedia = path.join(root, 'data', 'media');
  const relative = path.join('tool-image-generation', 'persian-cat.jpg');
  const hostFile = path.join(configMedia, relative);
  mkdirSync(path.dirname(hostFile), { recursive: true });
  writeFileSync(hostFile, 'image bytes');

  const resolved = resolveHostMediaAlias({
    requestedPath: `/home/node/.openclaw/media/${relative}`,
    mediaContainerRoot: '/home/node/.openclaw/media',
    mediaHostRoots: [configMedia, dataMedia],
    exists: (candidate) => candidate === hostFile,
  });

  assert.equal(resolved, hostFile);
});

test('host media aliases remain inside allowed roots and fall back when no host file exists', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'trooper-media-path-'));
  const configMedia = path.join(root, 'config', 'media');
  const outside = path.join(root, 'outside.jpg');

  assert.equal(resolveHostMediaAlias({
    requestedPath: '/home/node/.openclaw/media/../outside.jpg',
    mediaContainerRoot: '/home/node/.openclaw/media',
    mediaHostRoots: [configMedia],
    exists: () => true,
  }), null);
  assert.equal(resolveHostMediaAlias({
    requestedPath: '/home/node/.openclaw/media/tool-image-generation/missing.jpg',
    mediaContainerRoot: '/home/node/.openclaw/media',
    mediaHostRoots: [configMedia],
    exists: (candidate) => candidate === outside,
  }), null);
});
