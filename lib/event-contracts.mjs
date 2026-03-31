export function normalizeToolEventPayload(kind, base = {}) {
  return {
    eventType: kind,
    confidence: base.confidence || 'native',
    tool: base.tool || 'unknown',
    toolCallId: base.toolCallId,
    skillName: base.skillName || null,
    params: base.params || {},
    summary: base.summary || '',
    raw: base.raw || '',
    success: base.success,
    durationMs: base.durationMs,
    startedAt: base.startedAt,
    endedAt: base.endedAt || Date.now(),
    index: base.index,
  };
}

function toHistoryTimestamp(message) {
  return new Date(message?.timestamp || message?.message?.timestamp || 0).getTime() || Date.now();
}

function toHistoryMessage(message) {
  return message?.message || message || {};
}

function historyContentToText(content, maxSummaryLength = 500) {
  const text = Array.isArray(content)
    ? content.filter((block) => block?.type === 'text').map((block) => block?.text || '').join('\n')
    : typeof content === 'string'
      ? content
      : JSON.stringify(content || '');
  return String(text || '').slice(0, maxSummaryLength);
}

export function extractHistoryToolEvents(messages = [], {
  runId = null,
  sessionKey = null,
  source = 'history_replay',
  cutoffMs = null,
  maxSummaryLength = 500,
} = {}) {
  const events = [];
  const toolNameByCallId = new Map();
  const indexByCallId = new Map();
  let nextIndex = 0;

  const ensureIndex = (toolCallId = null) => {
    if (toolCallId && indexByCallId.has(toolCallId)) return indexByCallId.get(toolCallId);
    const index = nextIndex++;
    if (toolCallId) indexByCallId.set(toolCallId, index);
    return index;
  };

  for (const rawMessage of messages || []) {
    const message = toHistoryMessage(rawMessage);
    const content = message?.content;
    const role = message?.role || '';
    const time = toHistoryTimestamp(rawMessage);
    if (cutoffMs && time < cutoffMs) continue;

    if (role === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'toolCall' && block?.type !== 'tool_use') continue;
        const toolCallId = block?.id || block?.toolCallId || undefined;
        const tool = block?.name || block?.tool || 'tool';
        const index = ensureIndex(toolCallId);
        if (toolCallId) toolNameByCallId.set(toolCallId, tool);
        events.push({
          event: 'tool_start',
          data: {
            ...normalizeToolEventPayload('tool_start', {
              tool,
              toolCallId,
              params: block?.arguments || block?.input || {},
              startedAt: time,
              endedAt: time,
              index,
              confidence: source,
            }),
            ...(runId ? { runId } : {}),
            ...(sessionKey ? { sessionKey } : {}),
            source,
          },
          time,
        });
      }
    }

    if ((role === 'toolResult' || role === 'tool') && content) {
      const toolCallId = message?.toolCallId || message?.tool_use_id || undefined;
      const tool = message?.toolName || message?.name || (toolCallId ? toolNameByCallId.get(toolCallId) : null) || 'unknown';
      const index = ensureIndex(toolCallId);
      const raw = historyContentToText(content, Math.max(maxSummaryLength * 2, 1000));
      events.push({
        event: 'tool_result',
        data: {
          ...normalizeToolEventPayload('tool_result', {
            tool,
            toolCallId,
            success: !message?.isError && !message?.is_error,
            summary: raw.slice(0, maxSummaryLength),
            raw,
            startedAt: time,
            endedAt: time,
            index,
            confidence: source,
          }),
          ...(message?.details ? { details: message.details } : {}),
          ...(runId ? { runId } : {}),
          ...(sessionKey ? { sessionKey } : {}),
          source,
        },
        time,
      });
    }
  }

  return events;
}

export function buildBrowserSessionPayload({ liveViewUrl = null, sessionId = null, domain = '', provider = 'screenshot' } = {}) {
  return {
    liveViewUrl: liveViewUrl || null,
    sessionId: sessionId || null,
    domain: domain || '',
    provider: provider || 'screenshot',
  };
}

export function buildBrowserSessionEndPayload({ sessionId = null, recordingUrl = null } = {}) {
  return {
    sessionId: sessionId || null,
    recordingUrl: recordingUrl || null,
  };
}

export function buildScreenshotFramePayload({ base64 = '', timestamp = Date.now() } = {}) {
  return {
    base64,
    timestamp,
  };
}
