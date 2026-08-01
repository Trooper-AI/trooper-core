import { createHash } from 'crypto';

/**
 * Shared per-session ACP event streaming.
 *
 * The stream route used to run one 1s history-polling loop per SSE request:
 * N watchers of one ACP session meant N gateway history fetches per second,
 * and a reconnecting client silently missed everything captured between
 * requests. This registry runs ONE poller per session regardless of client
 * count, adapts its cadence to activity, replays buffered events to late or
 * reconnecting subscribers, and accepts pushed events (gateway relay or
 * agent WS frames) through the same dedupe line so polling degrades to a
 * backstop when push is available.
 *
 * All I/O is injected (fetchHistory/fetchSnapshot/captureHistory/...), so
 * the scheduling, fan-out, and terminal logic are unit-testable without a
 * gateway.
 */

export const ACP_POLL_ACTIVE_MS = 500;
export const ACP_POLL_IDLE_MS = 2000;
export const ACP_POLL_PUSH_BACKSTOP_MS = 10_000;
export const ACP_POLLER_LINGER_MS = 10_000;
export const ACP_POLLER_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;
export const ACP_POLL_IDLE_AFTER_EMPTY_POLLS = 3;
export const ACP_PUSH_FRESH_WINDOW_MS = 15_000;

export const ACP_TERMINAL_STATUSES = Object.freeze([
  'completed', 'complete', 'done', 'idle', 'failed', 'cancelled', 'canceled',
]);
export const ACP_FAILED_STATUSES = Object.freeze(['failed', 'cancelled', 'canceled']);

function shortHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

export function createAcpEventStreamRegistry({
  fetchHistory,
  fetchSnapshot,
  captureHistory,
  synthesizeInterruptionMarkers = () => [],
  buildFinal,
  onTerminalCleanup = () => {},
  normalizeEvent = (type, payload) => payload,
  historyLimit = 200,
  historyTimeoutMs = 15_000,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const pollers = new Map(); // sessionId -> poller
  const bySessionKey = new Map(); // sessionKey -> sessionId
  let pushObserved = 0;
  let lastPushAt = null;

  function wrap(poller, event, source) {
    const local = poller.local;
    return normalizeEvent(String(event?.type || 'event'), event, {
      sessionKey: local.parentSessionKey || local.sessionKey || null,
      parentSessionKey: local.parentSessionKey || null,
      childSessionKey: local.sessionKey || null,
      runId: local.runId || null,
      sequence: event?.sequence ?? 0,
      time: event?.createdAt || now(),
      source,
    });
  }

  function fanout(poller, wrapped) {
    for (const subscriber of [...poller.subscribers]) {
      try { subscriber.onEvent?.(wrapped); } catch { /* subscriber owns its errors */ }
    }
  }

  function scheduleNext(poller, delayMs) {
    if (poller.terminal || poller.stopped) return;
    poller.timer = setTimeoutFn(() => {
      poller.timer = null;
      void tick(poller);
    }, delayMs);
  }

  function nextDelay(poller, hadEvents) {
    if (hadEvents) {
      poller.emptyPolls = 0;
    } else {
      poller.emptyPolls += 1;
    }
    if (poller.lastPushAt && (now() - poller.lastPushAt) < ACP_PUSH_FRESH_WINDOW_MS) {
      return ACP_POLL_PUSH_BACKSTOP_MS;
    }
    return poller.emptyPolls >= ACP_POLL_IDLE_AFTER_EMPTY_POLLS ? ACP_POLL_IDLE_MS : ACP_POLL_ACTIVE_MS;
  }

  function finish(poller, { status, timedOut = false } = {}) {
    if (poller.terminal) return;
    const failed = timedOut
      || poller.local?.status === 'failed'
      || ACP_FAILED_STATUSES.includes(String(status || '').toLowerCase());
    if (failed && !timedOut) {
      for (const marker of synthesizeInterruptionMarkers(poller.local) || []) {
        fanout(poller, wrap(poller, marker, 'acp_poll'));
      }
    }
    const final = buildFinal
      ? buildFinal(poller.local, { failed, status: status || null, timedOut })
      : { type: failed ? 'error' : 'done', status: status || (failed ? 'failed' : 'completed') };
    poller.terminal = final;
    if (poller.timer) {
      clearTimeoutFn(poller.timer);
      poller.timer = null;
    }
    for (const subscriber of [...poller.subscribers]) {
      try { subscriber.onTerminal?.(final); } catch { /* subscriber owns its errors */ }
    }
    poller.subscribers.clear();
    try { void onTerminalCleanup(poller.local); } catch { /* cleanup is best-effort */ }
    armTeardown(poller);
  }

  async function tick(poller) {
    if (poller.terminal || poller.stopped || poller.ticking) return;
    poller.ticking = true;
    try {
      if (poller.local?.status === 'failed') {
        finish(poller, { status: 'failed' });
        return;
      }
      if ((now() - poller.startedAt) > ACP_POLLER_MAX_LIFETIME_MS) {
        finish(poller, { status: 'timeout', timedOut: true });
        return;
      }
      let hadEvents = false;
      try {
        const history = await fetchHistory(poller.local.sessionKey, historyLimit, { timeoutMs: historyTimeoutMs }) || [];
        const fresh = captureHistory(poller.local, history) || [];
        hadEvents = fresh.length > 0;
        for (const event of fresh) {
          fanout(poller, wrap(poller, event, 'acp_poll'));
        }
        const snapshot = await fetchSnapshot(poller.local.sessionKey);
        const status = String(snapshot?.status || '').toLowerCase();
        if (ACP_TERMINAL_STATUSES.includes(status)) {
          finish(poller, { status });
          return;
        }
      } catch (err) {
        for (const subscriber of [...poller.subscribers]) {
          try { subscriber.onPollError?.(err); } catch { /* subscriber owns its errors */ }
        }
      }
      scheduleNext(poller, nextDelay(poller, hadEvents));
    } finally {
      poller.ticking = false;
    }
  }

  function armTeardown(poller) {
    if (poller.lingerTimer) clearTimeoutFn(poller.lingerTimer);
    poller.lingerTimer = setTimeoutFn(() => {
      poller.stopped = true;
      if (poller.timer) {
        clearTimeoutFn(poller.timer);
        poller.timer = null;
      }
      pollers.delete(poller.sessionId);
      if (bySessionKey.get(poller.local?.sessionKey) === poller.sessionId) {
        bySessionKey.delete(poller.local?.sessionKey);
      }
    }, ACP_POLLER_LINGER_MS);
  }

  function cancelTeardown(poller) {
    if (poller.lingerTimer) {
      clearTimeoutFn(poller.lingerTimer);
      poller.lingerTimer = null;
    }
  }

  function getOrCreatePoller(sessionId, local) {
    let poller = pollers.get(sessionId);
    if (!poller) {
      poller = {
        sessionId,
        local,
        subscribers: new Set(),
        timer: null,
        lingerTimer: null,
        emptyPolls: 0,
        lastPushAt: null,
        startedAt: now(),
        terminal: null,
        stopped: false,
        ticking: false,
      };
      pollers.set(sessionId, poller);
      if (local?.sessionKey) bySessionKey.set(local.sessionKey, sessionId);
    }
    poller.local = local;
    return poller;
  }

  function replayBuffered(poller, subscriber, replayFromSequence) {
    const events = Array.isArray(poller.local?.events) ? poller.local.events : [];
    for (const event of events) {
      if ((event?.sequence ?? 0) <= replayFromSequence) continue;
      try { subscriber.onEvent?.(wrap(poller, event, 'acp_replay')); } catch { /* subscriber owns its errors */ }
    }
  }

  return {
    subscribe(sessionId, local, { onEvent, onTerminal, onError, onPollError, replayFromSequence = 0 } = {}) {
      const poller = getOrCreatePoller(sessionId, local);
      const subscriber = { onEvent, onTerminal, onError, onPollError };
      replayBuffered(poller, subscriber, Number(replayFromSequence) || 0);
      if (poller.terminal) {
        try { subscriber.onTerminal?.(poller.terminal); } catch { /* subscriber owns its errors */ }
        return () => {};
      }
      cancelTeardown(poller);
      poller.subscribers.add(subscriber);
      if (!poller.timer && !poller.ticking) scheduleNext(poller, 0);
      return () => {
        poller.subscribers.delete(subscriber);
        if (!poller.subscribers.size && !poller.terminal) armTeardown(poller);
      };
    },

    ingestExternalEvents(sessionKey, rawEvents, { source = 'acp_push' } = {}) {
      const sessionId = bySessionKey.get(sessionKey);
      const poller = sessionId ? pollers.get(sessionId) : null;
      if (!poller || poller.terminal || poller.stopped) return { accepted: 0, dropped: (rawEvents || []).length };
      const local = poller.local;
      if (!(local._historyKeys instanceof Set)) local._historyKeys = new Set();
      if (!Array.isArray(local.events)) local.events = [];
      let accepted = 0;
      for (const raw of Array.isArray(rawEvents) ? rawEvents : []) {
        if (!raw || typeof raw !== 'object') continue;
        const type = String(raw.type || raw.kind || 'event');
        const dedupeKey = `push:${type}:${raw.toolCallId || ''}:${shortHash(raw.content ?? raw.contentText ?? JSON.stringify(raw))}`;
        if (local._historyKeys.has(dedupeKey)) continue;
        local._historyKeys.add(dedupeKey);
        const event = {
          ...raw,
          type,
          ...(raw.content === undefined && raw.contentText !== undefined ? { content: raw.contentText } : {}),
          sequence: Number(local._eventSequence || 0) + 1,
          createdAt: raw.createdAt || raw.ts || now(),
        };
        local._eventSequence = event.sequence;
        local.events.push(event);
        accepted += 1;
        fanout(poller, wrap(poller, event, source));
      }
      if (accepted) {
        local.events = local.events.slice(-500);
        local.lastActivity = now();
        poller.lastPushAt = now();
        pushObserved += accepted;
        lastPushAt = now();
      }
      return { accepted, dropped: 0 };
    },

    indexBySessionKey(sessionKey) {
      return bySessionKey.get(sessionKey) || null;
    },

    getStats() {
      return {
        pollers: pollers.size,
        subscribers: [...pollers.values()].reduce((sum, poller) => sum + poller.subscribers.size, 0),
        pushObserved,
        lastPushAt,
      };
    },
  };
}
