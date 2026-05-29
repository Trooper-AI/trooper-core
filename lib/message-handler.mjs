/**
 * message-handler.mjs — Chat message CRUD for bridge SQLite
 *
 * Trooper central server syncs camelCase payloads here; responses use snake_case rows.
 */

import { db } from '../db/index.mjs';
import { messages as messagesTable } from '../db/schema.mjs';
import { eq, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';

const JSON_FIELDS = new Set([
  'mentions',
  'reactions',
  'metrics',
  'tool_events',
  'file_ref',
  'diff_ref',
  'artifact_ref',
  'plan_ref',
]);

const FIELD_MAP = {
  id: 'id',
  content: 'content',
  senderId: 'sender_id',
  sender_id: 'sender_id',
  senderName: 'sender_name',
  sender_name: 'sender_name',
  senderType: 'sender_type',
  sender_type: 'sender_type',
  senderAvatar: 'sender_avatar',
  sender_avatar: 'sender_avatar',
  channel: 'channel',
  type: 'type',
  replyTo: 'reply_to',
  reply_to: 'reply_to',
  runId: 'run_id',
  run_id: 'run_id',
  rawContent: 'raw_content',
  raw_content: 'raw_content',
  fallbackModel: 'fallback_model',
  fallback_model: 'fallback_model',
  createdAt: 'created_at',
  created_at: 'created_at',
  mentions: 'mentions',
  reactions: 'reactions',
  metrics: 'metrics',
  toolEvents: 'tool_events',
  tool_events: 'tool_events',
  fileRef: 'file_ref',
  file_ref: 'file_ref',
  diffRef: 'diff_ref',
  diff_ref: 'diff_ref',
  artifactRef: 'artifact_ref',
  artifact_ref: 'artifact_ref',
  planRef: 'plan_ref',
  plan_ref: 'plan_ref',
  fallback: 'fallback',
};

function serializeJsonField(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function normalizeMessageInput(body = {}) {
  const row = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (value === undefined) continue;
    const column = FIELD_MAP[key];
    if (!column) continue;
    if (JSON_FIELDS.has(column)) {
      row[column] = serializeJsonField(value);
      continue;
    }
    if (column === 'fallback') {
      row[column] = value ? 1 : 0;
      continue;
    }
    row[column] = value;
  }
  if (!row.sender_id) {
    row.sender_id = body.senderId || body.sender_id || 'unknown';
  }
  if (!row.channel) row.channel = body.channel || 'general';
  if (!row.type) row.type = body.type || 'chat';
  return row;
}

export function getMessage(id) {
  if (!id) return null;
  return db.select().from(messagesTable).where(eq(messagesTable.id, id)).get() || null;
}

export function listMessages({ channel, limit = 50 } = {}) {
  const cappedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
  const normalizedChannel = channel == null ? '' : String(channel).trim();
  const allChannels = !normalizedChannel || normalizedChannel === 'all' || normalizedChannel === '*';

  const results = allChannels
    ? db.select().from(messagesTable).orderBy(desc(messagesTable.created_at)).limit(cappedLimit).all()
    : db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.channel, normalizedChannel))
      .orderBy(desc(messagesTable.created_at))
      .limit(cappedLimit)
      .all();

  return results.reverse();
}

export function upsertMessage(body = {}) {
  const id = body.id || randomUUID();
  const existing = getMessage(id);
  const normalized = normalizeMessageInput({ ...body, id });
  const createdAt = normalized.created_at || body.createdAt || Date.now();

  if (existing) {
    const updates = { ...normalized };
    delete updates.id;
    if (!updates.created_at) delete updates.created_at;
    db.update(messagesTable).set(updates).where(eq(messagesTable.id, id)).run();
  } else {
    db.insert(messagesTable).values({
      ...normalized,
      id,
      created_at: createdAt,
    }).run();
  }

  return getMessage(id);
}

export function deleteAllMessages() {
  db.delete(messagesTable).run();
  return { success: true };
}

export function registerMessageRoutes(app, { bridgeWS } = {}) {
  app.get('/api/messages', (req, res) => {
    try {
      const { channel, limit } = req.query;
      const results = listMessages({ channel, limit });
      res.json({ messages: results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/messages/:id', (req, res) => {
    try {
      const message = getMessage(req.params.id);
      if (!message) return res.status(404).json({ error: 'Message not found' });
      res.json(message);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/messages', (req, res) => {
    try {
      const message = upsertMessage(req.body || {});
      bridgeWS?.broadcast?.('message:created', message);
      res.json(message);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/messages/:id', (req, res) => {
    try {
      const existing = getMessage(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Message not found' });
      const message = upsertMessage({ ...req.body, id: req.params.id });
      bridgeWS?.broadcast?.('message:updated', message);
      res.json(message);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/messages', (req, res) => {
    try {
      const result = deleteAllMessages();
      bridgeWS?.broadcast?.('messages:cleared', {});
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
