// Pure helpers for the bridge inbound-webhook surface (/webhook/in/:hookId +
// /webhook/manage/*). Kept free of I/O so node --test can exercise them
// directly.
//
// A webhook is a standing inbound trigger: an external system (form provider,
// payment processor, CI job) POSTs an event to /webhook/in/<hookId> with the
// hook's secret token and the bridge wakes the configured agent with the
// payload — the event-driven counterpart to OpenClaw cron's time-driven wakes.

import { createHash, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_PAYLOAD_CHAR_LIMIT = 6000;
export const WEBHOOK_INSTRUCTIONS_CHAR_LIMIT = 4000;
export const WEBHOOK_NAME_CHAR_LIMIT = 120;
export const WEBHOOK_IDEMPOTENCY_KEY_CHAR_LIMIT = 128;
export const WEBHOOK_DELIVERY_KEEP = 50;
export const WEBHOOK_SYNC_TIMEOUT_DEFAULT_SECONDS = 120;
export const WEBHOOK_SYNC_TIMEOUT_MAX_SECONDS = 300;

const SESSION_MODES = new Set(['isolated', 'shared']);

export const WEBHOOK_PATCHABLE_FIELDS = Object.freeze([
  'name', 'agent', 'instructions', 'sessionMode', 'enabled', 'workflowId',
]);

/**
 * A hook targets one of two things. By default the event wakes `agent`. When
 * `workflowId` is set, the event instead runs that saved workflow — the bridge
 * forwards it to Mission Control, which owns workflow execution. `agent`
 * stays populated either way so unbinding the workflow restores agent wakes.
 */
function normalizeWorkflowId(value) {
  if (value === null) return null;
  const id = typeof value === 'string' ? value.trim() : '';
  return id ? id.slice(0, 128) : null;
}

/**
 * URL id + bearer secret for a new hook. `randomBytes` is injected so tests
 * stay deterministic; callers pass crypto.randomBytes.
 */
export function generateWebhookCredentials(randomBytes) {
  return {
    id: `wh_${randomBytes(8).toString('hex')}`,
    token: `whsec_${randomBytes(24).toString('hex')}`,
  };
}

export function normalizeWebhookInput(input = {}) {
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, WEBHOOK_NAME_CHAR_LIMIT) : '';
  const agent = typeof input.agent === 'string' ? input.agent.trim() : '';
  if (!name) return { ok: false, error: 'name is required' };
  if (!agent) return { ok: false, error: 'agent is required' };
  const instructions = typeof input.instructions === 'string'
    ? input.instructions.trim().slice(0, WEBHOOK_INSTRUCTIONS_CHAR_LIMIT)
    : '';
  return {
    ok: true,
    webhook: {
      name,
      agent,
      instructions,
      sessionMode: SESSION_MODES.has(input.sessionMode) ? input.sessionMode : 'isolated',
      enabled: input.enabled !== false,
      workflowId: normalizeWorkflowId(input.workflowId),
    },
  };
}

/**
 * Whitelist-only patch, mirroring the cron-jobs-store precedent: unknown
 * fields are ignored, provided fields are validated individually.
 */
export function normalizeWebhookPatch(input = {}) {
  const updates = {};
  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim().slice(0, WEBHOOK_NAME_CHAR_LIMIT) : '';
    if (!name) return { ok: false, error: 'name cannot be empty' };
    updates.name = name;
  }
  if (input.agent !== undefined) {
    const agent = typeof input.agent === 'string' ? input.agent.trim() : '';
    if (!agent) return { ok: false, error: 'agent cannot be empty' };
    updates.agent = agent;
  }
  if (input.instructions !== undefined) {
    updates.instructions = typeof input.instructions === 'string'
      ? input.instructions.trim().slice(0, WEBHOOK_INSTRUCTIONS_CHAR_LIMIT)
      : '';
  }
  if (input.sessionMode !== undefined) {
    if (!SESSION_MODES.has(input.sessionMode)) return { ok: false, error: 'sessionMode must be "isolated" or "shared"' };
    updates.sessionMode = input.sessionMode;
  }
  if (input.enabled !== undefined) updates.enabled = input.enabled !== false;
  // null is meaningful here: it unbinds the workflow and restores agent wakes.
  if (input.workflowId !== undefined) updates.workflowId = normalizeWorkflowId(input.workflowId);
  if (Object.keys(updates).length === 0) return { ok: false, error: 'no patchable fields provided' };
  return { ok: true, updates };
}

/**
 * Constant-time token comparison. Both sides are hashed to a fixed length
 * first so timingSafeEqual never throws on length mismatch (and length is
 * not leaked through an early return).
 */
export function verifyWebhookToken(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !provided || !expected) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Callers authenticate with any of: `Authorization: Bearer <token>`,
 * `X-Webhook-Token: <token>`, or `?token=<token>` — in that precedence.
 * The query form exists because many form/webhook providers can only be
 * configured with a bare URL.
 */
export function extractInboundToken({ headers = {}, query = {} } = {}) {
  const auth = typeof headers.authorization === 'string' ? headers.authorization.trim() : '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const headerToken = typeof headers['x-webhook-token'] === 'string' ? headers['x-webhook-token'].trim() : '';
  if (headerToken) return headerToken;
  const queryToken = typeof query.token === 'string' ? query.token.trim() : '';
  return queryToken;
}

/**
 * Caller-supplied replay guard: `X-Idempotency-Key` header (or `?event=`)
 * lets a provider retry a delivery without triggering a second agent run.
 */
export function normalizeIdempotencyKey({ headers = {}, query = {} } = {}) {
  const raw = typeof headers['x-idempotency-key'] === 'string' && headers['x-idempotency-key'].trim()
    ? headers['x-idempotency-key']
    : (typeof query.event === 'string' ? query.event : '');
  return raw.trim().slice(0, WEBHOOK_IDEMPOTENCY_KEY_CHAR_LIMIT);
}

/**
 * Session key for webhook wakes, following the email-thread precedent
 * (lib/email-utils.mjs): `isolated` gives every event a fresh session,
 * `shared` funnels all events for a hook into one continuous session so the
 * agent keeps context across deliveries.
 */
export function buildWebhookSessionKey({ gatewayAgentId, slug, hookId, eventId, sessionMode }) {
  const base = `agent:${gatewayAgentId}:hook:trooper:${slug}:webhook:${hookId}`;
  return sessionMode === 'shared' ? base : `${base}:${eventId}`;
}

function renderPayload(payload) {
  if (payload === undefined || payload === null) return '(empty body)';
  if (typeof payload === 'string') return payload || '(empty body)';
  try {
    const json = JSON.stringify(payload, null, 2);
    if (json === '{}' || json === '[]') return '(empty body)';
    return json;
  } catch {
    return String(payload);
  }
}

export function formatWebhookWakeMessage({ hookName, hookId, eventId, instructions, contentType, receivedAt, payload }) {
  const rendered = renderPayload(payload);
  const truncated = rendered.length > WEBHOOK_PAYLOAD_CHAR_LIMIT;
  const body = truncated
    ? `${rendered.slice(0, WEBHOOK_PAYLOAD_CHAR_LIMIT)}\n… (payload truncated at ${WEBHOOK_PAYLOAD_CHAR_LIMIT} chars)`
    : rendered;
  const lines = [
    '[WEBHOOK EVENT]',
    `Hook: ${hookName} (${hookId})`,
    `Event: ${eventId}`,
  ];
  if (receivedAt) lines.push(`Received: ${receivedAt}`);
  if (contentType) lines.push(`Content-Type: ${contentType}`);
  lines.push('');
  if (instructions) {
    lines.push('Instructions for handling this event:', instructions, '');
  }
  lines.push('Payload:', body);
  if (!instructions) {
    lines.push('', 'No standing instructions are configured for this hook — decide the appropriate action from the payload and complete it.');
  }
  return lines.join('\n');
}

/**
 * Payload handed to Mission Control for a workflow-bound hook. The workflow
 * engine takes a free-text `request`, so the event is rendered the same way
 * an agent would see it — minus the agent-facing framing.
 */
export function buildWorkflowRunRequest({ hookName, hookId, eventId, instructions, payload }) {
  const rendered = renderPayload(payload);
  const truncated = rendered.length > WEBHOOK_PAYLOAD_CHAR_LIMIT;
  const body = truncated
    ? `${rendered.slice(0, WEBHOOK_PAYLOAD_CHAR_LIMIT)}\n… (payload truncated at ${WEBHOOK_PAYLOAD_CHAR_LIMIT} chars)`
    : rendered;
  const lines = [`Webhook "${hookName}" (${hookId}) fired — event ${eventId}.`];
  if (instructions) lines.push('', instructions);
  lines.push('', 'Event payload:', body);
  return lines.join('\n');
}

function maskToken(token) {
  const t = String(token || '');
  if (t.length <= 10) return '••••';
  return `${t.slice(0, 6)}…${t.slice(-4)}`;
}

/**
 * DB row (snake_case) → API shape (camelCase). The full token is only
 * included when the caller says so (management surface, which is already
 * behind bridge auth) — delivery receipts and logs get the masked form.
 */
export function summarizeWebhookRow(row, { includeToken = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    agent: row.agent_slug,
    instructions: row.instructions || '',
    sessionMode: row.session_mode === 'shared' ? 'shared' : 'isolated',
    enabled: row.enabled === 1 || row.enabled === true,
    workflowId: row.workflow_id || null,
    target: row.workflow_id ? 'workflow' : 'agent',
    path: `/webhook/in/${row.id}`,
    tokenPreview: maskToken(row.token),
    ...(includeToken ? { token: row.token } : {}),
    fireCount: row.fire_count || 0,
    lastFiredAt: row.last_fired_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

export function summarizeDeliveryRow(row) {
  if (!row) return null;
  return {
    eventId: row.id,
    webhookId: row.webhook_id,
    status: row.status,
    via: row.via || null,
    target: row.target || 'agent',
    workflowId: row.workflow_id || null,
    sessionKey: row.session_key || null,
    idempotencyKey: row.idempotency_key || null,
    payloadExcerpt: row.payload_excerpt || null,
    resultExcerpt: row.result_excerpt || null,
    error: row.error || null,
    receivedAt: row.received_at || null,
    finishedAt: row.finished_at || null,
  };
}

export function resolveSyncTimeoutSeconds(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return WEBHOOK_SYNC_TIMEOUT_DEFAULT_SECONDS;
  return Math.min(Math.max(Math.floor(n), 5), WEBHOOK_SYNC_TIMEOUT_MAX_SECONDS);
}
