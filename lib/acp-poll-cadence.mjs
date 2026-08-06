// Polling cadence and page size for `runGatewaySlashCommand`'s reply wait.
//
// The original loop fetched 150 history messages every 200 ms for the whole timeout, and diffed
// the full set each pass. That is tolerable for a 30 s control command but ruinous for a steer:
// `runAcpSteerAndPublish` passes a 2-hour timeout, so an active task drove roughly
//   2h / 200ms = 36,000 fetches x 150 messages
// per session, purely to notice a reply that almost always lands in the first second.
//
// This module makes the wait adaptive: keep the fast cadence for the first couple of seconds
// where the reply usually arrives, then back off. It also narrows the page after the first pass —
// the baseline needs breadth, subsequent passes only need to catch new messages at the tail.
//
// Same total wall-clock and the same fast common case, roughly 20x fewer gateway round trips on a
// long steer. Pure and dependency-free so the schedule can be asserted without a live gateway.

// Elapsed-time thresholds, ascending, with the delay to use once past each. The first entry keeps
// the original 200 ms cadence, so a reply arriving quickly is noticed exactly as fast as before.
const CADENCE_STEPS = Object.freeze([
  { afterMs: 0, delayMs: 200 },
  { afterMs: 2_000, delayMs: 500 },
  { afterMs: 10_000, delayMs: 1_000 },
  { afterMs: 60_000, delayMs: 2_000 },
  { afterMs: 300_000, delayMs: 5_000 },
]);

// Breadth on the first pass, to establish the "already seen" baseline.
export const FIRST_PAGE_SIZE = 150;

// Narrower afterwards. New assistant messages land at the tail, and with a delay of at most 5 s
// between passes, 40 is far more headroom than a single turn can produce.
export const SUBSEQUENT_PAGE_SIZE = 40;

// Delay before the next poll, given how long the wait has been running.
export function nextPollDelayMs(elapsedMs, { steps = CADENCE_STEPS } = {}) {
  const elapsed = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;
  let delay = steps[0].delayMs;
  for (const step of steps) {
    if (elapsed >= step.afterMs) delay = step.delayMs;
    else break;
  }
  return delay;
}

// Never sleep past the deadline: a 5 s delay with 300 ms left would overshoot the caller's timeout
// and report a timeout later than promised. Returns 0 when the deadline has passed.
export function clampDelayToDeadline(delayMs, elapsedMs, timeoutMs) {
  const remaining = Number(timeoutMs) - Number(elapsedMs);
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  return Math.max(0, Math.min(Number(delayMs) || 0, remaining));
}

export function pollPageSize(pollIndex) {
  return Number(pollIndex) > 0 ? SUBSEQUENT_PAGE_SIZE : FIRST_PAGE_SIZE;
}

// Total polls a wait of `timeoutMs` performs under this schedule. Used by the tests to pin the
// improvement, and useful for reasoning about gateway load.
export function estimatePollCount(timeoutMs, options = {}) {
  let elapsed = 0;
  let polls = 0;
  while (elapsed < timeoutMs) {
    polls += 1;
    const delay = clampDelayToDeadline(nextPollDelayMs(elapsed, options), elapsed, timeoutMs);
    if (delay <= 0) break;
    elapsed += delay;
  }
  return polls;
}
