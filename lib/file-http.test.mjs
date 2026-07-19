import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWeakFileEtag, getFileContentType, ifRangeAllowsRange } from './file-http.mjs';

test('maps common workspace file types to browser-safe MIME types', () => {
  assert.equal(getFileContentType('voice.m4a'), 'audio/mp4');
  assert.equal(getFileContentType('report.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(getFileContentType('table.tsv?download=1'), 'text/tab-separated-values; charset=utf-8');
  assert.equal(getFileContentType('bundle.unknown'), 'application/octet-stream');
});

test('builds stable validators and honors If-Range', () => {
  const etag = buildWeakFileEtag(4096, 1_700_000_000_000);
  assert.equal(ifRangeAllowsRange(etag, { etag, modifiedMs: 1_700_000_000_000 }), true);
  assert.equal(ifRangeAllowsRange('W/\"stale\"', { etag, modifiedMs: 1_700_000_000_000 }), false);
  assert.equal(ifRangeAllowsRange(new Date(1_700_000_001_000).toUTCString(), { etag, modifiedMs: 1_700_000_000_000 }), true);
});
