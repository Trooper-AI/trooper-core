import { execFile as nodeExecFile } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redactManagedAcpCliOutput } from './managed-acp-cli.mjs';

export const DEFAULT_OPENCLAW_PROVIDER_STATUS_TIMEOUT_MS = 15_000;
export const DEFAULT_OPENCLAW_PROVIDER_PROBE_TIMEOUT_MS = 30_000;
// Codex usage-window calls can take longer than ordinary status reads. Keep
// the background settings request alive long enough to return the 5h/week
// quota windows instead of caching a timeout on a healthy account.
export const DEFAULT_OPENCLAW_PROVIDER_USAGE_TIMEOUT_MS = 60_000;
const PROVIDER_USAGE_CACHE_TTL_MS = 60_000;
const DEFAULT_APP_POOL_OPENCLAW_CLI_PATH = '/usr/local/bin/openclaw';

const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const PROFILE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;
const PROBE_MODEL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9._:/-]{0,255}$/i;
const PROVIDER_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY',
  'MISTRAL_API_KEY', 'QWEN_API_KEY', 'MODELSTUDIO_API_KEY', 'DASHSCOPE_API_KEY', 'DEEPSEEK_API_KEY',
  'XAI_API_KEY', 'PERPLEXITY_API_KEY', 'MINIMAX_API_KEY', 'ZAI_API_KEY', 'MOONSHOT_API_KEY',
  'KIMI_API_KEY', 'KIMICODE_API_KEY', 'GROQ_API_KEY', 'CEREBRAS_API_KEY', 'TOGETHER_API_KEY',
  'NVIDIA_API_KEY', 'QIANFAN_API_KEY', 'STEPFUN_API_KEY', 'VENICE_API_KEY', 'HUGGINGFACE_HUB_TOKEN',
  'HF_TOKEN', 'AI_GATEWAY_API_KEY', 'CLOUDFLARE_AI_GATEWAY_API_KEY', 'SYNTHETIC_API_KEY',
  'VOLCANO_ENGINE_API_KEY', 'BYTEPLUS_API_KEY', 'OLLAMA_BASE_URL',
  'AWS_BEARER_TOKEN_BEDROCK', 'AWS_REGION', 'COHERE_API_KEY', 'FIREWORKS_API_KEY',
  'COPILOT_GITHUB_TOKEN', 'LITELLM_API_KEY', 'LM_API_TOKEN', 'REQUESTY_API_KEY',
]);

function normalizeContainerName(value) {
  const name = String(value || '').trim();
  if (!CONTAINER_NAME_PATTERN.test(name)) throw new Error('Invalid OpenClaw gateway container.');
  return name;
}

function normalizeProvider(value) {
  const requested = String(value || '').trim();
  const provider = requested.toLowerCase() === 'openai-codex' ? 'openai' : requested;
  if (!PROVIDER_ID_PATTERN.test(provider)) {
    const error = new Error('Choose a valid OpenClaw provider.');
    error.statusCode = 400;
    error.code = 'OPENCLAW_PROVIDER_INVALID';
    throw error;
  }
  return provider;
}

function normalizeProfileId(value) {
  const requested = String(value || '').trim();
  const profileId = requested.replace(/^openai-codex:(.+)$/i, 'openai:codex-$1');
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
  const timeoutArgs = buildTimeoutArgs(timeoutMs);
  const statusArgs = buildOpenClawProviderStatusCommandArgs({ providerId, accountProfileId, probe });
  return [
    'exec', '-u', 'node', '-w', '/home/node', '-e', 'HOME=/home/node', container,
    ...timeoutArgs,
    'openclaw',
    ...statusArgs,
  ];
}

function buildTimeoutArgs(timeoutMs) {
  return [
    'timeout', '--foreground', '--signal=TERM', '--kill-after=5s', `${Math.ceil(timeoutMs / 1000)}s`,
  ];
}

function buildOpenClawProviderStatusCommandArgs({ providerId = '', accountProfileId = '', probe = false } = {}) {
  const statusArgs = ['models', 'status', '--json'];
  if (probe) {
    statusArgs.push('--probe', '--probe-provider', providerId);
    if (accountProfileId) statusArgs.push('--probe-profile', accountProfileId);
    statusArgs.push('--probe-max-tokens', '1', '--probe-timeout', '15000');
  }
  return statusArgs;
}

function buildOpenClawProviderUsageCommandArgs() {
  return ['status', '--usage', '--json'];
}

/**
 * In app-pool, the bridge and OpenClaw CLI run in the same container. Calling
 * `docker exec` from that container cannot work because it has no Docker
 * daemon/CLI. Use the CLI entrypoint discovered by the shared app-pool startup
 * script instead; separate-container installs retain the Docker execution path.
 */
export function buildOpenClawProviderStatusCliArgs({
  cliPath = process.env.OPENCLAW_CLI_PATH,
  appPool = process.env.TROOPER_APP_POOL === '1',
  provider = '',
  profileId = '',
  probe = false,
} = {}) {
  const providerId = provider ? normalizeProvider(provider) : '';
  const accountProfileId = normalizeProfileId(profileId);
  if (probe && !providerId) {
    const error = new Error('Choose a provider before running a live check.');
    error.statusCode = 400;
    error.code = 'OPENCLAW_PROVIDER_REQUIRED';
    throw error;
  }
  const resolvedCliPath = String(
    cliPath || (appPool ? DEFAULT_APP_POOL_OPENCLAW_CLI_PATH : ''),
  ).trim();
  if (!resolvedCliPath || !path.isAbsolute(resolvedCliPath)) {
    const error = new Error('OpenClaw CLI path is not configured for this app-pool runtime.');
    error.statusCode = 503;
    error.code = 'OPENCLAW_PROVIDER_CLI_UNAVAILABLE';
    throw error;
  }
  return [
    resolvedCliPath,
    ...buildOpenClawProviderStatusCommandArgs({ providerId, accountProfileId, probe }),
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

function safeFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeStatusEnvelope(status) {
  const oauth = status?.auth?.oauth || {};
  const providers = Array.isArray(oauth.providers) ? oauth.providers : [];
  const profiles = Array.isArray(oauth.profiles) ? oauth.profiles : [];
  // OpenClaw 2026.7 puts probe output under auth.probes; newer releases may
  // expose it at the top level. Normalize both shapes for the app API.
  const probeResults = Array.isArray(status?.auth?.probes?.results)
    ? status.auth.probes.results
    : Array.isArray(status?.probes?.results) ? status.probes.results : [];
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
    providerChecks: Array.isArray(status?.providerChecks)
      ? status.providerChecks.map((item) => ({
        provider: String(item?.provider || ''),
        profileId: String(item?.profileId || ''),
        model: safeStatusText(item?.model || '', 200),
        status: String(item?.status || 'unknown'),
        error: safeStatusText(item?.error || '', 1_000),
        latencyMs: Number.isFinite(Number(item?.latencyMs)) ? Number(item.latencyMs) : null,
        checkedAt: Number.isFinite(Number(item?.checkedAt)) ? Number(item.checkedAt) : null,
      }))
      : [],
  };
}

function safeProviderUsageEnvelope(status) {
  const providers = Array.isArray(status?.usage?.providers) ? status.usage.providers : [];
  return providers.map((item) => ({
    provider: String(item?.provider || '').slice(0, 64),
    // Some OpenClaw provider adapters include the auth profile that produced
    // the usage result. Preserve that non-secret identifier when available so
    // clients can avoid attaching one account's quota to another account.
    ...(item?.profileId || item?.profile_id
      ? { profileId: safeStatusText(item.profileId || item.profile_id, 160) }
      : {}),
    windows: (Array.isArray(item?.windows) ? item.windows : []).map((window) => {
      const usedValue = safeFiniteNumber(window?.usedPercent);
      const usedPercent = usedValue === null ? null : Math.max(0, Math.min(100, usedValue));
      const reportedRemaining = safeFiniteNumber(window?.remainingPercent);
      return {
        label: safeStatusText(window?.label || window?.kind || '', 100),
        usedPercent,
        // Usage and remaining are the two sides of the same limit window.
        // Prefer the reported usage value when both fields conflict (e.g. 9%
        // used and 0% remaining), which otherwise falsely shows exhaustion.
        remainingPercent: usedPercent === null
          ? reportedRemaining
          : Math.max(0, Math.min(100, 100 - usedPercent)),
        resetAt: safeFiniteNumber(window?.resetAt),
      };
    }),
    billing: (Array.isArray(item?.billing) ? item.billing : []).map((billing) => ({
      label: safeStatusText(billing?.label || '', 100),
      amount: safeFiniteNumber(billing?.amount),
      used: safeFiniteNumber(billing?.used),
      limit: safeFiniteNumber(billing?.limit),
      unit: safeStatusText(billing?.unit || '', 32),
    })),
  }));
}

function parseProviderEnvFile(content = '') {
  const values = {};
  for (const line of String(content || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || !PROVIDER_ENV_KEYS.has(match[1])) continue;
    let value = match[2];
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\(["\\$`])/g, '$1');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    if (value) values[match[1]] = value;
  }
  return values;
}

function readProviderEnvOverrides(envPaths) {
  const candidates = (Array.isArray(envPaths) ? envPaths : [envPaths])
    .map((target) => String(target || '').trim())
    .filter((target, index, values) => target && path.isAbsolute(target) && values.indexOf(target) === index);
  for (const target of candidates) {
    try {
      const values = parseProviderEnvFile(readFileSync(target, 'utf8'));
      if (Object.keys(values).length) return values;
    } catch {}
  }
  return {};
}

function createTemporaryProbeConfig(configPath, model) {
  const target = String(configPath || '').trim();
  if (!target || !path.isAbsolute(target)) {
    const error = new Error('OpenClaw config path is not configured for a model-specific provider check.');
    error.code = 'OPENCLAW_PROVIDER_CONFIG_UNAVAILABLE';
    error.statusCode = 503;
    throw error;
  }
  const config = JSON.parse(readFileSync(target, 'utf8'));
  if (!config.agents || typeof config.agents !== 'object' || Array.isArray(config.agents)) config.agents = {};
  if (!config.agents.defaults || typeof config.agents.defaults !== 'object' || Array.isArray(config.agents.defaults)) {
    config.agents.defaults = {};
  }
  config.agents.defaults.model = { primary: model, fallbacks: [] };
  const directory = mkdtempSync(path.join(os.tmpdir(), 'openclaw-provider-probe-'));
  const temporaryPath = path.join(directory, 'openclaw.json');
  try {
    writeFileSync(temporaryPath, JSON.stringify(config), { mode: 0o600 });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, path: temporaryPath };
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
  constructor({
    containerName,
    execFile = defaultExecFile,
    appPool = process.env.TROOPER_APP_POOL === '1',
    cliPath = process.env.OPENCLAW_CLI_PATH,
    configPath = process.env.OPENCLAW_CONFIG_PATH,
    envPath = process.env.OPENCLAW_ENV_PATH,
  } = {}) {
    this.containerName = normalizeContainerName(containerName);
    this.execFile = execFile;
    this.appPool = Boolean(appPool);
    this.cliPath = String(cliPath || (this.appPool ? DEFAULT_APP_POOL_OPENCLAW_CLI_PATH : '')).trim();
    this.configPath = configPath;
    this.envPaths = [
      envPath,
      configPath ? path.join(path.dirname(String(configPath)), '.env') : '',
    ];
    this.providerUsageCache = new Map();
    this.providerUsagePending = new Map();
  }

  async run({ provider = '', profileId = '', probe = false, model = '' } = {}) {
    const requestedModel = String(model || '').trim().replace(/^openai-codex\//i, 'openai/');
    if (requestedModel && !PROBE_MODEL_PATTERN.test(requestedModel)) {
      const error = new Error('Choose a valid model for the provider check.');
      error.statusCode = 400;
      error.code = 'OPENCLAW_PROVIDER_MODEL_INVALID';
      throw error;
    }
    if (requestedModel && !probe) {
      const error = new Error('A model can only be supplied for a live provider check.');
      error.statusCode = 400;
      error.code = 'OPENCLAW_PROVIDER_MODEL_INVALID';
      throw error;
    }
    const args = this.appPool
      ? buildOpenClawProviderStatusCliArgs({
        cliPath: this.cliPath,
        appPool: this.appPool,
        provider,
        profileId,
        probe,
      })
      : buildOpenClawProviderStatusDockerArgs({
        containerName: this.containerName,
        provider,
        profileId,
        probe,
      });
    const timeoutMs = probe
      ? DEFAULT_OPENCLAW_PROVIDER_PROBE_TIMEOUT_MS + 5_000
      : DEFAULT_OPENCLAW_PROVIDER_STATUS_TIMEOUT_MS + 3_000;
    let output = '';
    let temporaryConfig = null;
    try {
      const env = this.appPool
        ? {
          ...process.env,
          ...readProviderEnvOverrides(this.envPaths),
          HOME: '/home/node',
        }
        : undefined;
      if (this.appPool && probe && requestedModel) {
        temporaryConfig = createTemporaryProbeConfig(this.configPath, requestedModel);
        env.OPENCLAW_CONFIG_PATH = temporaryConfig.path;
      }
      const result = this.appPool
        ? await this.execFile(process.execPath, args, {
          timeout: timeoutMs,
          cwd: path.dirname(this.cliPath),
          env,
        })
        : await this.execFile('docker', args, { timeout: timeoutMs });
      output = String(result?.stdout || '');
    } catch (error) {
      const failed = makeStatusError(error, error?.stdout);
      if (failed.error) throw failed.error;
      return { ok: true, status: failed.status };
    } finally {
      if (temporaryConfig?.directory) {
        try { rmSync(temporaryConfig.directory, { recursive: true, force: true }); } catch {}
      }
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

  /**
   * Provider usage is a read-only OpenClaw status command. It runs in the
   * background so opening provider settings never waits on OAuth usage APIs.
   */
  async getUsage({ refresh = false, profileId = '' } = {}) {
    const requestedProfileId = String(profileId || '').trim().slice(0, 160);
    const cacheKey = requestedProfileId || 'provider-wide';
    const now = Date.now();
    const cached = this.providerUsageCache.get(cacheKey) || null;
    if (!refresh && cached && now - cached.checkedAt < PROVIDER_USAGE_CACHE_TTL_MS) {
      return { ...cached, checking: false };
    }
    if (refresh) this.providerUsageCache.delete(cacheKey);
    if (!this.providerUsagePending.has(cacheKey)) {
      const commandArgs = buildOpenClawProviderUsageCommandArgs();
      const timeoutMs = DEFAULT_OPENCLAW_PROVIDER_USAGE_TIMEOUT_MS + 5_000;
      const env = this.appPool
        ? {
          ...process.env,
          ...readProviderEnvOverrides(this.envPaths),
          HOME: '/home/node',
        }
        : undefined;
      const args = this.appPool
        ? (() => {
          const cliPath = String(this.cliPath || DEFAULT_APP_POOL_OPENCLAW_CLI_PATH).trim();
          if (!cliPath || !path.isAbsolute(cliPath)) {
            const error = new Error('OpenClaw CLI path is not configured for this app-pool runtime.');
            error.statusCode = 503;
            error.code = 'OPENCLAW_PROVIDER_CLI_UNAVAILABLE';
            throw error;
          }
          return [cliPath, ...commandArgs];
        })()
        : [
          'exec', '-u', 'node', '-w', '/home/node', '-e', 'HOME=/home/node', this.containerName,
          ...buildTimeoutArgs(DEFAULT_OPENCLAW_PROVIDER_USAGE_TIMEOUT_MS),
          'openclaw', ...commandArgs,
        ];
      const work = (async () => {
        try {
          const result = this.appPool
            ? await this.execFile(process.execPath, args, {
              timeout: timeoutMs,
              cwd: path.dirname(this.cliPath),
              env,
            })
            : await this.execFile('docker', args, { timeout: timeoutMs });
          const status = parseStatusOutput(result?.stdout);
          if (!status) throw new Error('OpenClaw returned an unreadable usage response.');
          this.providerUsageCache.set(cacheKey, {
            ok: true,
            checking: false,
            checkedAt: Date.now(),
            requestedProfileId: requestedProfileId || null,
            providers: safeProviderUsageEnvelope(status),
          });
        } catch (error) {
          this.providerUsageCache.set(cacheKey, {
            ok: false,
            checking: false,
            checkedAt: Date.now(),
            requestedProfileId: requestedProfileId || null,
            providers: [],
            message: safeStatusText(commandOutput(error), 500) || 'OpenClaw could not read provider usage.',
          });
        } finally {
          this.providerUsagePending.delete(cacheKey);
        }
        return this.providerUsageCache.get(cacheKey);
      })();
      this.providerUsagePending.set(cacheKey, work);
    }
    return {
      ...(cached || { ok: true, checkedAt: null, requestedProfileId: requestedProfileId || null, providers: [] }),
      checking: true,
    };
  }
}
