import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GATEWAY_FEATURES_SCHEMA_VERSION,
  parseGatewayFeatures,
  hasGatewayMethod,
  hasGatewayEvent,
  orderMethodCandidates,
  summarizeGatewayFeatures,
} from './gateway-capabilities-handshake.mjs';

test('absent or malformed features parse to null (older gateways)', () => {
  assert.equal(parseGatewayFeatures(undefined), null);
  assert.equal(parseGatewayFeatures({}), null);
  assert.equal(parseGatewayFeatures({ features: 'nope' }), null);
  assert.equal(parseGatewayFeatures({ features: { methods: [], events: [] } }), null);
});

test('array-shaped features parse into frozen sets', () => {
  const features = parseGatewayFeatures(
    { features: { methods: ['sessions.abort', 'chat.send'], events: ['agent'] } },
    { now: () => 42 },
  );
  assert.equal(features.schemaVersion, GATEWAY_FEATURES_SCHEMA_VERSION);
  assert.equal(features.receivedAt, 42);
  assert.equal(features.methods.has('sessions.abort'), true);
  assert.equal(features.events.has('agent'), true);
  assert.ok(Object.isFrozen(features));
});

test('object-keyed features (methods as map) parse via keys', () => {
  const features = parseGatewayFeatures({ features: { methods: { 'node.list': {}, 'chat.send': {} } } });
  assert.equal(features.methods.has('node.list'), true);
});

test('junk entries are dropped, not thrown', () => {
  const features = parseGatewayFeatures({ features: { methods: ['ok', '', null, 42], events: null } });
  assert.deepEqual([...features.methods], ['ok', '42']);
  assert.equal(features.events.size, 0);
});

test('hasGatewayMethod answers null without handshake data — never infer', () => {
  assert.equal(hasGatewayMethod(null, 'sessions.abort'), null);
  const features = parseGatewayFeatures({ features: { methods: ['sessions.abort'] } });
  assert.equal(hasGatewayMethod(features, 'sessions.abort'), true);
  assert.equal(hasGatewayMethod(features, 'chat.abort'), false);
  assert.equal(hasGatewayEvent(features, 'agent'), null);
});

test('orderMethodCandidates never drops a candidate (features may under-report)', () => {
  const features = parseGatewayFeatures({ features: { methods: ['chat.abort'] } });
  const ordered = orderMethodCandidates(features, ['sessions.abort', 'chat.abort']);
  assert.deepEqual(ordered, ['chat.abort', 'sessions.abort']);
  assert.deepEqual(orderMethodCandidates(null, ['a', 'b']), ['a', 'b']);
  assert.deepEqual(
    orderMethodCandidates(features, ['sessions.abort', 'chat.abort']).sort(),
    ['chat.abort', 'sessions.abort'],
  );
});

test('summarize round-trips to JSON-safe sorted arrays', () => {
  const features = parseGatewayFeatures(
    { features: { methods: ['b', 'a'], events: ['z', 'y'] } },
    { now: () => 7 },
  );
  assert.deepEqual(summarizeGatewayFeatures(features), {
    schemaVersion: GATEWAY_FEATURES_SCHEMA_VERSION,
    methods: ['a', 'b'],
    events: ['y', 'z'],
    receivedAt: 7,
  });
  assert.equal(summarizeGatewayFeatures(null), null);
});
