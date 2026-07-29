import { execFile as nodeExecFile } from 'child_process';

export const DEFAULT_OPENCODE_ACP_CONFIG_TIMEOUT_MS = 20_000;
// The gateway container's normal ~/.config is image-local and disappears when
// Docker recreates the container. Keep the managed OpenCode config in the
// same mounted OpenClaw data tree as the ACP credentials instead.
export const OPENCODE_ACP_CONFIG_DIR = '/home/node/.openclaw/acpx/opencode-config';
export const OPENCODE_ACP_CONFIG_PATH = `${OPENCODE_ACP_CONFIG_DIR}/opencode.json`;

const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

// This deliberately small list is the complete server-side allowlist. The
// browser can select one of these names, but it can never supply an arbitrary
// OpenCode provider, command, config path, environment variable, or key.
export const OPENCODE_ACP_PROVIDER_CATALOG = Object.freeze({
  anthropic: Object.freeze({ envName: 'ANTHROPIC_API_KEY' }),
  openai: Object.freeze({ envName: 'OPENAI_API_KEY' }),
  openrouter: Object.freeze({ envName: 'OPENROUTER_API_KEY' }),
});

const PROVIDER_IDS = Object.freeze(Object.keys(OPENCODE_ACP_PROVIDER_CATALOG));
const PROVIDER_ENV_REFS = Object.freeze(Object.fromEntries(
  PROVIDER_IDS.map((provider) => [provider, `{env:${OPENCODE_ACP_PROVIDER_CATALOG[provider].envName}}`]),
));

function isPlainObject(value) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * ACPX lets the gateway override one harness with a fixed executable plus
 * structured args. `env` gives only the OpenCode worker this persistent config
 * path; it does not change the gateway's global XDG config for other tools.
 * The executable is installed at a pinned version in the gateway image.
 */
export function buildManagedOpenCodeAcpAgentConfig() {
  return {
    command: 'env',
    args: [
      `OPENCODE_CONFIG=${OPENCODE_ACP_CONFIG_PATH}`,
      '/usr/local/bin/opencode',
      'acp',
    ],
  };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Report whether the ACPX OpenCode entry is the fixed command Trooper owns.
 * A non-matching entry is deliberately treated as a user-managed override:
 * it may be a valid bespoke OpenCode setup, so startup must never replace it
 * just because it is not our preferred command.
 */
export function getManagedOpenCodeAcpAgentConfigState(config) {
  if (!isPlainObject(config)) throw new TypeError('OpenClaw config must be an object');
  const agents = config.plugins?.entries?.acpx?.config?.agents;
  if (!isPlainObject(agents) || !hasOwn(agents, 'opencode')) {
    return { managed: false, reason: 'missing' };
  }

  const entry = agents.opencode;
  const desired = buildManagedOpenCodeAcpAgentConfig();
  const isManaged = isPlainObject(entry)
    && Object.keys(entry).length === 2
    && entry.command === desired.command
    && Array.isArray(entry.args)
    && entry.args.length === desired.args.length
    && entry.args.every((value, index) => value === desired.args[index]);
  return isManaged
    ? { managed: true, reason: null }
    : { managed: false, reason: 'custom_override' };
}

/**
 * Ensure OpenClaw's ACPX plugin launches OpenCode with the persistent config
 * file that this manager writes. It creates the entry only when absent. A
 * non-managed existing entry remains untouched and callers can show a clear
 * conflict rather than quietly disconnecting a user-owned ACPX setup.
 */
export function ensureManagedOpenCodeAcpAgentConfig(config) {
  if (!isPlainObject(config)) throw new TypeError('OpenClaw config must be an object');
  const current = getManagedOpenCodeAcpAgentConfigState(config);
  if (current.managed || current.reason === 'custom_override') {
    return { config, changed: false, ...current };
  }

  if (!isPlainObject(config.plugins)) config.plugins = {};
  if (!isPlainObject(config.plugins.entries)) config.plugins.entries = {};
  if (!isPlainObject(config.plugins.entries.acpx)) config.plugins.entries.acpx = { enabled: true };

  const acpx = config.plugins.entries.acpx;
  if (!isPlainObject(acpx.config)) acpx.config = {};
  if (!isPlainObject(acpx.config.agents)) acpx.config.agents = {};

  acpx.config.agents.opencode = buildManagedOpenCodeAcpAgentConfig();
  return { config, changed: true, managed: true, reason: null };
}

function normalizeContainerName(value) {
  const name = String(value || '').trim();
  if (!CONTAINER_NAME_PATTERN.test(name)) throw new Error('Invalid gateway container name');
  return name;
}

export function normalizeOpenCodeAcpProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return PROVIDER_PATTERN.test(provider) && OPENCODE_ACP_PROVIDER_CATALOG[provider] ? provider : '';
}

function defaultExecFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, {
      encoding: 'utf8',
      maxBuffer: 128 * 1024,
      ...options,
    }, (error, stdout = '', stderr = '') => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr, code: 0 });
    });
  });
}

// This script is passed as a fixed argv value to `node -e` inside the gateway
// container. It intentionally has no caller-supplied code. The provider comes
// from an allowlisted environment value added by buildOpenCodeAcpConfigDockerArgs.
//
// We remove only another *Trooper-shaped* env reference when a user changes
// their selection. Existing provider settings and any unrelated provider
// entries remain untouched. Credentials never enter this file: OpenCode reads
// the environment reference itself at runtime.
const WRITE_PROVIDER_CONFIG_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const configPath = ${JSON.stringify(OPENCODE_ACP_CONFIG_PATH)};
const provider = process.env.TROOPER_OPENCODE_PROVIDER;
const envRefs = ${JSON.stringify(PROVIDER_ENV_REFS)};
const providerIds = Object.keys(envRefs);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function readConfig() {
  if (!fs.existsSync(configPath)) return {};
  let value;
  try {
    value = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    fail('OPENCODE_PROVIDER_CONFIG_INVALID');
  }
  if (!plainObject(value)) fail('OPENCODE_PROVIDER_CONFIG_INVALID');
  return value;
}
function writeAtomic(targetPath, value) {
  const directory = path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(directory, '.' + path.basename(targetPath) + '.trooper-' + process.pid + '-' + Date.now() + '.tmp');
  let descriptor = null;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, targetPath);
}
function removeManagedReference(providerConfig, expectedReference) {
  if (!plainObject(providerConfig) || !plainObject(providerConfig.options)) return providerConfig;
  if (providerConfig.options.apiKey !== expectedReference) return providerConfig;
  const nextOptions = { ...providerConfig.options };
  delete nextOptions.apiKey;
  const nextProviderConfig = { ...providerConfig };
  if (Object.keys(nextOptions).length === 0) delete nextProviderConfig.options;
  else nextProviderConfig.options = nextOptions;
  return nextProviderConfig;
}

try {
  if (!Object.prototype.hasOwnProperty.call(envRefs, provider)) fail('OPENCODE_PROVIDER_UNSUPPORTED');
  const config = readConfig();
  if (config.provider !== undefined && !plainObject(config.provider)) fail('OPENCODE_PROVIDER_CONFIG_INVALID');
  const providers = { ...(config.provider || {}) };

  for (const id of providerIds) {
    if (id === provider || !Object.prototype.hasOwnProperty.call(providers, id)) continue;
    const next = removeManagedReference(providers[id], envRefs[id]);
    if (!plainObject(next)) continue;
    if (Object.keys(next).length === 0) delete providers[id];
    else providers[id] = next;
  }

  const current = providers[provider] === undefined ? {} : providers[provider];
  if (!plainObject(current)) fail('OPENCODE_PROVIDER_CONFIG_INVALID');
  const currentOptions = current.options === undefined ? {} : current.options;
  if (!plainObject(currentOptions)) fail('OPENCODE_PROVIDER_CONFIG_INVALID');
  providers[provider] = {
    ...current,
    options: {
      ...currentOptions,
      apiKey: envRefs[provider],
    },
  };
  writeAtomic(configPath, { ...config, provider: providers });
  process.stdout.write(JSON.stringify({ provider }) + '\n');
} catch (error) {
  const code = /^[A-Z0-9_]+$/.test(String(error && error.code || ''))
    ? error.code
    : 'OPENCODE_PROVIDER_CONFIG_WRITE_FAILED';
  process.stderr.write(code + '\n');
  process.exitCode = 1;
}
`;

// A read-only, fixed in-container probe. It intentionally emits a tiny status
// object rather than the config, environment, provider options, or any token.
const PROBE_PROVIDER_CONFIG_SCRIPT = String.raw`
const fs = require('node:fs');
const configPath = ${JSON.stringify(OPENCODE_ACP_CONFIG_PATH)};
const envRefs = ${JSON.stringify(PROVIDER_ENV_REFS)};

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}
try {
  if (!fs.existsSync(configPath)) {
    emit({ selectedProvider: null, credentialPresent: false, status: 'not_configured' });
  } else {
    let config;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      emit({ selectedProvider: null, credentialPresent: false, status: 'invalid_config' });
      process.exit(0);
    }
    if (!plainObject(config) || (config.provider !== undefined && !plainObject(config.provider))) {
      emit({ selectedProvider: null, credentialPresent: false, status: 'invalid_config' });
      process.exit(0);
    }
    const providers = config.provider || {};
    const selected = Object.keys(envRefs).filter((provider) => {
      const entry = providers[provider];
      return plainObject(entry) && plainObject(entry.options) && entry.options.apiKey === envRefs[provider];
    });
    if (selected.length !== 1) {
      emit({
        selectedProvider: null,
        credentialPresent: false,
        status: selected.length > 1 ? 'selection_ambiguous' : 'not_configured',
      });
    } else {
      const provider = selected[0];
      const envName = envRefs[provider].slice(5, -1);
      const credentialPresent = Boolean(String(process.env[envName] || '').trim());
      emit({
        selectedProvider: provider,
        credentialPresent,
        status: credentialPresent ? 'ready' : 'credential_missing',
      });
    }
  }
} catch {
  emit({ selectedProvider: null, credentialPresent: false, status: 'probe_failed' });
}
`;

/**
 * Build a fixed Docker invocation. `provider` is normalized against the
 * catalog before it reaches the container as an environment value; nothing
 * from the HTTP request becomes a command, path, script, or credential.
 */
export function buildOpenCodeAcpConfigDockerArgs({ containerName, action = 'availability', provider } = {}) {
  const container = normalizeContainerName(containerName);
  const prefix = [
    'exec', '-u', 'node', '-w', '/home/node',
    '-e', 'HOME=/home/node',
  ];
  const timeout = [
    'timeout', '--foreground', '--signal=TERM', '--kill-after=10s',
    `${Math.ceil(DEFAULT_OPENCODE_ACP_CONFIG_TIMEOUT_MS / 1000)}s`,
  ];
  if (action === 'availability') {
    return [...prefix, container, ...timeout, 'node', '-e', PROBE_PROVIDER_CONFIG_SCRIPT];
  }
  if (action === 'configure') {
    const normalizedProvider = normalizeOpenCodeAcpProvider(provider);
    if (!normalizedProvider) throw new Error('Unsupported OpenCode ACP provider');
    return [
      ...prefix,
      '-e', `TROOPER_OPENCODE_PROVIDER=${normalizedProvider}`,
      container,
      ...timeout,
      'node', '-e', WRITE_PROVIDER_CONFIG_SCRIPT,
    ];
  }
  throw new Error('Unsupported OpenCode ACP configuration action');
}

function parseAvailabilityOutput(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 4_096) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const selectedProvider = parsed?.selectedProvider === null
    ? null
    : normalizeOpenCodeAcpProvider(parsed?.selectedProvider);
  const validStatuses = new Set([
    'ready', 'credential_missing', 'not_configured', 'selection_ambiguous', 'invalid_config', 'probe_failed',
  ]);
  const status = validStatuses.has(parsed?.status) ? parsed.status : null;
  if (!status) return null;
  if (!selectedProvider && parsed?.selectedProvider !== null) return null;
  if (typeof parsed?.credentialPresent !== 'boolean') return null;
  if ((status === 'ready' || status === 'credential_missing') && !selectedProvider) return null;
  return { selectedProvider, credentialPresent: parsed.credentialPresent, status };
}

function safeProviderConfigErrorCode(value, fallback) {
  const text = `${String(value?.stderr || '')}\n${String(value?.stdout || '')}\n${String(value?.message || '')}`;
  const match = text.match(/\b(OPENCODE_PROVIDER_(?:UNSUPPORTED|CONFIG_INVALID|CONFIG_WRITE_FAILED))\b/);
  return match?.[1] || fallback;
}

/**
 * Isolated OpenCode provider selection for ACP. It writes only references to
 * gateway environment variable names, never receives actual credentials, and
 * only exposes a provider name plus a boolean readiness signal.
 */
export class OpenCodeAcpConfigManager {
  constructor({ containerName, execFile = defaultExecFile } = {}) {
    this.containerName = normalizeContainerName(containerName);
    this.execFile = execFile;
  }

  async exec(action, provider) {
    return this.execFile('docker', buildOpenCodeAcpConfigDockerArgs({
      containerName: this.containerName,
      action,
      provider,
    }), { timeout: DEFAULT_OPENCODE_ACP_CONFIG_TIMEOUT_MS });
  }

  unavailable(errorCode = 'OPENCODE_PROVIDER_CONFIG_PROBE_FAILED') {
    return {
      supported: true,
      selectedProvider: null,
      credentialPresent: false,
      configured: false,
      authenticated: false,
      authMode: 'provider_selection_required',
      authHint: 'Choose Anthropic, OpenAI, or OpenRouter, then configure that provider’s gateway API key. Trooper stores only an environment reference, never the key.',
      status: 'probe_failed',
      errorCode,
      error: 'Could not verify the OpenCode provider selection on the gateway runtime.',
    };
  }

  async getAvailability() {
    let result;
    try {
      result = await this.exec('availability');
    } catch {
      return this.unavailable();
    }
    const parsed = parseAvailabilityOutput(result?.stdout);
    if (!parsed) return this.unavailable('OPENCODE_PROVIDER_CONFIG_PROBE_INVALID');
    const configured = Boolean(parsed.selectedProvider);
    const authenticated = parsed.status === 'ready' && configured && parsed.credentialPresent;
    const errorCode = authenticated
      ? null
      : parsed.status === 'not_configured'
        ? 'OPENCODE_PROVIDER_NOT_SELECTED'
        : parsed.status === 'selection_ambiguous'
          ? 'OPENCODE_PROVIDER_SELECTION_AMBIGUOUS'
          : parsed.status === 'invalid_config'
            ? 'OPENCODE_PROVIDER_CONFIG_INVALID'
            : parsed.status === 'credential_missing'
              ? 'OPENCODE_PROVIDER_CREDENTIAL_MISSING'
              : 'OPENCODE_PROVIDER_CONFIG_PROBE_FAILED';
    const error = authenticated
      ? null
      : parsed.status === 'not_configured'
        ? 'Choose an OpenCode provider before starting an ACP worker.'
        : parsed.status === 'selection_ambiguous'
          ? 'Choose one OpenCode provider before starting an ACP worker.'
          : parsed.status === 'invalid_config'
            ? 'The existing OpenCode configuration is invalid JSON and was not changed.'
            : parsed.status === 'credential_missing'
              ? 'The selected OpenCode provider does not have its gateway credential configured.'
              : 'Could not verify the OpenCode provider selection on the gateway runtime.';
    return {
      supported: true,
      selectedProvider: parsed.selectedProvider,
      credentialPresent: parsed.credentialPresent,
      configured,
      authenticated,
      authMode: 'provider_selection_required',
      authHint: 'Choose Anthropic, OpenAI, or OpenRouter, then configure that provider’s gateway API key. Trooper stores only an environment reference, never the key.',
      status: parsed.status,
      errorCode,
      error,
    };
  }

  async configure(provider) {
    const normalizedProvider = normalizeOpenCodeAcpProvider(provider);
    if (!normalizedProvider) {
      const error = new Error('Choose a supported OpenCode provider.');
      error.code = 'OPENCODE_PROVIDER_UNSUPPORTED';
      throw error;
    }
    try {
      await this.exec('configure', normalizedProvider);
    } catch (caught) {
      const error = new Error('OpenCode provider selection was not saved. Existing configuration was left unchanged when it was invalid.');
      error.code = safeProviderConfigErrorCode(caught, 'OPENCODE_PROVIDER_CONFIG_WRITE_FAILED');
      throw error;
    }
    const availability = await this.getAvailability();
    return {
      ok: true,
      provider: normalizedProvider,
      availability,
      nextStep: availability.authenticated
        ? 'OpenCode is ready for ACP on the gateway runtime.'
        : 'Configure the selected provider’s gateway API key, then check OpenCode again.',
    };
  }
}
