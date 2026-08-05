import { createHash } from 'crypto';

const WORKSPACE_PATH_RE = /\/home\/node\/\.openclaw\/workspace\/[^\s"'`<>]+/g;
const HEARTBEAT_RE = /^ACP worker is running$/i;
const FAILURE_RE = /\b(UsageLimitExceeded|Quota exceeded|usage limit|rate limit(?:ed)?|allowance exhausted|ACP_TURN_FAILED|ACP_SESSION_INIT_FAILED|Authentication required|Unhandled error during turn|metadata is missing for agent:)\b/i;
const SYSTEM_PROMPT_RE = /\b(You are|SYSTEM|AGENTS\.md|SOUL\.md|TOOLS\.md|IDENTITY\.md|Always follow|Mission Floor|Available tools)\b/i;

function cleanText(value = '') {
  if (typeof value === 'string') return value.replace(/\r/g, '').trim();
  if (value == null) return '';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function looksLikeFailureText(value = '') {
  return FAILURE_RE.test(String(value || ''));
}

function looksLikeSystemPromptDump(value = '') {
  const text = String(value || '').trim();
  if (text.length < 800) return false;
  const hits = (text.match(SYSTEM_PROMPT_RE) || []).length;
  return hits >= 2 || (hits >= 1 && text.length > 2500);
}

function looksLikeTruncatedStderrPrompt(value = '') {
  const text = String(value || '');
  if (!/Internal error:/i.test(text)) return false;
  return /Editing constraints|You default to ASCII|AGENTS\.md|SOUL\.md|Mission Floor|Available tools|their browser|eir browser/i
    .test(text);
}

function extractUsageLimitResetAt(text = '') {
  const match = String(text || '').match(
    /try again at\s+([A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM)?)/i,
  );
  return match?.[1]?.replace(/\s+/g, ' ').trim() || null;
}

function extractEmbeddedAcpFailureDetail(value = '') {
  const text = cleanText(value).replace(/\u001b\[[0-9;]*m/g, '');
  if (!text) return null;
  const usageSentence = text.match(/You've hit your usage limit\.[^.\n]*(?:\.[^.\n]*)?\./i)?.[0]
    || text.match(/Upgrade to Plus[^.]*\./i)?.[0]
    || null;
  if (usageSentence) return usageSentence.replace(/\s+/g, ' ').trim();
  const unhandled = text.match(/Unhandled error during turn:\s*([^\n]+)/i);
  if (unhandled?.[1]) {
    const detail = unhandled[1].replace(/\s+/g, ' ').trim();
    return detail.length > 280 ? `${detail.slice(0, 277).trim()}…` : detail;
  }
  // Prefer real Codex/CLI ERROR lines — not "ACP error (ACP_TURN_FAILED): Internal error: …".
  const errorMatches = [...text.matchAll(
    /(?:^|\n)[^\n]*\bERROR\b[^\n]{0,500}?(?:UsageLimitExceeded|Quota exceeded|usage limit|Authentication required|Unhandled error during turn|ACP_SESSION_INIT_FAILED)[^\n]{0,200}/gi,
  )];
  if (errorMatches.length) {
    const last = errorMatches[errorMatches.length - 1][0].replace(/\s+/g, ' ').trim();
    return last.length > 280 ? `${last.slice(0, 277).trim()}…` : last;
  }
  return null;
}

function sanitizeAcpDisplayText(value = '') {
  const text = cleanText(value).replace(/\u001b\[[0-9;]*m/g, '');
  if (!text) return '';
  if (looksLikeFailureText(text)) {
    const resetAt = extractUsageLimitResetAt(text);
    const embedded = extractEmbeddedAcpFailureDetail(text);
    if (/\b(UsageLimitExceeded|usage limit|Quota exceeded)\b/i.test(text)
      || (embedded && /\busage limit|UsageLimitExceeded|Quota exceeded/i.test(embedded))) {
      const when = resetAt ? ` until ${resetAt}` : '';
      return `Codex usage limit reached${when}`;
    }
    if (/\b(ACP_SESSION_INIT_FAILED|metadata is missing for agent:)\b/i.test(text)) {
      return 'ACP session is gone — start a new task';
    }
    if (embedded) return embedded;
    if (looksLikeTruncatedStderrPrompt(text)) {
      return 'Codex ACP stderr was truncated (often a ChatGPT usage limit). Check Codex account quota or retry after reset.';
    }
    const lines = text.split(/\n/).map((line) => line.trim()).filter(Boolean);
    const errorLine = [...lines].reverse().find((line) => FAILURE_RE.test(line));
    if (!errorLine) return text.slice(0, 280);
    // Prefer the end of huge Internal-error / prompt lines (CLI ERROR is last).
    if (errorLine.length > 280 && (/Internal error:/i.test(errorLine) || looksLikeSystemPromptDump(errorLine))) {
      return errorLine.slice(-280).replace(/^\S*\s+/, '').trim();
    }
    return errorLine.slice(0, 280);
  }
  if (looksLikeSystemPromptDump(text) || looksLikeTruncatedStderrPrompt(text)) {
    const embedded = extractEmbeddedAcpFailureDetail(text);
    if (embedded) return embedded;
    if (looksLikeTruncatedStderrPrompt(text)) {
      return 'Codex ACP stderr was truncated (often a ChatGPT usage limit). Check Codex account quota or retry after reset.';
    }
    const tail = text.slice(-Math.min(480, text.length)).trim();
    return `System / bootstrap context omitted (${text.length.toLocaleString()} chars).\n\nRecent:\n${tail.split(/\n/).slice(-6).join('\n')}`;
  }
  if (text.length > 8000) return `${text.slice(0, 7999).trim()}…`;
  return text;
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
        const failed = looksLikeFailureText(part.text);
        const display = sanitizeAcpDisplayText(part.text);
        const event = {
          type: failed ? 'error' : (role === 'tool' ? 'tool_result' : 'message'),
          role: failed ? 'error' : role,
          content: display,
          sourceId,
          partIndex,
          createdAt,
          ...(failed ? { errorKind: /\busage limit|UsageLimitExceeded|Quota exceeded\b/i.test(part.text) || /\busage limit|UsageLimitExceeded|Quota exceeded\b/i.test(display) ? 'acp_quota_exhausted' : 'acp_turn_failed' } : {}),
        };
        events.push(event);
        artifacts.push(...extractWorkspaceArtifacts(part.text));
        if (role !== 'tool') {
          transcript.push({
            id: sourceId,
            role: failed ? 'error' : role,
            content: display,
            createdAt,
          });
        }
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
