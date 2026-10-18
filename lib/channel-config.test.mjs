import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTelegramTokenToOpenClawConfig,
  buildTelegramEnvUpdates,
  extractTelegramTokenFromPayload,
} from './channel-config.mjs';

test('extractTelegramTokenFromPayload normalizes pasted env-style tokens', () => {
  assert.equal(
    extractTelegramTokenFromPayload({ telegramToken: 'TELEGRAM_BOT_TOKEN="123456:abc"\nignored' }),
    '123456:abc',
  );
});

test('buildTelegramEnvUpdates maps Trooper Telegram payload to OpenClaw env', () => {
  assert.deepEqual(buildTelegramEnvUpdates({ telegramToken: ' 123456:abc ' }), {
    TELEGRAM_BOT_TOKEN: '123456:abc',
  });
  assert.deepEqual(buildTelegramEnvUpdates({}), {});
});

test('applyTelegramTokenToOpenClawConfig enables Telegram without the rejected mode field', () => {
  const original = {
    channels: {
      telegram: {
        allowFrom: ['telegram:user:1'],
        mode: 'polling',
        enabled: false,
      },
    },
    agents: { defaults: { model: { primary: 'openai/gpt-5.2' } } },
  };
  const result = applyTelegramTokenToOpenClawConfig(original, '123456:abc');

  assert.equal(result.changed, true);
  assert.equal(result.configured, true);
  assert.equal(result.config.channels.telegram.botToken, '123456:abc');
  assert.equal(result.config.channels.telegram.enabled, true);
  assert.equal(result.config.channels.telegram.mode, undefined);
  assert.equal(result.config.channels.telegram.dmPolicy, 'allowlist');
  assert.deepEqual(result.config.channels.telegram.allowFrom, ['telegram:user:1']);
  assert.equal(original.channels.telegram.botToken, undefined);
});

test('applyTelegramTokenToOpenClawConfig opens DMs when nobody is on the allow list yet', () => {
  const result = applyTelegramTokenToOpenClawConfig({}, '123456:abc');
  assert.equal(result.config.channels.telegram.dmPolicy, 'open');
  assert.deepEqual(result.config.channels.telegram.allowFrom, ['*']);
  assert.equal(result.config.channels.telegram.mode, undefined);
});

test('applyTelegramTokenToOpenClawConfig clears Telegram when an empty token is saved', () => {
  const result = applyTelegramTokenToOpenClawConfig(
    { channels: { telegram: { botToken: 'old', mode: 'polling' } } },
    '',
  );

  assert.equal(result.changed, true);
  assert.equal(result.configured, false);
  assert.equal(result.config.channels.telegram.botToken, undefined);
  assert.equal(result.config.channels.telegram.enabled, false);
  assert.equal(result.config.channels.telegram.mode, undefined);
});
