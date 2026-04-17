// Tracks tasks dispatched by the Cloudflare control-plane Durable Object.
// Metadata only: taskId, status, step, callback URL — no payload mirroring.
// The source of truth for the task body remains the original webhook call;
// this table exists so the DO can probe status and request resume.

import { sqlite } from '../db/index.mjs';

function now() { return Date.now(); }

export function recordTaskStart({ taskId, requestId, callbackUrl }) {
  if (!taskId) return;
  const stmt = sqlite.prepare(
    `INSERT INTO cf_tasks (task_id, request_id, status, step, callback_url, created_at, updated_at)
     VALUES (?, ?, 'running', 0, ?, ?, ?)
     ON CONFLICT(task_id) DO UPDATE SET
       request_id = excluded.request_id,
       callback_url = excluded.callback_url,
       updated_at = excluded.updated_at`
  );
  stmt.run(taskId, requestId || null, callbackUrl || null, now(), now());
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
    `SELECT task_id, request_id, status, step, callback_url, created_at, updated_at
     FROM cf_tasks WHERE task_id = ?`
  );
  return stmt.get(taskId) || null;
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
