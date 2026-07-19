import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSingleByteRange } from './byte-range.mjs';

test('parses open, bounded, and suffix byte ranges', () => {
  assert.deepEqual(parseSingleByteRange('bytes=10-19', 100), { start: 10, end: 19, length: 10 });
  assert.deepEqual(parseSingleByteRange('bytes=90-', 100), { start: 90, end: 99, length: 10 });
  assert.deepEqual(parseSingleByteRange('bytes=-8', 100), { start: 92, end: 99, length: 8 });
});

test('rejects invalid and unsatisfiable byte ranges', () => {
  assert.deepEqual(parseSingleByteRange('bytes=100-', 100), { invalid: true });
  assert.deepEqual(parseSingleByteRange('bytes=20-10', 100), { invalid: true });
  assert.deepEqual(parseSingleByteRange('bytes=0-1,5-6', 100), { invalid: true });
});
