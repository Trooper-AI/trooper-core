import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateGatewayNodeCommands } from './openclaw-config-migrations.mjs';

test('migrates retired node command lists to the current commands object', () => {
  const config = {
    gateway: {
      nodes: {
        allowCommands: ['canvas.navigate', 'system.run'],
        denyCommands: ['camera.snap', 'system.which'],
      },
    },
  };

  const result = migrateGatewayNodeCommands(config);

  assert.equal(result.changed, true);
  assert.deepEqual(config.gateway.nodes.commands, {
    allow: ['canvas.navigate', 'system.run', 'system.which'],
    deny: ['camera.snap'],
  });
  assert.equal(Object.hasOwn(config.gateway.nodes, 'allowCommands'), false);
  assert.equal(Object.hasOwn(config.gateway.nodes, 'denyCommands'), false);
});

test('keeps an already migrated node command policy stable', () => {
  const config = {
    gateway: {
      nodes: {
        commands: {
          allow: ['canvas.navigate', 'system.run', 'system.which'],
          deny: ['camera.snap'],
        },
      },
    },
  };

  assert.deepEqual(migrateGatewayNodeCommands(config), { changed: false });
});
