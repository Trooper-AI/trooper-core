import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACP_GATEWAY_ROUTE_SCHEMA_VERSION,
  buildAcpGatewayCapabilities,
} from './acp-gateway-capabilities.mjs';

test('capabilities are versioned and expose only canary-validated account integrations', () => {
  const result = buildAcpGatewayCapabilities({
    commit: 'abc123',
    imageDigest: 'sha256:def456',
    canaryHarnesses: 'codex,claude,opencode',
    availabilityByHarness: {
      codex: { installed: true, authenticated: true, version: 'codex 0.146.0' },
    },
  });
  assert.equal(result.routeSchemaVersion, ACP_GATEWAY_ROUTE_SCHEMA_VERSION);
  assert.equal(result.gateway.commit, 'abc123');
  assert.equal(result.security.credentialsInControlPlane, false);
  assert.equal(result.security.browserExtensionRequired, false);
  assert.equal(result.integrations.find((entry) => entry.harness === 'codex').exposed, true);
  assert.equal(result.integrations.find((entry) => entry.harness === 'kimi').exposed, false);
  assert.equal(result.advanced.enterpriseGemini.exposed, false);
});
