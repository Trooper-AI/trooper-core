import test from 'node:test';
import assert from 'node:assert/strict';
import { telegramGroupSessions } from './telegram-groups.mjs';

test('telegram group sessions keep numeric groups and drop DMs', () => {
  const groups = telegramGroupSessions({
    sessions: [
      { key: 'agent:main:main', status: 'done' },
      { key: 'agent:main:telegram:default:direct:6538063737', status: 'done' },
      { key: 'agent:main:telegram:group:@vaibhav', displayName: 'telegram:@vaibhav' },
      {
        key: 'agent:main:telegram:group:-5457327512',
        status: 'done',
        updatedAt: 10,
        displayName: 'telegram:g-vaibhav-sonali-flower',
      },
    ],
  });
  assert.deepEqual(groups, [{
    key: 'agent:main:telegram:group:-5457327512',
    chatId: '-5457327512',
    status: 'done',
    updatedAt: 10,
    displayName: 'telegram:g-vaibhav-sonali-flower',
  }]);
});
