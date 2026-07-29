import { createHash } from 'crypto';

const WORKSPACE_PATH_RE = /\/home\/node\/\.openclaw\/workspace\/[^\s"'`<>]+/g;
const HEARTBEAT_RE = /^ACP worker is running$/i;

function cleanText(value = '') {
  if (typeof value === 'string') return value.replace(/\r/g, '').trim();
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function messageParts(message = {}) {
  const content = message?.content ?? message?.text ?? message?.message ?? '';
  if (!Array.isArray(content)) return [{ type: 'text', text: cleanText(content) }].filter((part) => part.text);
  return content.map((part) => {
    if (typeof part === 'string') return { type: 'text', text: cleanText(part) };
    const type = String(part?.type || part?.kind || '').toLowerCase();
    if (['tool_use', 'tool_call', 'tool'].includes(type)) {
      return {
        type: 'tool_use',
        name: String(part?.name || part?.tool || 'command'),
        input: part?.input ?? part?.arguments ?? part?.params ?? {},
        id: part?.id || part?.toolCallId || null,
      };
    }
    if (['tool_result', 'tool_output', 'result'].includes(type)) {
      return {
        type: 'tool_result',
        name: String(part?.name || part?.tool || 'command'),
        text: cleanText(part?.content ?? part?.output ?? part?.result ?? ''),
        id: part?.tool_use_id || part?.toolCallId || part?.id || null,
        error: Boolean(part?.is_error || part?.error),
      };
    }
    if (type === 'thinking' || type === 'reasoning') {
      return { type: 'thinking', text: cleanText(part?.thinking ?? part?.text ?? part?.content ?? '') };
    }
    return { type: 'text', text: cleanText(part?.text ?? part?.content ?? '') };
  }).filter((part) => part.text || part.type === 'tool_use');
}

function shortHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function sourceIdentity(entry = {}, index = 0) {
  const message = entry?.message || entry;
  return String(
    entry?.id || entry?.messageId || message?.id || message?.messageId
    || `${message?.role || 'event'}:${entry?.timestamp || message?.timestamp || index}`,
  );
}

function extractWorkspaceArtifacts(value = '') {
  const paths = String(value || '').match(WORKSPACE_PATH_RE) || [];
  return [...new Set(paths.map((path) => path.replace(/[),.;:'"`]+$/, '').trim()))]
    .map((path) => ({ path, name: path.split('/').pop(), type: 'file' }));
}

function commandFromInput(input) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object') return '';
  return cleanText(input.command || input.cmd || input.script || input.path || input.file_path || input.filePath || input);
}

/**
 * Convert OpenClaw's persisted ACP child history into stable, UI-safe events.
 * The key includes content so an in-place streaming message update is emitted,
 * while sourceId lets consumers replace that update instead of duplicating it.
 */
export function observeAcpSessionHistory(history = []) {
  const records = [];
  for (const [index, entry] of (Array.isArray(history) ? history : []).entries()) {
    const message = entry?.message || entry || {};
    const role = String(message?.role || entry?.role || 'assistant').toLowerCase();
    const createdAt = entry?.timestamp || entry?.createdAt || message?.timestamp || message?.createdAt || Date.now();
    const sourceId = sourceIdentity(entry, index);
    const parts = messageParts(message);
    const serialized = JSON.stringify({ role, parts });
    const historyKey = `${sourceId}:${shortHash(serialized)}`;
    const events = [];
    const transcript = [];
    const artifacts = [];

    for (const [partIndex, part] of parts.entries()) {
      if (part.type === 'text') {
        if (!part.text || HEARTBEAT_RE.test(part.text)) continue;
        const event = {
          type: role === 'tool' ? 'tool_result' : 'message',
          role,
          content: part.text,
          sourceId,
          partIndex,
          createdAt,
        };
        events.push(event);
        artifacts.push(...extractWorkspaceArtifacts(part.text));
        if (role !== 'tool') transcript.push({ id: sourceId, role, content: part.text, createdAt });
        continue;
      }
      if (part.type === 'thinking') {
        if (part.text) events.push({ type: 'thinking', content: part.text, sourceId, partIndex, createdAt });
        continue;
      }
      if (part.type === 'tool_use') {
        const command = commandFromInput(part.input);
        events.push({
          type: 'tool_use',
          tool: part.name,
          command,
          input: part.input,
          content: command || part.name,
          toolCallId: part.id,
          sourceId,
          partIndex,
          createdAt,
        });
        artifacts.push(...extractWorkspaceArtifacts(command));
        continue;
      }
      if (part.type === 'tool_result') {
        events.push({
          type: part.error ? 'tool_error' : 'tool_result',
          tool: part.name,
          content: part.text,
          output: part.text,
          toolCallId: part.id,
          sourceId,
          partIndex,
          createdAt,
          recoverable: part.error,
        });
        artifacts.push(...extractWorkspaceArtifacts(part.text));
      }
    }

    const topLevelToolCalls = Array.isArray(message?.toolCalls)
      ? message.toolCalls
      : Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    for (const [toolIndex, toolCall] of topLevelToolCalls.entries()) {
      const name = String(toolCall?.name || toolCall?.function?.name || toolCall?.tool || 'command');
      const input = toolCall?.input ?? toolCall?.arguments ?? toolCall?.function?.arguments ?? {};
      const command = commandFromInput(input);
      events.push({
        type: 'tool_use', tool: name, command, input, content: command || name,
        toolCallId: toolCall?.id || null, sourceId, partIndex: parts.length + toolIndex, createdAt,
      });
      artifacts.push(...extractWorkspaceArtifacts(command));
    }

    if (events.length || transcript.length || artifacts.length) {
      records.push({ historyKey, sourceId, createdAt, events, transcript, artifacts });
    }
  }
  return records;
}

export function mergeAcpTranscript(existing = [], incoming = []) {
  const byId = new Map();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    const id = String(item?.id || `${item?.role || 'assistant'}:${item?.createdAt || byId.size}`);
    byId.set(id, { ...(byId.get(id) || {}), ...item, id });
  }
  return [...byId.values()].sort((left, right) => new Date(left.createdAt || 0) - new Date(right.createdAt || 0));
}

export function mergeAcpArtifacts(existing = [], incoming = []) {
  const byPath = new Map();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    const artifact = typeof item === 'string' ? { path: item, name: item.split('/').pop(), type: 'file' } : item;
    const key = String(artifact?.path || artifact?.url || artifact?.name || '');
    if (key) byPath.set(key, { ...(byPath.get(key) || {}), ...artifact });
  }
  return [...byPath.values()];
}
