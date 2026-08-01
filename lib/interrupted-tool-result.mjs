/**
 * Interruption marker for ACP tool calls whose outcome was never recorded.
 *
 * When an ACP child session dies or is cancelled with a tool_use still open,
 * observers are left unable to tell whether the side effect happened. The
 * terminal handler synthesizes an explicit error tool_result so the event
 * stream — and anything that replays it — carries the honest state. Marker
 * text adapted from the MIT-licensed qm harness (yc-software/qm,
 * src/harness/context-compaction.ts) — see THIRD_PARTY_NOTICES.md.
 */

export const INTERRUPTED_TOOL_RESULT =
  '[interrupted — the platform restarted while this tool call was running and its outcome was not recorded. Check what actually happened before redoing anything with side effects.]';

export const INTERRUPTION_MARKER_KIND = 'interruption_marker';

/**
 * List tool_use events with no matching tool_result/tool_error, in the
 * ACP observation event shape (lib/acp-session-observation.mjs). Pairs by
 * toolCallId when both sides carry one; otherwise consumes the oldest
 * pending use of the same tool, then the oldest pending overall — the same
 * counter semantics the run-sync liveness check uses. Synthetic markers are
 * ordinary tool results to this pairing, so re-running the scan after
 * markers were appended finds nothing new.
 */
export function listUnmatchedAcpToolUses(events = []) {
  const pending = [];
  for (const event of Array.isArray(events) ? events : []) {
    const type = String(event?.type || '').toLowerCase();
    if (type === 'tool_use') {
      pending.push({
        toolCallId: event?.toolCallId || null,
        tool: String(event?.tool || 'unknown'),
        createdAt: event?.createdAt || null,
      });
      continue;
    }
    if (type !== 'tool_result' && type !== 'tool_error') continue;
    const resultCallId = event?.toolCallId || null;
    let index = resultCallId ? pending.findIndex((p) => p.toolCallId === resultCallId) : -1;
    if (index === -1) {
      const tool = String(event?.tool || '');
      index = pending.findIndex((p) => !p.toolCallId && p.tool === tool);
    }
    if (index === -1 && pending.length) index = 0;
    if (index !== -1) pending.splice(index, 1);
  }
  return pending;
}

export function buildInterruptedAcpToolResultEvent({ toolCallId = null, tool = 'unknown', createdAt = null } = {}) {
  return {
    type: 'tool_error',
    tool: tool || 'unknown',
    content: INTERRUPTED_TOOL_RESULT,
    output: INTERRUPTED_TOOL_RESULT,
    toolCallId: toolCallId || null,
    recoverable: false,
    synthetic: true,
    syntheticKind: INTERRUPTION_MARKER_KIND,
    createdAt: createdAt || Date.now(),
  };
}
