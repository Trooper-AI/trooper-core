import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_STATUS_BULK_MAX_KEYS,
  parseSessionStatusKeys,
  filterSessionsByKeys,
} from './session-status-bulk.mjs';

test('parse rejects empty input and over-cap key lists', () => {
  assert.equal(parseSessionStatusKeys('').ok, false);
  assert.equal(parseSessionStatusKeys('  ,  ,').ok, false);
  const tooMany = Array.from({ length: SESSION_STATUS_BULK_MAX_KEYS + 1 }, (_, i) => `k${i}`).join(',');
  assert.equal(parseSessionStatusKeys(tooMany).ok, false);
});

test('parse trims, drops empties, and dedupes', () => {
  const parsed = parseSessionStatusKeys(' a , b ,, a ');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.keys, ['a', 'b']);
});

test('filter matches rows by key across the list result shapes', () => {
  const rows = [
    { key: 'a', status: 'Active', runId: 'r1' },
    { sessionKey: 'b', state: 'idle', updatedAt: 5 },
    { key: 'c', status: 'completed' },
  ];
  for (const shape of [{ sessions: rows }, { rows }, rows]) {
    const sessions = filterSessionsByKeys(shape, ['a', 'b', 'missing']);
    assert.deepEqual(sessions, [
      { key: 'a', status: 'active', runId: 'r1' },
      { key: 'b', status: 'idle', updatedAt: 5 },
    ]);
  }
});

test('filter tolerates junk rows and unknown statuses', () => {
  const sessions = filterSessionsByKeys({ sessions: [null, {}, { key: 'a' }] }, ['a']);
  assert.deepEqual(sessions, [{ key: 'a', status: 'unknown' }]);
});
