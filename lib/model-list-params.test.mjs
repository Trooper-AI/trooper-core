import test from 'node:test';
import assert from 'node:assert/strict';
import { modelListParamsForRefresh } from './model-list-params.mjs';

test('model catalog refresh discovers current provider models dynamically', () => {
  assert.deepEqual(modelListParamsForRefresh(true), { view: 'all', refresh: true });
});

test('routine model catalog reads remain scoped to configured models', () => {
  assert.deepEqual(modelListParamsForRefresh(false), { view: 'configured' });
});
