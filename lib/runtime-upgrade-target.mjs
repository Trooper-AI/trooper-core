const FULL_GIT_SHA = /^[a-f0-9]{40}$/i;
const DIGEST_PINNED_IMAGE = /^.+@sha256:[a-f0-9]{64}$/i;
const GITHUB_RELEASE_ASSET = /^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/i;
const PINNED_RUNTIME_RELEASE = /\/releases\/download\/org-runtime-[a-f0-9]{40}\/trooper-org-runtime\.tar\.gz(?:[?#].*)?$/i;

function invalidUpgradeRequest(message) {
  const error = new Error(message);
  error.code = 'invalid_runtime_upgrade';
  error.statusCode = 400;
  return error;
}

export function normalizeRuntimeUpgradeScope(value = 'all') {
  const scope = String(value || 'all').trim().toLowerCase();
  if (!['all', 'bridge', 'gateway'].includes(scope)) {
    throw invalidUpgradeRequest(`Unsupported upgrade scope: ${scope || '(empty)'}`);
  }
  return scope;
}

export function isImmutableRuntimeBundleUrl(value) {
  const url = String(value || '').trim();
  if (!url || url.includes('/org-runtime-latest/')) return false;
  return GITHUB_RELEASE_ASSET.test(url) || PINNED_RUNTIME_RELEASE.test(url);
}

export function validateRuntimeUpgradeRequest({ scope = 'all', target = null } = {}) {
  const normalizedScope = normalizeRuntimeUpgradeScope(scope);
  if (!target || typeof target !== 'object' || Array.isArray(target)) {
    throw invalidUpgradeRequest('A promoted runtime target is required');
  }

  const normalizedTarget = {
    openclawBridgeCommit: String(target.openclawBridgeCommit || '').trim().toLowerCase(),
    gatewayImage: String(target.gatewayImage || '').trim(),
    runtimeTarballUrl: String(target.runtimeTarballUrl || '').trim(),
  };

  if (
    ['all', 'bridge'].includes(normalizedScope)
    && !FULL_GIT_SHA.test(normalizedTarget.openclawBridgeCommit)
  ) {
    throw invalidUpgradeRequest('Promoted runtime target is missing an immutable bridge commit');
  }
  if (
    ['all', 'bridge'].includes(normalizedScope)
    && !isImmutableRuntimeBundleUrl(normalizedTarget.runtimeTarballUrl)
  ) {
    throw invalidUpgradeRequest('Promoted runtime target is missing an immutable runtime bundle');
  }
  if (
    ['all', 'gateway'].includes(normalizedScope)
    && !DIGEST_PINNED_IMAGE.test(normalizedTarget.gatewayImage)
  ) {
    throw invalidUpgradeRequest('Promoted runtime target is missing a digest-pinned gateway image');
  }

  return { scope: normalizedScope, target: normalizedTarget };
}
