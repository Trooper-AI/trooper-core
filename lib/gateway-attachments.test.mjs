import test from 'node:test';
import assert from 'node:assert/strict';
import { withGatewayAttachments } from './gateway-attachments.mjs';

test('forwards native screen image attachments to the gateway agent request', () => {
  const attachments = [{
    type: 'image',
    mimeType: 'image/jpeg',
    fileName: 'mac-screen.jpg',
    content: '/9j/AA==',
  }];

  assert.deepEqual(withGatewayAttachments({ message: 'Inspect my screen.' }, attachments), {
    message: 'Inspect my screen.',
    attachments,
  });
});

test('leaves gateway requests unchanged when no attachment exists', () => {
  const params = { message: 'Text only.' };
  assert.equal(withGatewayAttachments(params, []), params);
  assert.equal(withGatewayAttachments(params, null), params);
});
