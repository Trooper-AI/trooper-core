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
/** Hard terminals always end the SSE stream. */
export const ACP_HARD_TERMINAL_STATUSES = Object.freeze([
  'completed', 'complete', 'done', 'failed', 'cancelled', 'canceled',
]);
/**
 * Soft terminals (idle) often appear mid-turn or right after UsageLimitExceeded
 * while `/acp steer` is still returning. Do not treat them as success while
 * steer is pending or before any assistant output exists.
 */
export const ACP_SOFT_TERMINAL_STATUSES = Object.freeze(['idle']);
export const ACP_FAILED_STATUSES = Object.freeze(['failed', 'cancelled', 'canceled']);

export function looksLikeAcpFailureText(value = '') {
  return /\b(UsageLimitExceeded|Quota exceeded|usage limit|rate limit(?:ed)?|allowance exhausted|ACP_TURN_FAILED|Authentication required|Unhandled error during turn)\b/i
    .test(String(value || ''));
}

/**
 * How long an `awaiting_user` attention flag may hold the idle-terminal
 * heuristics off. An approval prompt idles the CLI indefinitely, but a stale
 * flag (prompt text lingering in the transcript tail) must not keep a poller
 * alive forever — after the hold expires, the normal idle logic resumes.
 */
export const ACP_ATTENTION_IDLE_HOLD_MS = 30 * 60 * 1000;

/** Rule-verdict reasons → the errorKind vocabulary the control plane knows. */
const RULE_REASON_ERROR_KINDS = Object.freeze({
  quota_exhausted: 'acp_quota_exhausted',
  auth_required: 'acp_auth_required',
  session_stale: 'acp_session_stale',
  turn_failed: 'acp_turn_failed',
});

/**
 * The observation bundle the state-rule packs classify (`lib/acp-state-rules.mjs`).
 * One definition shared by the poller and the `/acp/sessions/:id/explain` route so
 * an explain trace shows exactly what live classification saw. Latest text comes
 * last: `text_tail(N)` rules (approval prompts) read the newest content, while
 * whole-`text` rules (failures) scan everything.
 */
export function buildAcpRuleObservation(local = {}, { snapshotStatus = null, eventType = null } = {}) {
  const parts = [];
  const transcript = Array.isArray(local?.transcript) ? local.transcript.slice(-20) : [];
  for (const entry of transcript) {
    const content = String(entry?.content || entry?.text || '').trim();
    if (content) parts.push(content);
  }
  const output = String(local?.output || '').trim();
  if (output && !parts.includes(output)) parts.push(output);
  const steerResponse = String(local?.steerResponse || '').trim();
  if (steerResponse && !parts.includes(steerResponse)) parts.push(steerResponse);
  return {
    text: parts.join('\n'),
    errorText: steerResponse,
    snapshotStatus: snapshotStatus == null ? '' : String(snapshotStatus),
    eventType: eventType == null ? '' : String(eventType),
  };
}

function localHasAssistantOutput(local = {}) {
  if (String(local?.output || '').trim()) return true;
  return (Array.isArray(local?.transcript) ? local.transcript : []).some((entry) => (
    String(entry?.role || '').toLowerCase() === 'assistant'
    && String(entry?.content || entry?.text || '').trim()
  ));
}

function localFailureSignal(local = {}) {
  if (ACP_FAILED_STATUSES.includes(String(local?.status || '').toLowerCase())) return true;
  if (looksLikeAcpFailureText(local?.output || local?.steerResponse || '')) return true;
  return (Array.isArray(local?.transcript) ? local.transcript : []).some((entry) => (
    looksLikeAcpFailureText(entry?.content || entry?.text || '')
  ));
}

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
  // Optional declarative classification: `{ classify(harness, observation),
  // arbitrate({ structuredStatus, ruleResult }) }` from lib/acp-state-packs.mjs /
  // lib/acp-state-rules.mjs. Absent → behavior is exactly the legacy heuristics.
  stateRules = null,
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

  // Synthetic events (attention transitions) never appear in gateway history, so
  // they skip the history dedupe set and go straight into the durable buffer with
  // the next sequence — replayable exactly like polled/pushed events.
  function appendSyntheticEvent(poller, raw) {
    const local = poller.local;
    if (!Array.isArray(local.events)) local.events = [];
    const event = {
      ...raw,
      synthetic: true,
      syntheticKind: 'state_rules',
      sequence: Number(local._eventSequence || 0) + 1,
      createdAt: now(),
    };
    local._eventSequence = event.sequence;
    local.events.push(event);
    local.events = local.events.slice(-500);
    local.lastActivity = now();
    fanout(poller, wrap(poller, event, 'acp_rule'));
  }

  // Attention is edge-triggered: one permission_request when a prompt appears,
  // one permission_resolved when it clears. Steady state emits nothing.
  function setRuleAttention(poller, attention, reason) {
    const local = poller.local;
    if (!local) return;
    const previous = local.attention || null;
    const next = attention || null;
    if (previous === next) {
      if (next && reason && local.attentionReason !== reason) local.attentionReason = reason;
      return;
    }
    local.attention = next;
    local.attentionReason = next ? (reason || null) : null;
    local.attentionSince = next ? now() : null;
    if (next === 'awaiting_user') {
      appendSyntheticEvent(poller, {
        type: 'permission_request',
        content: 'The agent is waiting for your approval.',
        attention: 'awaiting_user',
        reason: reason || null,
      });
    } else if (previous === 'awaiting_user') {
      appendSyntheticEvent(poller, {
        type: 'permission_resolved',
        content: 'The agent resumed.',
      });
    }
  }

  // Classify the current local text through the rule packs and apply the verdict:
  // failure verdicts flip status (with a structured errorKind), attention verdicts
  // raise/clear awaiting_user. Wrapped so a rules bug can never break polling.
  function applyRuleClassification(poller) {
    if (!stateRules?.classify || !stateRules?.arbitrate) return;
    try {
      const local = poller.local;
      const observation = buildAcpRuleObservation(local);
      const ruleResult = stateRules.classify(local?.agent, observation);
      const verdict = stateRules.arbitrate({ structuredStatus: local?.status, ruleResult });
      setRuleAttention(poller, verdict.attention, verdict.reason);
      if (verdict.status === 'failed' && local.status !== 'failed') {
        local.status = 'failed';
        if (verdict.reason && RULE_REASON_ERROR_KINDS[verdict.reason]) {
          local.errorKind = RULE_REASON_ERROR_KINDS[verdict.reason];
        }
        if (!local.output) {
          local.output = String(local.steerResponse || '').trim() || 'ACP worker failed';
        }
      }
    } catch { /* rules must never take the poller down */ }
  }

  // While an approval prompt is (recently) up, neither idle-success nor
  // idle-empty-failure applies — the CLI is idle because a human has not decided
  // yet. The hold expires so a stale flag cannot pin a poller open.
  function attentionHoldsIdle(poller) {
    const local = poller.local;
    if (local?.attention !== 'awaiting_user') return false;
    const since = Number(local.attentionSince || 0);
    return since > 0 && (now() - since) < ACP_ATTENTION_IDLE_HOLD_MS;
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
    if (poller.local?.attention) {
      // A terminal session is by definition no longer waiting on anyone.
      poller.local.attention = null;
      poller.local.attentionReason = null;
      poller.local.attentionSince = null;
    }
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
        // Declarative classification first: rule packs cover a superset of the
        // legacy failure regex (e.g. ACP_SESSION_INIT_FAILED, which
        // looksLikeAcpFailureText never matched) and raise/clear awaiting_user.
        // The legacy check below stays as a belt-and-braces fallback.
        applyRuleClassification(poller);
        if (localFailureSignal(poller.local) && poller.local.status !== 'failed') {
          poller.local.status = 'failed';
          if (!poller.local.output) {
            poller.local.output = String(poller.local.steerResponse || '').trim()
              || 'ACP worker failed';
          }
        }
        if (poller.local?.status === 'failed') {
          finish(poller, { status: 'failed' });
          return;
        }
        const snapshot = await fetchSnapshot(poller.local.sessionKey);
        const status = String(snapshot?.status || '').toLowerCase();
        if (ACP_HARD_TERMINAL_STATUSES.includes(status)) {
          finish(poller, { status });
          return;
        }
        if (ACP_SOFT_TERMINAL_STATUSES.includes(status)) {
          // Steer still in flight — Codex can idle (or fail) before the
          // parent `/acp steer` reply lands with UsageLimitExceeded.
          if (poller.local?._steerPending) {
            scheduleNext(poller, nextDelay(poller, hadEvents));
            return;
          }
          if (attentionHoldsIdle(poller)) {
            // Approval prompt up: the CLI idles until a human decides. Neither
            // "idle with output ⇒ success" nor "idle without output ⇒ failed"
            // may fire while the prompt is (recently) live.
            scheduleNext(poller, nextDelay(poller, hadEvents));
            return;
          }
          if (localFailureSignal(poller.local)) {
            poller.local.status = 'failed';
            finish(poller, { status: 'failed' });
            return;
          }
          // Brand-new sessions often report idle before the first assistant
          // token. Keep watching briefly so Trooper does not stamp Done after
          // the spin-off ack alone.
          if (!localHasAssistantOutput(poller.local) && (now() - poller.startedAt) < 120_000) {
            scheduleNext(poller, nextDelay(poller, hadEvents));
            return;
          }
          // Idle with no assistant text is not success — Codex quota / silent
          // exits used to finish as "completed" and Trooper posted empty-output.
          if (!localHasAssistantOutput(poller.local)) {
            poller.local.status = 'failed';
            if (!String(poller.local.output || '').trim()) {
              poller.local.output = String(poller.local.steerResponse || '').trim()
                || 'The ACP worker finished without returning any output.';
            }
            finish(poller, { status: 'failed' });
            return;
          }
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
        // Typed permission events from the push lane raise attention immediately —
        // no need to wait for the next poll to notice the prompt. Edge-triggered
        // setRuleAttention keeps repeated pushes from re-emitting the synthetic.
        if (stateRules?.classify) {
          try {
            const ruleResult = stateRules.classify(local?.agent, buildAcpRuleObservation(local, { eventType: event.type }));
            if (ruleResult?.state === 'awaiting_user' && ruleResult.blockerEvidence) {
              setRuleAttention(poller, 'awaiting_user', ruleResult.reason);
            }
          } catch { /* rules must never take the push lane down */ }
        }
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
