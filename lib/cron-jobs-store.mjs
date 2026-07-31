/**
 * Deterministic read-modify-write helpers for OpenClaw's cron job store
 * (~/.openclaw/cron/jobs.json).
 *
 * The gateway owns and executes this store; historically the only ways to
 * CREATE a job from outside were the agent-facing cron tool (an LLM turn —
 * non-deterministic) or hand-editing the file. These helpers give the bridge
 * a deterministic create/update primitive following the precedent of the
 * existing toggle/delete routes, so control-plane schedulers can make
 * OpenClaw cron the single timer authority.
 *
 * The gateway may carry fields this module does not model, and its schema
 * can drift ahead of ours — so patches only touch a whitelisted field set
 * and ALWAYS preserve unknown fields on both the store and the job.
 */

export const CRON_JOB_SCHEMA_VERSION = 1;

export const CRON_JOB_PATCHABLE_FIELDS = Object.freeze([
  'name', 'schedule', 'message', 'delivery', 'model', 'enabled', 'sessionTarget', 'wakeMode',
]);

const SESSION_TARGETS = new Set(['isolated', 'main']);
const WAKE_MODES = new Set(['now', 'next-heartbeat']);

function cloneJson(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : {};
}

function normalizeDelivery(delivery) {
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) return { mode: 'none' };
  const mode = delivery.mode === 'announce' ? 'announce' : 'none';
  const channel = typeof delivery.channel === 'string' ? delivery.channel.trim() : '';
  // announce without a channel is a job that WILL fail at fire time — the
  // reader side already demotes these; never write one.
  if (mode === 'announce' && !channel) return { mode: 'none' };
  return mode === 'announce' ? { mode, channel } : { mode: 'none' };
}

export function normalizeCronJobInput(input = {}) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const schedule = typeof input.schedule === 'string' ? input.schedule.trim() : '';
  const message = typeof input.message === 'string' ? input.message.trim() : '';
  if (!name) return { ok: false, error: 'name is required' };
  if (!schedule) return { ok: false, error: 'schedule is required' };
  if (!message) return { ok: false, error: 'message is required' };
  return {
    ok: true,
    job: {
      name,
      schedule,
      message,
      sessionTarget: SESSION_TARGETS.has(input.sessionTarget) ? input.sessionTarget : 'isolated',
      wakeMode: WAKE_MODES.has(input.wakeMode) ? input.wakeMode : 'now',
      delivery: normalizeDelivery(input.delivery),
      ...(typeof input.model === 'string' && input.model.trim() ? { model: input.model.trim() } : {}),
      enabled: input.enabled !== false,
    },
  };
}

/**
 * Pure upsert-by-id into a jobs.json document. Unknown top-level store
 * fields and unknown fields on an existing job are preserved verbatim.
 */
export function upsertCronJob(storeJson, jobInput, { id, now = Date.now } = {}) {
  const normalized = normalizeCronJobInput(jobInput);
  if (!normalized.ok) return normalized;
  const jobId = String(id || '').trim();
  if (!jobId) return { ok: false, error: 'id is required' };
  const store = cloneJson(storeJson);
  if (!Array.isArray(store.jobs)) store.jobs = [];
  const at = now();
  const index = store.jobs.findIndex((job) => job?.id === jobId);
  if (index === -1) {
    const job = { id: jobId, ...normalized.job, createdAtMs: at, updatedAtMs: at };
    store.jobs.push(job);
    return { ok: true, store, job, created: true };
  }
  const job = { ...store.jobs[index], ...normalized.job, id: jobId, updatedAtMs: at };
  store.jobs[index] = job;
  return { ok: true, store, job, created: false };
}

/**
 * Pure whitelisted patch of an existing job. Fields outside
 * CRON_JOB_PATCHABLE_FIELDS in the patch are ignored; fields on the job
 * that we do not model are preserved.
 */
export function applyCronJobPatch(storeJson, id, patch = {}, { now = Date.now } = {}) {
  const jobId = String(id || '').trim();
  if (!jobId) return { ok: false, error: 'id is required' };
  const store = cloneJson(storeJson);
  if (!Array.isArray(store.jobs)) store.jobs = [];
  const index = store.jobs.findIndex((job) => job?.id === jobId);
  if (index === -1) return { ok: false, error: 'not_found' };
  const updates = {};
  for (const field of CRON_JOB_PATCHABLE_FIELDS) {
    if (!(field in patch)) continue;
    if (field === 'delivery') {
      updates.delivery = normalizeDelivery(patch.delivery);
    } else if (field === 'enabled') {
      updates.enabled = patch.enabled !== false;
    } else if (field === 'name' || field === 'schedule' || field === 'message' || field === 'model') {
      const value = typeof patch[field] === 'string' ? patch[field].trim() : '';
      if (value) updates[field] = value;
    } else if (field === 'sessionTarget') {
      if (SESSION_TARGETS.has(patch.sessionTarget)) updates.sessionTarget = patch.sessionTarget;
    } else if (field === 'wakeMode') {
      if (WAKE_MODES.has(patch.wakeMode)) updates.wakeMode = patch.wakeMode;
    }
  }
  const job = { ...store.jobs[index], ...updates, id: jobId, updatedAtMs: now() };
  store.jobs[index] = job;
  return { ok: true, store, job };
}
