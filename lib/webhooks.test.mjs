import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEBHOOK_PAYLOAD_CHAR_LIMIT,
  generateWebhookCredentials,
  normalizeWebhookInput,
  normalizeWebhookPatch,
  verifyWebhookToken,
  extractInboundToken,
  normalizeIdempotencyKey,
  buildWebhookSessionKey,
  formatWebhookWakeMessage,
  summarizeWebhookRow,
  summarizeDeliveryRow,
  resolveSyncTimeoutSeconds,
} from './webhooks.mjs';

const fakeRandomBytes = (n) => Buffer.alloc(n, 0xab);

test('generateWebhookCredentials produces wh_/whsec_ pair from injected bytes', () => {
  const creds = generateWebhookCredentials(fakeRandomBytes);
  assert.match(creds.id, /^wh_[0-9a-f]{16}$/);
  assert.match(creds.token, /^whsec_[0-9a-f]{48}$/);
});

test('normalizeWebhookInput requires name and agent, applies defaults', () => {
  assert.equal(normalizeWebhookInput({}).ok, false);
  assert.equal(normalizeWebhookInput({ name: 'Leads' }).ok, false);
  const result = normalizeWebhookInput({ name: '  Leads form  ', agent: 'Jordan' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.webhook, {
    name: 'Leads form',
    agent: 'Jordan',
    instructions: '',
    sessionMode: 'isolated',
    enabled: true,
  });
});

test('normalizeWebhookInput respects explicit sessionMode and enabled=false', () => {
  const result = normalizeWebhookInput({ name: 'n', agent: 'a', sessionMode: 'shared', enabled: false });
  assert.equal(result.webhook.sessionMode, 'shared');
  assert.equal(result.webhook.enabled, false);
  // Unknown modes fall back to isolated rather than erroring.
  assert.equal(normalizeWebhookInput({ name: 'n', agent: 'a', sessionMode: 'weird' }).webhook.sessionMode, 'isolated');
});

test('normalizeWebhookPatch whitelists fields and rejects empty patches', () => {
  assert.equal(normalizeWebhookPatch({}).ok, false);
  assert.equal(normalizeWebhookPatch({ token: 'attacker' }).ok, false);
  assert.equal(normalizeWebhookPatch({ name: '   ' }).ok, false);
  assert.equal(normalizeWebhookPatch({ sessionMode: 'nope' }).ok, false);
  const result = normalizeWebhookPatch({ name: 'New name', enabled: false, token: 'ignored' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.updates, { name: 'New name', enabled: false });
});

test('verifyWebhookToken matches exact tokens only, never throws on garbage', () => {
  assert.equal(verifyWebhookToken('whsec_abc', 'whsec_abc'), true);
  assert.equal(verifyWebhookToken('whsec_abc', 'whsec_abd'), false);
  assert.equal(verifyWebhookToken('short', 'a-much-longer-token'), false);
  assert.equal(verifyWebhookToken('', 'whsec_abc'), false);
  assert.equal(verifyWebhookToken('whsec_abc', ''), false);
  assert.equal(verifyWebhookToken(undefined, 'whsec_abc'), false);
});

test('extractInboundToken prefers Authorization, then header, then query', () => {
  assert.equal(extractInboundToken({
    headers: { authorization: 'Bearer  tok-auth ', 'x-webhook-token': 'tok-header' },
    query: { token: 'tok-query' },
  }), 'tok-auth');
  assert.equal(extractInboundToken({
    headers: { 'x-webhook-token': 'tok-header' },
    query: { token: 'tok-query' },
  }), 'tok-header');
  assert.equal(extractInboundToken({ query: { token: 'tok-query' } }), 'tok-query');
  assert.equal(extractInboundToken({}), '');
});

test('normalizeIdempotencyKey reads header first, query fallback, bounded length', () => {
  assert.equal(normalizeIdempotencyKey({ headers: { 'x-idempotency-key': ' evt-1 ' } }), 'evt-1');
  assert.equal(normalizeIdempotencyKey({ query: { event: 'submission-42' } }), 'submission-42');
  assert.equal(normalizeIdempotencyKey({}), '');
  const long = 'x'.repeat(500);
  assert.equal(normalizeIdempotencyKey({ query: { event: long } }).length, 128);
});

test('buildWebhookSessionKey: isolated appends event, shared stays stable', () => {
  const base = { gatewayAgentId: 'main', slug: 'jordan', hookId: 'wh_1', eventId: 'evt_9' };
  assert.equal(
    buildWebhookSessionKey({ ...base, sessionMode: 'isolated' }),
    'agent:main:hook:trooper:jordan:webhook:wh_1:evt_9',
  );
  assert.equal(
    buildWebhookSessionKey({ ...base, sessionMode: 'shared' }),
    'agent:main:hook:trooper:jordan:webhook:wh_1',
  );
});

test('formatWebhookWakeMessage includes hook metadata, instructions, and payload', () => {
  const message = formatWebhookWakeMessage({
    hookName: 'Leads form',
    hookId: 'wh_1',
    eventId: 'evt_9',
    instructions: 'Email the submitter a welcome note.',
    contentType: 'application/json',
    receivedAt: '2026-08-16T00:00:00.000Z',
    payload: { email: 'jane@example.com', plan: 'pro' },
  });
  assert.match(message, /^\[WEBHOOK EVENT\]/);
  assert.match(message, /Hook: Leads form \(wh_1\)/);
  assert.match(message, /Event: evt_9/);
  assert.match(message, /Email the submitter a welcome note\./);
  assert.match(message, /"email": "jane@example\.com"/);
  assert.doesNotMatch(message, /No standing instructions/);
});

test('formatWebhookWakeMessage handles empty and non-JSON bodies, truncates long ones', () => {
  const empty = formatWebhookWakeMessage({ hookName: 'h', hookId: 'wh', eventId: 'evt', payload: {} });
  assert.match(empty, /\(empty body\)/);
  assert.match(empty, /No standing instructions/);
  const long = formatWebhookWakeMessage({
    hookName: 'h', hookId: 'wh', eventId: 'evt',
    payload: { blob: 'y'.repeat(WEBHOOK_PAYLOAD_CHAR_LIMIT * 2) },
  });
  assert.match(long, /payload truncated at 6000 chars/);
});

test('summarizeWebhookRow masks the token unless includeToken is set', () => {
  const row = {
    id: 'wh_1', name: 'Leads', agent_slug: 'jordan', token: 'whsec_0123456789abcdef',
    instructions: '', session_mode: 'shared', enabled: 1, fire_count: 3,
    last_fired_at: 111, created_at: 100, updated_at: 110,
  };
  const summary = summarizeWebhookRow(row);
  assert.equal(summary.token, undefined);
  assert.equal(summary.tokenPreview, 'whsec_…cdef');
  assert.equal(summary.path, '/webhook/in/wh_1');
  assert.equal(summary.sessionMode, 'shared');
  assert.equal(summary.enabled, true);
  const withToken = summarizeWebhookRow(row, { includeToken: true });
  assert.equal(withToken.token, 'whsec_0123456789abcdef');
});

test('summarizeDeliveryRow maps snake_case receipt to API shape', () => {
  const summary = summarizeDeliveryRow({
    id: 'evt_9', webhook_id: 'wh_1', status: 'completed', via: 'websocket',
    session_key: 'agent:main:hook:trooper:jordan:webhook:wh_1:evt_9',
    idempotency_key: 'sub-1', payload_excerpt: '{"a":1}', result_excerpt: 'Done.',
    error: null, received_at: 100, finished_at: 200,
  });
  assert.equal(summary.eventId, 'evt_9');
  assert.equal(summary.status, 'completed');
  assert.equal(summary.sessionKey, 'agent:main:hook:trooper:jordan:webhook:wh_1:evt_9');
  assert.equal(summary.resultExcerpt, 'Done.');
});

test('resolveSyncTimeoutSeconds clamps to [5, 300] with 120 default', () => {
  assert.equal(resolveSyncTimeoutSeconds(undefined), 120);
  assert.equal(resolveSyncTimeoutSeconds('abc'), 120);
  assert.equal(resolveSyncTimeoutSeconds('60'), 60);
  assert.equal(resolveSyncTimeoutSeconds(1), 5);
  assert.equal(resolveSyncTimeoutSeconds(9999), 300);
});
