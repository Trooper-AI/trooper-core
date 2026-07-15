export const MESSAGE_JSON_FIELDS = new Set([
  'mentions',
  'reactions',
  'metrics',
  'tool_events',
  'file_ref',
  'diff_ref',
  'artifact_ref',
  'plan_ref',
]);

export function serializeMessageJsonField(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function deserializeMessageJsonField(value) {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !/^[\[{\"]/.test(trimmed)) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    // Preserve malformed legacy payloads instead of making the whole message
    // unreadable. Trooper's client-side normalizer will safely ignore refs that
    // are not objects.
    return value;
  }
}

/** Restore structured SQLite TEXT columns before returning an API message. */
export function normalizeMessageOutput(row = null) {
  if (!row || typeof row !== 'object') return row;
  const output = { ...row };
  for (const field of MESSAGE_JSON_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(output, field)) {
      output[field] = deserializeMessageJsonField(output[field]);
    }
  }
  return output;
}
