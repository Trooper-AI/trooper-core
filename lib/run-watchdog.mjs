/**
 * Orphan-run watchdog.
 *
 * Chat/task `runs` rows are created with status='running' and finalized only
 * by the promise that started them. When the bridge restarts mid-run, or the
 * gateway dies without a terminal frame (the "run finished, promise never
 * resolved, Trooper stuck 'Working' forever" case documented next to the
 * lifecycleResolveTimer in index.mjs), those rows stay 'running' forever and
 * nothing sweeps them. This watchdog periodically scans for runs with no
 * terminal whose last known activity is older than a threshold and closes
 * them with an explicit synthetic terminal — append-only, never rewriting or
 * deleting history (same honesty contract as lib/interrupted-tool-result.mjs).
 *
 * Activity sources, in order of trust:
 *   - an in-memory registry the chat/task handlers touch on every stream
 *     event (this process only — it does not survive a restart, which is
 *     exactly right: after a restart nothing owns the run);
 *   - the run_events table (rows exist only after a run finished, so for a
 *     stuck 'running' row this is usually empty);
 *   - runs.started_at as the floor.
 *
 * Two-tier threshold — the deadliest failure mode of a watchdog is killing a
 * LIVE run, so the policy is deliberately asymmetric:
 *   - a run this process OWNS (registry entry alive, handler awaiting) is only
 *     touched after ownedOrphanMs (default 60 min) of total silence — the chat
 *     lane deliberately disables the gateway inactivity timeout and a long
 *     tool call can be quiet for many minutes;
 *   - a DISOWNED row (no registry entry — typically another process's stranding
 *     or a pre-restart leftover) uses the standard orphanMs (default 10 min);
 *   - nothing at all is closed until this process has itself been up for the
 *     threshold (boot floor) — right after a restart we cannot distinguish a
 *     stranded row from a run the gateway is still streaming.
 *
 * Repair strategy per orphan:
 *   1. If this process still holds the run's pending gateway promise
 *      (sessionKey known from the registry), reject it via the injected
 *      resolvePendingRunExternally — the owning handler's existing failure
 *      path then writes the terminal state and notifies clients exactly like
 *      any real failure. Preferred: one writer, the existing one.
 *   2. If the run is owned but the pending could not be rejected (steer
 *      pendings with expectFinal:false, or a pending that just resolved and is
 *      mid post-processing), do NOTHING — the owner's finally block is the
 *      single writer and direct-closing would race it.
 *   3. Otherwise (disowned — typically after a bridge restart) close directly:
 *      append a synthetic `error` run_event marked { synthetic: true,
 *      syntheticKind } that no live path ever emits, flip the runs row to
 *      'failed', and broadcast agent:error + agent:typing_stop through the
 *      injected existing emit path so live UIs clear "Working" (broadcasts are
 *      skipped for runs older than a day; the close still happens).
 * A sweep repairs at most maxRepairsPerSweep runs (first-deploy stampede guard).
 *
 * Kill switch: TROOPER_RUN_WATCHDOG_MS <= 0 disables the scan entirely.
 * Clock, timers, sqlite handle, resolver, and broadcast are injected so the
 * whole repair loop is testable without the monolith.
 */

export const RUN_WATCHDOG_DEFAULT_INTERVAL_MS = 60_000;
export const RUN_ORPHAN_DEFAULT_MS = 10 * 60_000;
// Runs this process still owns (registry entry alive, handler awaiting) get a
// much larger threshold: the chat lane deliberately disables the gateway
// inactivity timeout, and a long tool call (build, browser wait) can be
// legitimately silent for many minutes. 10 minutes of silence is a normal
// build; an hour of total silence on an owned run is a stuck pending.
export const RUN_OWNED_ORPHAN_DEFAULT_MS = 60 * 60_000;
// One sweep never repairs more than this many runs (first-deploy stampede guard).
export const RUN_WATCHDOG_MAX_REPAIRS_PER_SWEEP = 25;
// Closes still happen for ancient strandings, but nobody needs an error toast
// about a run that started days ago.
export const RUN_WATCHDOG_BROADCAST_MAX_AGE_MS = 24 * 60 * 60_000;

// Marker no live emit path ever produces (live paths never set synthetic).
export const ORPHANED_RUN_CLOSE_KIND = 'orphaned_run_close';
export const ORPHANED_RUN_REASON = 'interrupted';
export const ORPHANED_RUN_MESSAGE =
  '[interrupted — this run stopped reporting activity and no terminal event was ever recorded. '
  + 'The bridge closed it so it no longer shows as running; check what actually happened before redoing anything with side effects.]';

// Synthetic run_events seqs start far above anything a live flush produces so
// a watchdog row can never collide with a late flush on UNIQUE(run_id, seq)
// (task-handler inserts are not wrapped per-row — a collision there would
// fail the whole task lane).
export const SYNTHETIC_RUN_EVENT_SEQ_BASE = 900_000;

/** Env knobs. intervalMs <= 0 means "watchdog disabled". */
export function resolveRunWatchdogConfig(env = process.env) {
  const parse = (name, fallback) => {
    const rawValue = env?.[name];
    // An empty/whitespace value (common in .env templates) must mean "unset",
    // not Number('') === 0 — that footgun would collapse the threshold.
    if (rawValue == null || String(rawValue).trim() === '') return fallback;
    const raw = Number(rawValue);
    return Number.isFinite(raw) ? raw : fallback;
  };
  const intervalMs = parse('TROOPER_RUN_WATCHDOG_MS', RUN_WATCHDOG_DEFAULT_INTERVAL_MS);
  const orphanMs = Math.max(60_000, parse('TROOPER_RUN_ORPHAN_MS', RUN_ORPHAN_DEFAULT_MS));
  const ownedOrphanMs = Math.max(
    orphanMs,
    parse('TROOPER_RUN_OWNED_ORPHAN_MS', RUN_OWNED_ORPHAN_DEFAULT_MS),
  );
  return { intervalMs, orphanMs, ownedOrphanMs, enabled: intervalMs > 0 };
}

/**
 * In-memory liveness registry. The chat/task handlers mark their bridge runId
 * on start, touch it on every stream event, and clear it in their finally —
 * mirroring lib/cf-tracker.mjs's in-flight set, and like it deliberately not
 * persisted: after a restart no process owns the run, so no entry is correct.
 */
export function createRunActivityRegistry({ now = Date.now } = {}) {
  const entries = new Map(); // runId -> { sessionKey, startedAt, lastTouchedAt, ...meta }
  return {
    markStarted(runId, meta = {}) {
      if (!runId) return;
      entries.set(String(runId), { ...meta, startedAt: now(), lastTouchedAt: now() });
    },
    touch(runId) {
      if (!runId) return;
      const entry = entries.get(String(runId));
      if (entry) entry.lastTouchedAt = now();
    },
    markEnded(runId) {
      if (!runId) return;
      entries.delete(String(runId));
    },
    get(runId) {
      return runId ? entries.get(String(runId)) || null : null;
    },
    prune(maxAgeMs = 24 * 60 * 60 * 1000) {
      const cutoff = now() - maxAgeMs;
      for (const [runId, entry] of entries) {
        if ((entry.lastTouchedAt || 0) < cutoff) entries.delete(runId);
      }
    },
    get size() { return entries.size; },
  };
}

// Shared default registry — index.mjs wires the watchdog against it and the
// chat/task handlers call the module-level helpers below (cf-tracker style).
export const defaultRunActivityRegistry = createRunActivityRegistry();
export function markRunStarted(runId, meta = {}) { defaultRunActivityRegistry.markStarted(runId, meta); }
export function touchRunActivity(runId) { defaultRunActivityRegistry.touch(runId); }
export function markRunEnded(runId) { defaultRunActivityRegistry.markEnded(runId); }

/** Pure builder for the synthetic terminal run_event ('error' is the real stream vocabulary chat-handler already consumes). */
export function buildOrphanRunCloseEvent({ runId = null, sessionKey = null, startedAt = null, lastActivityAt = null, now = Date.now() } = {}) {
  return {
    event: 'error',
    data: {
      eventType: 'error',
      error: ORPHANED_RUN_MESSAGE,
      reason: ORPHANED_RUN_REASON,
      synthetic: true,
      syntheticKind: ORPHANED_RUN_CLOSE_KIND,
      source: 'run_watchdog',
      runId: runId || null,
      sessionKey: sessionKey || null,
      startedAt: startedAt || null,
      lastActivityAt: lastActivityAt || null,
      time: now,
    },
    timestamp: now,
  };
}

export function createRunWatchdog({
  sqlite,
  registry = defaultRunActivityRegistry,
  now = Date.now,
  intervalMs = RUN_WATCHDOG_DEFAULT_INTERVAL_MS,
  orphanMs = RUN_ORPHAN_DEFAULT_MS,
  ownedOrphanMs = RUN_OWNED_ORPHAN_DEFAULT_MS,
  maxRepairsPerSweep = RUN_WATCHDOG_MAX_REPAIRS_PER_SWEEP,
  broadcastMaxAgeMs = RUN_WATCHDOG_BROADCAST_MAX_AGE_MS,
  resolvePendingRunExternally = null,
  broadcast = null,
  log = console,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!sqlite) throw new Error('createRunWatchdog requires a sqlite handle');

  // Boot floor: right after a restart the registry is empty and run_events says
  // nothing, but the gateway may still be streaming a run this (new) process
  // never owned. Nothing may be closed until this process has itself been up
  // for the orphan threshold — the freshest activity signal we have is "we
  // just booted and cannot know yet".
  const bootAt = now();

  const selectStale = sqlite.prepare(
    `SELECT id, agent_id, agent_name, channel, source, started_at
     FROM runs WHERE status = 'running' AND started_at <= ?`,
  );
  const selectEventStats = sqlite.prepare(
    'SELECT MAX(timestamp) AS last_ts, MAX(seq) AS max_seq FROM run_events WHERE run_id = ?',
  );
  const insertEvent = sqlite.prepare(
    'INSERT INTO run_events (run_id, seq, event, data, timestamp) VALUES (?, ?, ?, ?, ?)',
  );
  const closeRun = sqlite.prepare(
    `UPDATE runs SET status = 'failed', finished_at = ?, duration_ms = ?, error = ?
     WHERE id = ? AND status = 'running'`,
  );

  let timer = null;

  const warn = (msg, meta) => { try { log.warn(msg, meta); } catch { /* best effort */ } };
  const info = (msg, meta) => { try { (log.info || log.log || (() => {})).call(log, msg, meta); } catch { /* best effort */ } };

  /** One sweep. Returns the repairs performed (for logging/tests). */
  function scanOnce() {
    const nowMs = now();
    const repairs = [];
    let candidates = [];
    try {
      candidates = selectStale.all(nowMs - orphanMs);
    } catch (err) {
      warn(`[run-watchdog] scan query failed: ${err?.message || err}`);
      return repairs;
    }

    for (const run of candidates) {
      if (repairs.length >= maxRepairsPerSweep) {
        info(`[run-watchdog] repair cap (${maxRepairsPerSweep}) reached this sweep; remaining candidates wait for the next sweep`);
        break;
      }
      try {
        const stats = selectEventStats.get(run.id) || {};
        const memory = registry.get(run.id);
        const lastActivityAt = Math.max(
          bootAt,
          Number(run.started_at) || 0,
          Number(stats.last_ts) || 0,
          Number(memory?.lastTouchedAt) || 0,
        );
        // A run this process owns (handler still awaiting) gets the much larger
        // owned threshold — quiet is normal mid-tool-call; a disowned row gets
        // the standard one.
        const threshold = memory ? ownedOrphanMs : orphanMs;
        if (nowMs - lastActivityAt < threshold) continue; // still showing signs of life

        // Preferred close: reject the still-held pending promise so the
        // owning handler's existing failure path writes the terminal state.
        let rejected = false;
        if (memory?.sessionKey && typeof resolvePendingRunExternally === 'function') {
          try {
            rejected = resolvePendingRunExternally({
              runId: null,
              sessionKey: memory.sessionKey,
              successful: false,
              source: 'run_watchdog',
            }) === true;
          } catch (err) {
            warn(`[run-watchdog] resolvePendingRunExternally failed for run ${run.id}: ${err?.message || err}`);
          }
          if (rejected) {
            info(`[run-watchdog] rejected stale pending for run ${String(run.id).slice(0, 8)} (idle ${Math.round((nowMs - lastActivityAt) / 1000)}s); owner path will close it`, { runId: run.id });
            repairs.push({ runId: run.id, action: 'pending_rejected' });
            continue;
          }
        }

        // A run this process still owns is never direct-closed: its handler's
        // finally block is the single writer and will clear the entry (a steer
        // pending with expectFinal:false, or a pending that just resolved and
        // is mid post-processing, both land here). Direct close would race the
        // owner and stamp a synthetic error on a completing run.
        if (memory && !rejected) continue;

        // Direct close (typically after a bridge restart — nothing owns the run).
        const synthetic = buildOrphanRunCloseEvent({
          runId: run.id,
          sessionKey: memory?.sessionKey || null,
          startedAt: run.started_at,
          lastActivityAt,
          now: nowMs,
        });
        const maxSeq = Number.isFinite(Number(stats.max_seq)) && stats.max_seq !== null ? Number(stats.max_seq) : -1;
        const seq = Math.max(maxSeq + 1, SYNTHETIC_RUN_EVENT_SEQ_BASE);
        try {
          insertEvent.run(run.id, seq, synthetic.event, JSON.stringify(synthetic.data), synthetic.timestamp);
        } catch (err) {
          warn(`[run-watchdog] synthetic run_event append failed for run ${run.id}: ${err?.message || err}`);
        }
        closeRun.run(nowMs, nowMs - (Number(run.started_at) || nowMs), ORPHANED_RUN_MESSAGE, run.id);

        const tooOldToToast = nowMs - (Number(run.started_at) || nowMs) > broadcastMaxAgeMs;
        if (typeof broadcast === 'function' && !tooOldToToast) {
          try {
            broadcast('agent:error', {
              agentId: run.agent_id || 'system',
              agentName: run.agent_name || 'Agent',
              error: ORPHANED_RUN_MESSAGE,
              channel: run.channel || null,
              runId: run.id,
              synthetic: true,
              syntheticKind: ORPHANED_RUN_CLOSE_KIND,
            });
            broadcast('agent:typing_stop', { agentId: run.agent_id || 'system', channel: run.channel || null });
          } catch (err) {
            warn(`[run-watchdog] broadcast failed for run ${run.id}: ${err?.message || err}`);
          }
        }

        registry.markEnded(run.id);
        info(`[run-watchdog] closed orphaned run ${String(run.id).slice(0, 8)} (source=${run.source || 'unknown'}, idle ${Math.round((nowMs - lastActivityAt) / 1000)}s)`, {
          runId: run.id,
          agent: run.agent_name,
          lastActivityAt,
        });
        repairs.push({ runId: run.id, action: 'closed', seq });
      } catch (err) {
        // One bad row must never stop the sweep.
        warn(`[run-watchdog] repair failed for run ${run?.id}: ${err?.message || err}`);
      }
    }

    try { registry.prune(); } catch { /* best effort */ }
    return repairs;
  }

  function start() {
    if (intervalMs <= 0) {
      info('[run-watchdog] disabled (TROOPER_RUN_WATCHDOG_MS <= 0)');
      return false;
    }
    if (timer) return true;
    timer = setIntervalFn(() => {
      try { scanOnce(); } catch (err) { warn(`[run-watchdog] sweep failed: ${err?.message || err}`); }
    }, intervalMs);
    if (typeof timer?.unref === 'function') timer.unref();
    info(`[run-watchdog] started (every ${Math.round(intervalMs / 1000)}s, orphan threshold ${Math.round(orphanMs / 1000)}s)`);
    return true;
  }

  function stop() {
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  return { scanOnce, start, stop, get running() { return !!timer; } };
}
