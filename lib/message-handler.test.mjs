import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMessageOutput,
  serializeMessageJsonField,
} from './message-json-fields.mjs';

test('message JSON fields round-trip as typed values', () => {
  const artifactRef = {
    type: 'video-project',
    kind: 'video-project',
    projectId: 'video_123',
    title: 'Launch cut',
    path: 'Videos/video_123/project.json',
  };
  const stored = {
    id: 'message-1',
    sender_id: 'agent-1',
    artifact_ref: serializeMessageJsonField(artifactRef),
    tool_events: serializeMessageJsonField([{ event: 'tool_result', data: { success: true } }]),
  };

  assert.equal(typeof stored.artifact_ref, 'string');
  const hydrated = normalizeMessageOutput(stored);
  assert.deepEqual(hydrated.artifact_ref, artifactRef);
  assert.deepEqual(hydrated.tool_events, [{ event: 'tool_result', data: { success: true } }]);
});

test('malformed legacy JSON fields remain readable', () => {
  const hydrated = normalizeMessageOutput({
    id: 'message-2',
    artifact_ref: '{not-json',
    mentions: null,
  });

  assert.equal(hydrated.artifact_ref, '{not-json');
  assert.equal(hydrated.mentions, null);
});
