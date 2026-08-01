import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildEmailSessionKey,
  formatEmailWakeMessage,
  normalizeEmailWakePayload,
  validateEmailSendBody,
} from './email-utils.mjs';

function wakeBody(overrides = {}) {
  return {
    agentId: 'agent_1',
    agentName: 'Jane',
    address: 'jane.acme@trooper-mail.test',
    thread: { id: 'thread_ABC', subject: 'Need help' },
    message: {
      id: 'inbound_1',
      from: { name: 'Customer', address: 'customer@outside.test' },
      subject: 'Need help',
      text: 'Hello Jane!',
      receivedAt: '2026-07-31T00:00:00Z',
      attachments: [{ filename: 'invoice.pdf', size: 1024 }],
    },
    ...overrides,
  };
}

test('normalizeEmailWakePayload validates required fields', () => {
  assert.equal(normalizeEmailWakePayload({}).error, 'agentName or agentId required');
  assert.equal(normalizeEmailWakePayload({ agentName: 'Jane' }).error, 'thread.id required');
  assert.equal(
    normalizeEmailWakePayload({ agentName: 'Jane', thread: { id: 't1' } }).error,
    'message.id required',
  );
  const normalized = normalizeEmailWakePayload(wakeBody());
  assert.equal(normalized.error, undefined);
  assert.equal(normalized.thread.id, 'thread_ABC');
  assert.equal(normalized.message.from.address, 'customer@outside.test');
});

test('email session keys are thread-stable and sanitized', () => {
  const key = buildEmailSessionKey({ gatewayAgentId: 'spc-jane', slug: 'jane', threadId: 'thread_ABC' });
  assert.equal(key, 'agent:spc-jane:hook:trooper:jane:email-thread:thread_abc');
  // Same thread → same session key (conversation continuity).
  assert.equal(
    key,
    buildEmailSessionKey({ gatewayAgentId: 'spc-jane', slug: 'jane', threadId: 'thread_ABC' }),
  );
  const messy = buildEmailSessionKey({ gatewayAgentId: 'main', slug: 'lead', threadId: 'Thr ead/§№*)' });
  assert.match(messy, /^agent:main:hook:trooper:lead:email-thread:[a-z0-9:_-]+$/);
});

test('wake message includes routing context and safety instructions', () => {
  const payload = normalizeEmailWakePayload(wakeBody());
  const message = formatEmailWakeMessage(payload);
  assert.ok(message.includes('[EMAIL RECEIVED]'));
  assert.ok(message.includes('Customer <customer@outside.test>'));
  assert.ok(message.includes('Thread: thread_ABC'));
  assert.ok(message.includes('invoice.pdf'));
  assert.ok(message.includes('replyToThreadId'));
  assert.ok(message.includes('Never fabricate email contents'));
});

test('wake message truncates very long bodies', () => {
  const payload = normalizeEmailWakePayload(wakeBody({
    message: { ...wakeBody().message, text: 'y'.repeat(10_000) },
  }));
  const message = formatEmailWakeMessage(payload);
  assert.ok(message.includes('truncated'));
  assert.ok(message.length < 8_000);
});

test('validateEmailSendBody enforces recipients, body, and subject rules', () => {
  assert.ok(validateEmailSendBody({}).error);
  assert.ok(validateEmailSendBody({ to: 'a@b.test' }).error);
  // New thread without a subject is rejected; replies may omit it.
  assert.ok(validateEmailSendBody({ to: 'a@b.test', text: 'hi' }).error);
  const reply = validateEmailSendBody({ to: 'a@b.test', body: 'hi', replyToThreadId: 'thread_1' });
  assert.equal(reply.error, undefined);
  assert.deepEqual(reply.payload.to, ['a@b.test']);
  assert.equal(reply.payload.text, 'hi');
  assert.equal(reply.payload.replyToThreadId, 'thread_1');

  const fresh = validateEmailSendBody({ to: ['a@b.test', 'c@d.test'], subject: 'S', html: '<p>x</p>' });
  assert.equal(fresh.error, undefined);
  assert.deepEqual(fresh.payload.to, ['a@b.test', 'c@d.test']);
  assert.equal(fresh.payload.html, '<p>x</p>');
});
