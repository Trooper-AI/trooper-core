import {
  buildImageGenerationEventMetadata,
  isImageGenerationTool,
} from './image-generation-defaults.mjs';

export const BRIDGE_EVENT_PAYLOAD_VERSION = 2;

function safeJsonParse(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function firstObject(...values) {
  return values.find(isPlainObject) || null;
}

function firstField(sources, fields) {
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    for (const field of fields) {
      const value = source[field];
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return undefined;
}

function numericCost(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function costFromValue(value) {
  const direct = numericCost(value);
  if (direct !== undefined) return direct;
  if (!isPlainObject(value)) return undefined;
  return numericCost(firstDefined(
    value.costUsd,
    value.cost_usd,
    value.totalCostUsd,
    value.total_cost_usd,
    value.totalUsd,
    value.total_usd,
    value.usd,
    value.amountUsd,
    value.amount_usd,
    value.amount,
    value.total,
  ));
}

function normalizeCostSource(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return undefined;
  if (/^(?:provider_)?(?:reported|report|actual|invoice|billed|charge|charged)$/.test(normalized)) {
    return 'provider_reported';
  }
  if (/^(?:service_)?(?:price_)?(?:estimate|estimated|pricing_estimate|fallback_estimate)$/.test(normalized)) {
    return 'service_price_estimate';
  }
  if (/^(?:unavailable|unknown|not_available|not_reported|missing)$/.test(normalized)) {
    return 'unavailable';
  }
  return undefined;
}

function normalizePricingStatus(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return undefined;
  if (/^(?:actual|provider_reported|reported|billed|invoice)$/.test(normalized)) return 'actual';
  if (/^(?:estimated|estimate|service_price_estimate)$/.test(normalized)) return 'estimated';
  if (/^(?:unavailable|unknown|not_available|not_reported|missing)$/.test(normalized)) return 'unavailable';
  return undefined;
}

/**
 * Keep provider-reported service metadata on a final tool event without ever
 * manufacturing a charge.  Gateway versions put this data in different
 * places (`details`, `result`, or `usage`), so normalize the common shape once
 * before chat/task handlers persist and relay it.
 */
export function extractToolResultServiceMetadata(base = {}) {
  const input = isPlainObject(base) ? base : {};
  const details = firstObject(input.details);
  const result = firstObject(input.result);
  const usage = firstObject(input.usage, details?.usage, result?.usage);
  const serviceUsage = firstObject(input.serviceUsage, input.service_usage, details?.serviceUsage, details?.service_usage, result?.serviceUsage, result?.service_usage);
  const billing = firstObject(input.billing, details?.billing, result?.billing);
  const sources = [input, details, result, usage, serviceUsage, billing];

  const provider = firstField(sources, ['provider', 'providerId', 'provider_id']);
  const model = firstField(sources, ['model', 'modelId', 'model_id']);
  const rawCost = firstField(sources, ['cost', 'price', 'charge', 'amount']);
  const explicitCost = firstField(sources, [
    'costUsd', 'cost_usd', 'totalCostUsd', 'total_cost_usd',
    'totalCost', 'total_cost', 'totalUsd', 'total_usd',
    'imageCostUsd', 'image_cost_usd', 'amountUsd', 'amount_usd',
  ]);
  const costUsd = numericCost(explicitCost) ?? costFromValue(rawCost);
  const explicitEstimated = firstField(sources, ['estimated', 'isEstimated', 'is_estimated']);
  const explicitCostSource = normalizeCostSource(firstField(sources, ['costSource', 'cost_source']));
  const explicitPricingStatus = normalizePricingStatus(firstField(sources, ['pricingStatus', 'pricing_status', 'costStatus', 'cost_status']));
  const hasReportedCost = costUsd !== undefined;
  const isPendingGeneration = /(?:background\s+)?(?:image|media|video|audio)?\s*generation\s+(?:started|queued)/i.test(String(input.summary || ''));
  const hasMedia = firstDefined(input.media, input.mediaUrl, details?.media, details?.mediaUrl, result?.media, result?.mediaUrl, result?.path, result?.filePath) !== undefined;
  const hasServiceContext = isImageGenerationTool(input.tool)
    || /(?:image|video|audio|music|tts|media)[_\-.]?(?:generate|generation|create|render)?/i.test(String(input.tool || ''))
    || hasMedia;

  let costSource = explicitCostSource;
  if (!costSource && explicitPricingStatus === 'actual') costSource = 'provider_reported';
  if (!costSource && explicitPricingStatus === 'estimated') costSource = 'service_price_estimate';
  if (!costSource && explicitPricingStatus === 'unavailable') costSource = 'unavailable';
  if (!costSource && explicitEstimated === true) costSource = 'service_price_estimate';
  if (!costSource && hasReportedCost) costSource = 'provider_reported';
  if (!costSource && hasServiceContext && !isPendingGeneration) costSource = 'unavailable';

  const estimated = typeof explicitEstimated === 'boolean'
    ? explicitEstimated
    : costSource === 'service_price_estimate'
      ? true
      : costSource === 'provider_reported' || costSource === 'unavailable'
        ? false
        : undefined;
  const pricingStatus = explicitPricingStatus
    || (costSource === 'provider_reported'
      ? 'actual'
      : costSource === 'service_price_estimate'
        ? 'estimated'
        : costSource === 'unavailable'
          ? 'unavailable'
          : undefined);

  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(details ? { details } : {}),
    ...(usage ? { usage } : {}),
    ...(serviceUsage ? { serviceUsage } : {}),
    ...(billing ? { billing } : {}),
    ...(rawCost !== undefined ? { cost: rawCost } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(costSource ? { costSource } : {}),
    ...(estimated !== undefined ? { estimated } : {}),
    ...(pricingStatus ? { pricingStatus } : {}),
    ...(input.media !== undefined ? { media: input.media } : details?.media !== undefined ? { media: details.media } : result?.media !== undefined ? { media: result.media } : {}),
    ...(input.mediaUrl !== undefined ? { mediaUrl: input.mediaUrl } : details?.mediaUrl !== undefined ? { mediaUrl: details.mediaUrl } : result?.mediaUrl !== undefined ? { mediaUrl: result.mediaUrl } : {}),
  };
}

export function extractStructuredToolResult(value) {
  if (value == null) return null;

  if (typeof value === 'string') {
    return safeJsonParse(value);
  }

  if (Array.isArray(value)) {
    const text = value
      .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    return safeJsonParse(text);
  }

  if (typeof value === 'object') {
    return value;
  }

  return null;
}

export function normalizeToolEventPayload(kind, base = {}) {
  const serviceMetadata = kind === 'tool_result'
    ? extractToolResultServiceMetadata(base)
    : {};
  return {
    eventType: kind,
    phase: kind === 'tool_start' ? 'start' : kind === 'tool_result' ? 'result' : kind,
    confidence: base.confidence || 'native',
    tool: base.tool || 'unknown',
    toolName: base.tool || 'unknown',
    toolCallId: base.toolCallId,
    skillName: base.skillName || null,
    params: base.params || {},
    result: base.result ?? null,
    summary: base.summary || '',
    raw: base.raw || '',
    success: base.success,
    durationMs: base.durationMs,
    startedAt: base.startedAt,
    endedAt: base.endedAt || Date.now(),
    index: base.index,
    ...(base.imageGeneration ? { imageGeneration: base.imageGeneration } : {}),
    ...serviceMetadata,
  };
}

/**
 * Chat and task handlers intentionally use this instead of rebuilding a small
 * `{ tool, success, summary }` object. It keeps the stable event contract and
 * all structured completion fields when relaying/persisting gateway events.
 */
export function forwardToolEventPayload(kind, data = {}, overrides = {}) {
  const source = isPlainObject(data) ? data : {};
  const merged = {
    ...source,
    ...overrides,
    tool: firstDefined(overrides.tool, source.tool, source.toolName, source.name, 'unknown'),
    toolCallId: firstDefined(overrides.toolCallId, source.toolCallId, source.tool_call_id, source.id),
    params: firstDefined(overrides.params, source.params, source.input, source.args, {}),
    result: overrides.result !== undefined
      ? overrides.result
      : source.result !== undefined
        ? source.result
        : extractStructuredToolResult(source.content ?? source.output),
    success: overrides.success !== undefined
      ? overrides.success
      : source.success !== undefined
        ? source.success
        : !source.is_error,
    summary: firstDefined(overrides.summary, source.summary, ''),
    raw: firstDefined(overrides.raw, source.raw, source.content, source.output, ''),
    imageGeneration: overrides.imageGeneration
      || source.imageGeneration
      || buildImageGenerationEventMetadata({
        tool: firstDefined(overrides.tool, source.tool, source.toolName, source.name, 'unknown'),
        params: firstDefined(overrides.params, source.params, source.input, source.args, {}),
        result: overrides.result !== undefined ? overrides.result : source.result,
        details: overrides.details || source.details,
      }),
  };
  return normalizeToolEventPayload(kind, merged);
}

export function normalizeBridgeEventPayload(event, payload = {}, {
  sessionKey = null,
  runId = null,
  source = null,
  sequence = 0,
  time = Date.now(),
  parentSessionKey = null,
  parentRunId = null,
  childSessionKey = null,
  childRunId = null,
} = {}) {
  const next = {
    ...(payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : { value: payload }),
  };
  const resolvedRunId = next.runId || runId || next.subAgentRunId || next.childRunId || childRunId || null;
  const resolvedChildRunId = next.childRunId || childRunId || next.subAgentRunId || null;
  const resolvedChildSessionKey = next.childSessionKey || childSessionKey || null;
  const resolvedParentRunId = next.parentRunId || parentRunId || null;
  const resolvedParentSessionKey = next.parentSessionKey || parentSessionKey || null;
  const resolvedSessionKey = next.sessionKey || sessionKey || (event.startsWith('subagent_') ? resolvedChildSessionKey : null) || null;
  const resolvedTime = next.time || time || Date.now();
  const resolvedSource = next.source || source || 'live_stream';
  const resolvedSequence = next.sequence ?? sequence;
  const eventIdBase = [
    resolvedSessionKey || 'no-session',
    resolvedRunId || 'no-run',
    event,
    resolvedSequence,
  ].join(':');

  return {
    ...next,
    payloadVersion: next.payloadVersion || BRIDGE_EVENT_PAYLOAD_VERSION,
    eventId: next.eventId || eventIdBase,
    sequence: resolvedSequence,
    source: resolvedSource,
    time: resolvedTime,
    sessionKey: resolvedSessionKey,
    runId: resolvedRunId,
    ...(resolvedParentSessionKey ? { parentSessionKey: resolvedParentSessionKey } : {}),
    ...(resolvedParentRunId ? { parentRunId: resolvedParentRunId } : {}),
    ...(resolvedChildSessionKey ? { childSessionKey: resolvedChildSessionKey } : {}),
    ...(resolvedChildRunId ? { childRunId: resolvedChildRunId } : {}),
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
  const toolParamsByCallId = new Map();
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
        const params = block?.arguments || block?.input || {};
        if (toolCallId) toolParamsByCallId.set(toolCallId, params);
        events.push({
          event: 'tool_start',
          data: normalizeBridgeEventPayload('tool_start', {
            ...normalizeToolEventPayload('tool_start', {
              tool,
              toolCallId,
              params,
              imageGeneration: buildImageGenerationEventMetadata({ tool, params }),
              startedAt: time,
              endedAt: time,
              index,
              confidence: source,
            }),
          }, {
            runId,
            sessionKey,
            source,
            sequence: index,
            time,
          }),
          time,
        });
      }
    }

    if ((role === 'toolResult' || role === 'tool') && content) {
      const toolCallId = message?.toolCallId || message?.tool_use_id || undefined;
      const tool = message?.toolName || message?.name || (toolCallId ? toolNameByCallId.get(toolCallId) : null) || 'unknown';
      const params = (toolCallId ? toolParamsByCallId.get(toolCallId) : null) || {};
      const index = ensureIndex(toolCallId);
      const raw = historyContentToText(content, Math.max(maxSummaryLength * 2, 1000));
      const structuredResult = extractStructuredToolResult(
        message?.result ?? message?.output ?? content,
      );
      const result = structuredResult ?? message?.result ?? message?.output ?? null;
      events.push({
        event: 'tool_result',
        data: normalizeBridgeEventPayload('tool_result', {
          ...normalizeToolEventPayload('tool_result', {
            ...message,
            tool,
            toolCallId,
            params,
            result,
            success: !message?.isError && !message?.is_error,
            summary: raw.slice(0, maxSummaryLength),
            raw,
            startedAt: time,
            endedAt: time,
            index,
            confidence: source,
            imageGeneration: buildImageGenerationEventMetadata({
              tool,
              params,
              result: structuredResult,
              details: message?.details,
            }),
          }),
          ...(message?.details ? { details: message.details } : {}),
        }, {
          runId,
          sessionKey,
          source,
          sequence: index,
          time,
        }),
        time,
      });
    }
  }

  return events;
}

export function buildBrowserSessionPayload({ liveViewUrl = null, sessionId = null, domain = '', provider = 'screenshot', browserMode = null } = {}) {
  return {
    liveViewUrl: liveViewUrl || null,
    sessionId: sessionId || null,
    domain: domain || '',
    provider: provider || 'screenshot',
    browserMode: browserMode || null,
  };
}

export function buildBrowserSessionEndPayload({ sessionId = null, recordingUrl = null, browserMode = null } = {}) {
  return {
    sessionId: sessionId || null,
    recordingUrl: recordingUrl || null,
    browserMode: browserMode || null,
  };
}

export function buildScreenshotFramePayload({
  base64 = '',
  timestamp = Date.now(),
  action = null,
  label = null,
  pageTitle = null,
  pageUrl = null,
  captureKind = null,
  geometry = null,
  screenshotPath = null,
} = {}) {
  return {
    base64,
    timestamp,
    ...(action ? { action } : {}),
    ...(label ? { label } : {}),
    ...(pageTitle ? { pageTitle } : {}),
    ...(pageUrl ? { pageUrl } : {}),
    ...(captureKind ? { captureKind } : {}),
    ...(geometry ? { geometry } : {}),
    ...(screenshotPath ? { screenshotPath } : {}),
  };
}
