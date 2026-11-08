import { execFile as nodeExecFile } from 'child_process';
import { redactManagedAcpCliOutput } from './managed-acp-cli.mjs';

export const DEFAULT_OPENCLAW_PROVIDER_STATUS_TIMEOUT_MS = 15_000;
export const DEFAULT_OPENCLAW_PROVIDER_PROBE_TIMEOUT_MS = 30_000;

const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;

function normalizeContainerName(value) {
  const name = String(value || '').trim();
  if (!CONTAINER_NAME_PATTERN.test(name)) throw new Error('Invalid OpenClaw gateway container.');
  return name;
}

function normalizeProvider(value) {
  const provider = String(value || '').trim();
  if (!PROVIDER_ID_PATTERN.test(provider)) {
    const error = new Error('Choose a valid OpenClaw provider.');
    error.statusCode = 400;
    error.code = 'OPENCLAW_PROVIDER_INVALID';
    throw error;
  }
  return provider;
}

function normalizeProfileId(value) {
  const profileId = String(value || '').trim();
  if (profileId && !PROFILE_ID_PATTERN.test(profileId)) {
    const error = new Error('Choose a valid OpenClaw account profile.');
    error.statusCode = 400;
    error.code = 'OPENCLAW_PROVIDER_PROFILE_INVALID';
    throw error;
  }
  return profileId;
}

/**
 * Build a fixed argv for OpenClaw provider status. Provider/profile values are
 * validated and passed as individual argv entries; no client shell command is
 * accepted and this does not weaken the plugin-only /gateway/exec allowlist.
 */
export function buildOpenClawProviderStatusDockerArgs({
  containerName,
  provider = '',
  profileId = '',
  probe = false,
} = {}) {
  const container = normalizeContainerName(containerName);
  const providerId = provider ? normalizeProvider(provider) : '';
  const accountProfileId = normalizeProfileId(profileId);
  if (probe && !providerId) {
    const error = new Error('Choose a provider before running a live check.');
    error.statusCode = 400;
    error.code = 'OPENCLAW_PROVIDER_REQUIRED';
    throw error;
  }

  const timeoutMs = probe
    ? DEFAULT_OPENCLAW_PROVIDER_PROBE_TIMEOUT_MS
    : DEFAULT_OPENCLAW_PROVIDER_STATUS_TIMEOUT_MS;
  const timeoutArgs = [
    'timeout', '--foreground', '--signal=TERM', '--kill-after=5s', `${Math.ceil(timeoutMs / 1000)}s`,
  ];
  const statusArgs = ['openclaw', 'models', 'status', '--json'];
  if (probe) {
    statusArgs.push('--probe', '--probe-provider', providerId);
    if (accountProfileId) statusArgs.push('--probe-profile', accountProfileId);
    statusArgs.push('--probe-max-tokens', '1', '--probe-timeout', '15000');
  }
  return [
    'exec', '-u', 'node', '-w', '/home/node', '-e', 'HOME=/home/node', container,
    ...timeoutArgs,
    ...statusArgs,
  ];
}

function parseStatusOutput(value) {
  const output = String(value || '').trim();
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(output.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeStatusText(value, limit = 1_000) {
  return redactManagedAcpCliOutput(value, limit).trim();
}

function safeStatusEnvelope(status) {
  const oauth = status?.auth?.oauth || {};
  const providers = Array.isArray(oauth.providers) ? oauth.providers : [];
  const profiles = Array.isArray(oauth.profiles) ? oauth.profiles : [];
  const probeResults = Array.isArray(status?.probes?.results) ? status.probes.results : [];
  return {
    auth: {
      oauth: {
        providers: providers.map((item) => ({
          provider: String(item?.provider || ''),
          status: String(item?.status || 'unknown'),
        })),
        profiles: profiles.map((item) => ({
          provider: String(item?.provider || ''),
          profileId: String(item?.profileId || ''),
          label: safeStatusText(item?.label || item?.profileId || '', 200),
          status: String(item?.status || 'unknown'),
          expiresAt: Number.isFinite(Number(item?.expiresAt)) ? Number(item.expiresAt) : null,
        })),
      },
    },
    probes: {
      results: probeResults.map((item) => ({
        provider: String(item?.provider || ''),
        profileId: String(item?.profileId || ''),
        model: safeStatusText(item?.model || '', 200),
        status: String(item?.status || 'unknown'),
        error: safeStatusText(item?.error || '', 1_000),
        latencyMs: Number.isFinite(Number(item?.latencyMs)) ? Number(item.latencyMs) : null,
      })),
    },
  };
}

function commandOutput(error) {
  return [error?.stderr, error?.stdout, error?.message]
    .map((part) => String(part || '').trim())
    .find(Boolean) || 'OpenClaw provider status command failed.';
}

function makeStatusError(error, stdout = '') {
  const detail = parseStatusOutput(stdout);
  if (detail) return { status: safeStatusEnvelope(detail) };
  const message = safeStatusText(commandOutput(error), 800);
  const safeError = new Error(message || 'OpenClaw could not inspect provider status.');
  safeError.code = 'OPENCLAW_PROVIDER_STATUS_FAILED';
  safeError.statusCode = 503;
  return { error: safeError };
}

function defaultExecFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      ...options,
    }, (error, stdout = '', stderr = '') => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export class OpenClawProviderHealthManager {
  constructor({ containerName, execFile = defaultExecFile } = {}) {
    this.containerName = normalizeContainerName(containerName);
    this.execFile = execFile;
  }

  async run({ provider = '', profileId = '', probe = false } = {}) {
    const args = buildOpenClawProviderStatusDockerArgs({
      containerName: this.containerName,
      provider,
      profileId,
      probe,
    });
    const timeoutMs = probe
      ? DEFAULT_OPENCLAW_PROVIDER_PROBE_TIMEOUT_MS + 5_000
      : DEFAULT_OPENCLAW_PROVIDER_STATUS_TIMEOUT_MS + 3_000;
    let output = '';
    try {
      const result = await this.execFile('docker', args, { timeout: timeoutMs });
      output = String(result?.stdout || '');
    } catch (error) {
      const failed = makeStatusError(error, error?.stdout);
      if (failed.error) throw failed.error;
      return { ok: true, status: failed.status };
    }

    const status = parseStatusOutput(output);
    if (!status) {
      const error = new Error('OpenClaw returned an unreadable provider status response.');
      error.statusCode = 503;
      error.code = 'OPENCLAW_PROVIDER_STATUS_INVALID';
      throw error;
    }
    return { ok: true, status: safeStatusEnvelope(status) };
  }
}
