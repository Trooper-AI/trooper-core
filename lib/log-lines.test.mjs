import test from 'node:test';
import assert from 'node:assert/strict';

import {
  annotateUntimestampedLogLines,
  sortLogLinesChronologically,
} from './log-lines.mjs';

test('sortLogLinesChronologically keeps Boot markers with their journal era', () => {
  const sorted = sortLogLinesChronologically([
    '2026-08-06T11:48:30.000Z recent gateway',
    '-- Boot 8c6b4af48e0a437a8cdbf03a748e62e1 --',
    '2026-08-02T08:55:54+00:00 started bridge',
    '2026-08-06T11:48:31.000Z newer gateway',
  ]);
  assert.match(sorted[0], /Boot 8c6b4af48e0a437a8cdbf03a748e62e1/);
  assert.match(sorted[1], /started bridge/);
  assert.match(sorted[2], /recent gateway/);
  assert.match(sorted[3], /newer gateway/);
});

test('annotateUntimestampedLogLines stamps bare Boot markers', () => {
  const annotated = annotateUntimestampedLogLines([
    '-- Boot abcdef0123456789abcdef0123456789 --',
    '2026-08-02T08:55:54+00:00 started',
  ]);
  assert.match(annotated[0], /^2026-08-02T08:55:54\.000Z -- Boot /);
});
