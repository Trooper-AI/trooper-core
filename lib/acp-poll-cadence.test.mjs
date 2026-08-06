import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FIRST_PAGE_SIZE,
  SUBSEQUENT_PAGE_SIZE,
  clampDelayToDeadline,
  estimatePollCount,
  nextPollDelayMs,
  pollPageSize,
} from './acp-poll-cadence.mjs';

test('the fast common case is unchanged: 200 ms for the first two seconds', () => {
  // A reply that lands quickly must be noticed exactly as fast as before this change.
  for (const elapsed of [0, 100, 999, 1_999]) {
    assert.equal(nextPollDelayMs(elapsed), 200);
  }
});

test('cadence backs off as the wait lengthens', () => {
  assert.equal(nextPollDelayMs(2_000), 500);
  assert.equal(nextPollDelayMs(9_999), 500);
  assert.equal(nextPollDelayMs(10_000), 1_000);
  assert.equal(nextPollDelayMs(59_999), 1_000);
  assert.equal(nextPollDelayMs(60_000), 2_000);
  assert.equal(nextPollDelayMs(300_000), 5_000);
  assert.equal(nextPollDelayMs(7_200_000), 5_000);
});

test('the delay never decreases as time passes', () => {
  let previous = 0;
  for (let elapsed = 0; elapsed <= 400_000; elapsed += 1_000) {
    const delay = nextPollDelayMs(elapsed);
    assert.ok(delay >= previous, `delay dropped at ${elapsed}ms`);
    previous = delay;
  }
});

test('negative, zero and malformed elapsed values fall back to the fastest cadence', () => {
  for (const elapsed of [-1, 0, NaN, undefined, null, 'nope']) {
    assert.equal(nextPollDelayMs(elapsed), 200);
  }
});

test('a delay is clamped so the wait never overshoots its deadline', () => {
  // Sleeping 5s with 300ms left would report the timeout later than the caller was promised.
  assert.equal(clampDelayToDeadline(5_000, 29_700, 30_000), 300);
  assert.equal(clampDelayToDeadline(200, 100, 30_000), 200);
});

test('clamping returns zero once the deadline has passed', () => {
  assert.equal(clampDelayToDeadline(5_000, 30_000, 30_000), 0);
  assert.equal(clampDelayToDeadline(5_000, 31_000, 30_000), 0);
  assert.equal(clampDelayToDeadline(5_000, 0, NaN), 0);
});

test('the first page is wide for the baseline, later pages are narrow', () => {
  assert.equal(pollPageSize(0), FIRST_PAGE_SIZE);
  assert.equal(pollPageSize(1), SUBSEQUENT_PAGE_SIZE);
  assert.equal(pollPageSize(99), SUBSEQUENT_PAGE_SIZE);
  assert.ok(SUBSEQUENT_PAGE_SIZE < FIRST_PAGE_SIZE);
});

test('a 30s control command still polls often enough to feel instant', () => {
  const polls = estimatePollCount(30_000);
  assert.ok(polls > 20, `expected a responsive early cadence, got ${polls} polls`);
  assert.ok(polls < 60, `expected far fewer than the original 150, got ${polls}`);
});

test('a 2-hour steer drops from ~36,000 polls to under 2,000', () => {
  // This is the whole point of the change: runAcpSteerAndPublish passes a 2-hour timeout.
  const twoHours = 2 * 60 * 60 * 1000;
  const original = twoHours / 200;
  const polls = estimatePollCount(twoHours);
  assert.equal(original, 36_000);
  assert.ok(polls < 2_000, `expected under 2000 polls, got ${polls}`);
  assert.ok(original / polls > 20, `expected a >20x reduction, got ${(original / polls).toFixed(1)}x`);
});

test('messages fetched over a long steer drop by roughly two orders of magnitude', () => {
  // Measured at ~86x with the current schedule and page sizes. The bar is set below that so the
  // test pins the property (a large reduction) rather than an exact tuning of the constants.
  const twoHours = 2 * 60 * 60 * 1000;
  const originalMessages = (twoHours / 200) * 150;
  const polls = estimatePollCount(twoHours);
  const newMessages = FIRST_PAGE_SIZE + (polls - 1) * SUBSEQUENT_PAGE_SIZE;
  assert.ok(
    originalMessages / newMessages > 50,
    `expected >50x fewer messages, got ${(originalMessages / newMessages).toFixed(0)}x`,
  );
});

test('estimatePollCount terminates for zero and negative timeouts', () => {
  assert.equal(estimatePollCount(0), 0);
  assert.equal(estimatePollCount(-1), 0);
});
