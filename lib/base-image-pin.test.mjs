import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { OPENCLAW_BASE_IMAGE } from './base-image-pin.mjs';

const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');

test('base image is pinned by immutable digest, not a floating tag', () => {
  assert.match(OPENCLAW_BASE_IMAGE, /^ghcr\.io\/openclaw\/openclaw@sha256:[0-9a-f]{64}$/);
});

test('Dockerfile ARG default and the exported constant are in lockstep', () => {
  const arg = dockerfile.match(/^ARG OPENCLAW_BASE_IMAGE=(\S+)$/m);
  assert.ok(arg, 'Dockerfile must declare ARG OPENCLAW_BASE_IMAGE=<pinned ref>');
  assert.equal(arg[1], OPENCLAW_BASE_IMAGE);
});

test('Dockerfile FROM consumes the pinned ARG and no floating base remains', () => {
  assert.match(dockerfile, /^FROM \$\{OPENCLAW_BASE_IMAGE\}$/m);
  assert.doesNotMatch(dockerfile, /^FROM ghcr\.io\/openclaw\/openclaw:latest$/m);
});
