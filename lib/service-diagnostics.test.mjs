import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRuntimeServiceDiagnostics } from './service-diagnostics.mjs';

test('runtime diagnostics identify the local failure point without exposing values', () => {
  const secret = 'never-return-this';
  const result = buildRuntimeServiceDiagnostics({
    env: {
      FIREBASE_PROJECT_ID: 'trooper-prod',
      FIREBASE_SERVICE_ACCOUNT: secret,
      OPENROUTER_API_KEY: secret,
      TROOPER_GITHUB_REPOS: 'Trooper-AI/trooper-core',
    },
    gatewayConnected: false,
    browserResponsive: true,
  });
  assert.equal(result.items.find((service) => service.id === 'openclaw-gateway').status, 'error');
  assert.equal(result.items.find((service) => service.id === 'github').status, 'warning');
  assert.equal(result.items.find((service) => service.id === 'browser-runtime').status, 'healthy');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('runtime diagnostics accept centrally supplied provider keys', () => {
  const result = buildRuntimeServiceDiagnostics({
    env: { OPENCLAW_COMPANY_PROVIDER_KEYS: '{managed}' },
    gatewayConnected: true,
  });
  assert.equal(result.items.find((service) => service.id === 'openrouter').status, 'configured');
});
