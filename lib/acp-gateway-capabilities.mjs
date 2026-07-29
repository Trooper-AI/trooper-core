import { ACP_ACCOUNT_AUTH_CATALOG } from './acp-account-auth.mjs';
import { MANAGED_ACP_CLI_CATALOG } from './managed-acp-cli.mjs';

export const ACP_GATEWAY_ROUTE_SCHEMA_VERSION = 2;

function parseCanaryHarnesses(value) {
  return new Set(String(value || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean));
}

export function buildAcpGatewayCapabilities({
  commit = process.env.TROOPER_CORE_COMMIT || process.env.GIT_COMMIT || null,
  imageDigest = process.env.TROOPER_CORE_IMAGE_DIGEST || null,
  canaryHarnesses = process.env.TROOPER_ACP_CANARY_HARNESSES || '',
  availabilityByHarness = {},
} = {}) {
  const canaries = parseCanaryHarnesses(canaryHarnesses);
  const accountTargets = [
    {
      harness: 'codex',
      label: 'Codex',
      binaryPath: '/usr/local/bin/codex',
      authMode: 'device_code',
      providers: null,
      packageVersion: '0.146.0',
    },
    ...Object.entries(ACP_ACCOUNT_AUTH_CATALOG).map(([harness, recipe]) => ({
      harness,
      label: recipe.label,
      binaryPath: recipe.binaryPath,
      authMode: recipe.authMode,
      providers: recipe.providers,
      packageVersion: MANAGED_ACP_CLI_CATALOG[harness]?.packageVersion || null,
    })),
  ].map((recipe) => {
    const harness = recipe.harness;
    const managed = MANAGED_ACP_CLI_CATALOG[harness] || null;
    const availability = availabilityByHarness[harness] || null;
    const exposed = recipe.exposed !== false && canaries.has(harness);
    return {
      harness,
      label: recipe.label,
      exposed,
      canaryValidated: canaries.has(harness),
      installed: availability?.installed ?? null,
      authenticated: availability?.authenticated ?? null,
      cliVersion: availability?.version || null,
      authMode: recipe.authMode,
      providers: recipe.providers
        ? Object.entries(recipe.providers).map(([id, provider]) => ({ id, label: provider.label }))
        : [],
      managedBinaryPath: managed?.binaryPath || recipe.binaryPath || null,
      packageVersion: managed?.packageVersion || recipe.packageVersion || null,
    };
  });

  return {
    schemaVersion: ACP_GATEWAY_ROUTE_SCHEMA_VERSION,
    routeSchemaVersion: ACP_GATEWAY_ROUTE_SCHEMA_VERSION,
    gateway: {
      commit,
      imageDigest,
    },
    routes: {
      capabilities: '/gateway/capabilities',
      authJobs: '/gateway/acp/auth/:harness/jobs',
      authStatus: '/gateway/acp/auth/:harness/status',
      compatibilityCodexDeviceAuth: true,
    },
    security: {
      credentialsStoredOnRuntime: true,
      credentialsInControlPlane: false,
      browserExtensionRequired: false,
      structuredErrors: true,
    },
    integrations: accountTargets,
    advanced: {
      enterpriseGemini: {
        exposed: false,
        authMode: 'enterprise_credentials_only',
        reason: 'Personal Gemini is hidden until an official ACP integration is available.',
      },
      apiCredentials: true,
    },
  };
}
