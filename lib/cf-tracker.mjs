// Tracks tasks dispatched by the Cloudflare control-plane Durable Object.
// Locally persists the original webhook body (`payload`) so /resume can
// replay after a Bridge restart. Nothing here is ever shipped to CF.

import { sqlite } from '../db/index.mjs';

function now() { return Date.now(); }

// In-memory set of tasks currently executing in *this* Bridge process.
// A /resume request for a taskId in this set is treated as a duplicate
// call and short-circuits — the existing execution will update status.
// The set is deliberately not persisted: on Bridge restart it's empty,
// which is exactly the condition that makes replay appropriate.
const inFlight = new Set();

export function markInFlight(taskId) {
  if (taskId) inFlight.add(taskId);
}

export function clearInFlight(taskId) {
  if (taskId) inFlight.delete(taskId);
}

export function isInFlight(taskId) {
  return !!taskId && inFlight.has(taskId);
}

export function recordTaskStart({ taskId, requestId, callbackUrl, payload }) {
  if (!taskId) return;
  const stmt = sqlite.prepare(
    `INSERT INTO cf_tasks (task_id, request_id, status, step, callback_url, payload, created_at, updated_at)
     VALUES (?, ?, 'running', 0, ?, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       request_id = excluded.request_id,
       callback_url = excluded.callback_url,
       payload = excluded.payload,
       status = 'running',
       updated_at = excluded.updated_at`
  );
  stmt.run(
    taskId,
    requestId || null,
    callbackUrl || null,
    payload ? JSON.stringify(payload) : null,
    now(),
    now(),
  );
}

export function updateTaskStatus(taskId, { status, step } = {}) {
  if (!taskId) return;
  const fields = [];
  const values = [];
  if (status !== undefined) { fields.push('status = ?'); values.push(status); }
  if (step !== undefined)   { fields.push('step = ?');   values.push(step); }
  fields.push('updated_at = ?');
  values.push(now());
  values.push(taskId);
  const stmt = sqlite.prepare(
    `UPDATE cf_tasks SET ${fields.join(', ')} WHERE task_id = ?`
  );
  stmt.run(...values);
}

export function getTask(taskId) {
  if (!taskId) return null;
  const stmt = sqlite.prepare(
    `SELECT task_id, request_id, status, step, callback_url, payload, created_at, updated_at
     FROM cf_tasks WHERE task_id = ?`
  );
  return stmt.get(taskId) || null;
}

export function getTaskPayload(taskId) {
  const row = getTask(taskId);
  if (!row?.payload) return null;
  try { return JSON.parse(row.payload); } catch { return null; }
}

export async function notifyCallback(taskId, { status, step }) {
  const row = getTask(taskId);
  if (!row?.callback_url) return;
  try {
    await fetch(row.callback_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.BRIDGE_AUTH_TOKEN
          ? { Authorization: `Bearer ${process.env.BRIDGE_AUTH_TOKEN}` }
          : {}),
      },
      body: JSON.stringify({ taskId, status, step }),
    });
  } catch (err) {
    console.warn(`[cf-tracker] callback POST failed for ${taskId}: ${err.message}`);
  }
}
