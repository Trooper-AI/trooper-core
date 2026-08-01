// Pure helpers for the bridge email surface (/webhook/email + /email/*).
// Kept free of I/O so node --test can exercise them directly.

const EMAIL_WAKE_BODY_LIMIT = 6000;

export function normalizeEmailWakePayload(body = {}) {
  const agentName = String(body.agentName || '').trim();
  const agentId = String(body.agentId || '').trim();
  const thread = body.thread && typeof body.thread === 'object' ? body.thread : {};
  const message = body.message && typeof body.message === 'object' ? body.message : {};
  const threadId = String(thread.id || body.threadId || '').trim();
  const messageId = String(message.id || '').trim();
  if (!agentName && !agentId) return { error: 'agentName or agentId required' };
  if (!threadId) return { error: 'thread.id required' };
  if (!messageId) return { error: 'message.id required' };
  const from = message.from && typeof message.from === 'object'
    ? { name: String(message.from.name || ''), address: String(message.from.address || '') }
    : { name: '', address: String(message.from || '') };
  return {
    agentName,
    agentId,
    address: String(body.address || '').trim(),
    thread: {
      id: threadId,
      subject: String(thread.subject || message.subject || '').trim(),
    },
    message: {
      id: messageId,
      from,
      subject: String(message.subject || '').trim(),
      text: String(message.text || ''),
      receivedAt: String(message.receivedAt || ''),
      attachments: Array.isArray(message.attachments)
        ? message.attachments.map((attachment) => ({
          filename: String(attachment?.filename || 'attachment'),
          size: Number(attachment?.size || 0),
        }))
        : [],
    },
  };
}

/**
 * Session key for email threads: every message in a larasend thread lands in
 * the same agent session, so the agent keeps conversational context.
 */
export function buildEmailSessionKey({ gatewayAgentId, slug, threadId }) {
  const cleanThread = String(threadId || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'unthreaded';
  return `agent:${gatewayAgentId}:hook:trooper:${slug}:email-thread:${cleanThread}`;
}

export function formatEmailWakeMessage(payload) {
  const { thread, message, address } = payload;
  const fromLabel = message.from.name
    ? `${message.from.name} <${message.from.address}>`
    : message.from.address;
  const truncated = message.text.length > EMAIL_WAKE_BODY_LIMIT;
  const bodyText = truncated
    ? `${message.text.slice(0, EMAIL_WAKE_BODY_LIMIT)}\n… (truncated — fetch the full thread via the trooper-email skill)`
    : (message.text || '(no text body)');
  const attachmentNote = payload.message.attachments.length
    ? `\nAttachments (metadata only): ${payload.message.attachments.map((attachment) => attachment.filename).join(', ')}`
    : '';
  return `[EMAIL RECEIVED]
To: you${address ? ` (${address})` : ''}
From: ${fromLabel}
Subject: ${message.subject || '(no subject)'}
Thread: ${thread.id}
Message: ${message.id}${attachmentNote}
---
${bodyText}
---
Handle this email as ${payload.agentName || 'the assigned agent'}. If a reply is warranted, send it with the trooper-email skill:
POST http://127.0.0.1:3002/email/send with JSON {"to": ["${message.from.address}"], "body": "...", "replyToThreadId": "${thread.id}"} and Authorization: Bearer $BRIDGE_AUTH_TOKEN.
Never fabricate email contents, senders, or recipients. If no action is needed, note why and stop.`;
}

export function validateEmailSendBody(body = {}) {
  const to = Array.isArray(body.to)
    ? body.to.map((entry) => String(entry).trim()).filter(Boolean)
    : String(body.to || '').split(/[,;]+/).map((entry) => entry.trim()).filter(Boolean);
  if (!to.length) return { error: 'At least one "to" recipient is required' };
  const text = String(body.text || body.body || '').trim();
  const html = String(body.html || '').trim();
  if (!text && !html) return { error: 'Email body ("text"/"body" or "html") is required' };
  const subject = String(body.subject || '').trim();
  const replyToThreadId = String(body.replyToThreadId || body.reply_to_thread_id || '').trim();
  if (!subject && !replyToThreadId) return { error: 'Subject is required for new threads' };
  return {
    payload: {
      to,
      cc: Array.isArray(body.cc) ? body.cc : undefined,
      bcc: Array.isArray(body.bcc) ? body.bcc : undefined,
      subject,
      text: text || undefined,
      html: html || undefined,
      replyToThreadId: replyToThreadId || undefined,
      inReplyToMessageId: String(body.inReplyToMessageId || '').trim() || undefined,
      attachments: Array.isArray(body.attachments) ? body.attachments : undefined,
    },
  };
}
