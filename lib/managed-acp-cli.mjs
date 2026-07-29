import { execFile as nodeExecFile } from 'child_process';

export const DEFAULT_MANAGED_ACP_CLI_TIMEOUT_MS = 180_000;
export const DEFAULT_MANAGED_ACP_CLI_PROBE_TIMEOUT_MS = 15_000;

const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const MANAGED_HARNESS_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

// A harness is only auto-installed when both its package and binary are fixed
// here. This is intentionally not a package manager, a shell, or a generic
// command endpoint. Codex has its own device-auth manager because its OAuth
// credential needs a separate ACP home and browser handoff.
export const MANAGED_ACP_CLI_CATALOG = Object.freeze({
  claude: Object.freeze({
    label: 'Claude Code',
    packageName: '@anthropic-ai/claude-code',
    binary: 'claude',
    authMode: 'api_key_or_official_host_login',
    authHint: 'Claude Code can use an Anthropic API key or Claude Code’s official host login as the gateway node user. Trooper does not accept OAuth tokens, browser URLs, or login codes.',
    statusArgs: ['auth', 'status', '--json'],
  }),
  gemini: Object.freeze({
    label: 'Gemini CLI',
    packageName: '@google/gemini-cli',
    binary: 'gemini',
    authMode: 'api_key_or_enterprise_credentials',
    authHint: 'Gemini CLI needs a Gemini API key or supported enterprise/cloud credentials on the gateway. Trooper does not initiate, proxy, or accept Google browser OAuth.',
  }),
});

function clampText(value, limit = 8_000) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return `${text.slice(text.length - limit)}\n[Earlier output omitted]`;
}

function normalizeContainerName(value) {
  const name = String(value || '').trim();
  if (!CONTAINER_NAME_PATTERN.test(name)) throw new Error('Invalid gateway container name');
  return name;
}

export function normalizeManagedAcpHarness(value) {
  const harness = String(value || '').trim().toLowerCase();
  return MANAGED_HARNESS_PATTERN.test(harness) ? harness : '';
}

export function getManagedAcpCliRecipe(value) {
  const harness = normalizeManagedAcpHarness(value);
  const recipe = MANAGED_ACP_CLI_CATALOG[harness];
  return recipe ? { harness, ...recipe } : null;
}

// Install output can include provider/session data in future CLI releases.
// Surface only a bounded, credential-redacted diagnostic to the control plane.
export function redactManagedAcpCliOutput(value, limit = 8_000) {
  let text = String(value || '')
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
  text = text.replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]');
  text = text.replace(/(["']?(?:access_token|refresh_token|id_token|session_token|token|api[_-]?key|authorization|secret|password)["']?\s*[:=]\s*["']?)([^\s,"'}\]]+)/gi, '$1[redacted]');
  text = text.replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]');
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[redacted]');
  text = text.replace(/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, '[redacted]');
  return clampText(text, limit);
}

function commandErrorText(error) {
  const parts = [error?.stderr, error?.stdout, error?.message]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return parts.find(Boolean) || 'Command failed';
}

function commandSucceeded(result) {
  if (!result) return false;
  if (result.ok === false) return false;
  if (typeof result.code === 'number') return result.code === 0;
  if (typeof result.exitCode === 'number') return result.exitCode === 0;
  return true;
}

function defaultExecFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, {
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
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

function parseClaudeAuthStatus(value) {
  try {
    const parsed = JSON.parse(String(value || '').trim());
    // Claude's documented --json status output has changed shape over time.
    // Only report an affirmative signal; an unknown shape remains unknown,
    // rather than treating an installed binary as authenticated.
    if (parsed?.loggedIn === true || parsed?.authenticated === true) return true;
    if (parsed?.loggedIn === false || parsed?.authenticated === false) return false;
  } catch {
    // A non-JSON status is retained only as a redacted diagnostic below.
  }
  return null;
}

function resolveClaudeAuthStatus(result, output) {
  const explicitStatus = parseClaudeAuthStatus(output);
  if (explicitStatus !== null) return explicitStatus;

  // `claude auth status` is an auth probe: a zero exit code is its durable
  // contract. Its JSON has changed shape between CLI versions, so an unknown
  // but successful payload still means the CLI authenticated successfully.
  return commandSucceeded(result);
}

/**
 * Build a fixed Docker invocation for a managed CLI. The only variable is a
 * catalog-selected harness; no client request can supply command, package,
 * flag, working directory, environment, or binary path.
 */
export function buildManagedAcpCliDockerArgs({ containerName, harness, action = 'probe' } = {}) {
  const container = normalizeContainerName(containerName);
  const recipe = getManagedAcpCliRecipe(harness);
  if (!recipe) throw new Error('Unsupported managed ACP harness');
  const common = [
    'exec', '-u', 'node', '-w', '/home/node',
    '-e', 'HOME=/home/node',
    container,
  ];
  const timeout = action === 'install' ? DEFAULT_MANAGED_ACP_CLI_TIMEOUT_MS : DEFAULT_MANAGED_ACP_CLI_PROBE_TIMEOUT_MS;
  const prefix = ['timeout', '--foreground', '--signal=TERM', '--kill-after=10s', `${Math.ceil(timeout / 1000)}s`];

  if (action === 'install') {
    // npm --global is intentionally fixed and runs as node inside the actual
    // gateway container. It is the same process environment ACP will use;
    // this replaces the old plugin-only `/gateway/exec` misuse.
    return [
      'exec', '-u', '0', '-w', '/home/node', container,
      ...prefix,
      'npm', 'install', '--global', '--no-audit', '--no-fund', recipe.packageName,
    ];
  }
  if (action === 'auth_status' && recipe.statusArgs) {
    return [...common, ...prefix, recipe.binary, ...recipe.statusArgs];
  }
  if (action === 'probe') return [...common, ...prefix, recipe.binary, '--version'];
  throw new Error('Unsupported managed ACP CLI action');
}

/**
 * Performs fixed install/probe operations for package-based ACP harnesses.
 * OpenCode deliberately is not listed here: ACPX boots its fixed npx adapter
 * with the persistent provider config managed by opencode-acp-config.mjs, so a
 * disposable global npm installation is neither required nor authoritative.
 * Authentication remains provider-specific: only Claude has a status probe,
 * and none of these routes accepts credentials or browser URLs.
 */
export class ManagedAcpCliManager {
  constructor({ containerName, execFile = defaultExecFile } = {}) {
    this.containerName = normalizeContainerName(containerName);
    this.execFile = execFile;
  }

  async exec(harness, action, timeout) {
    return this.execFile('docker', buildManagedAcpCliDockerArgs({
      containerName: this.containerName,
      harness,
      action,
    }), { timeout });
  }

  unsupportedAvailability(harness) {
    return {
      harness: normalizeManagedAcpHarness(harness) || String(harness || '').trim().toLowerCase() || null,
      supported: false,
      managedInstall: false,
      installed: false,
      authenticated: null,
      authMode: 'unsupported',
      errorCode: 'ACP_CLI_UNSUPPORTED',
      error: 'This ACP harness does not have a supported managed CLI flow on this gateway.',
    };
  }

  async getAvailability(harness) {
    const recipe = getManagedAcpCliRecipe(harness);
    if (!recipe) return this.unsupportedAvailability(harness);

    let version = null;
    let installed = false;
    let probeError = null;
    try {
      const result = await this.exec(recipe.harness, 'probe', DEFAULT_MANAGED_ACP_CLI_PROBE_TIMEOUT_MS);
      installed = commandSucceeded(result);
      const output = redactManagedAcpCliOutput(`${result?.stdout || ''}\n${result?.stderr || ''}`, 500);
      version = output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
    } catch (error) {
      probeError = redactManagedAcpCliOutput(commandErrorText(error), 800);
    }

    let authenticated = null;
    let authError = null;
    if (installed && recipe.statusArgs) {
      try {
        const result = await this.exec(recipe.harness, 'auth_status', DEFAULT_MANAGED_ACP_CLI_PROBE_TIMEOUT_MS);
        const output = redactManagedAcpCliOutput(`${result?.stdout || ''}\n${result?.stderr || ''}`, 800);
        authenticated = resolveClaudeAuthStatus(result, output);
        if (!authenticated) authError = output || 'CLI authentication is required';
      } catch (error) {
        authenticated = false;
        authError = redactManagedAcpCliOutput(commandErrorText(error), 800);
      }
    }

    return {
      harness: recipe.harness,
      label: recipe.label,
      supported: true,
      managedInstall: true,
      installed,
      authenticated,
      version,
      authMode: recipe.authMode,
      authHint: recipe.authHint,
      errorCode: installed ? (authError ? 'ACP_CLI_AUTH_REQUIRED' : null) : 'ACP_CLI_MISSING',
      error: installed ? authError : probeError,
    };
  }

  async install(harness) {
    const recipe = getManagedAcpCliRecipe(harness);
    if (!recipe) {
      const error = new Error('This ACP harness does not have a supported managed installer.');
      error.code = 'ACP_CLI_UNSUPPORTED';
      throw error;
    }
    let result;
    try {
      result = await this.exec(recipe.harness, 'install', DEFAULT_MANAGED_ACP_CLI_TIMEOUT_MS);
    } catch (error) {
      const next = new Error(redactManagedAcpCliOutput(commandErrorText(error), 2_000));
      next.code = 'ACP_CLI_INSTALL_FAILED';
      next.stdout = redactManagedAcpCliOutput(error?.stdout || '', 8_000);
      next.stderr = redactManagedAcpCliOutput(error?.stderr || '', 4_000);
      throw next;
    }
    const availability = await this.getAvailability(recipe.harness);
    if (!availability.installed) {
      const error = new Error(availability.error || `${recipe.label} did not become available after installation.`);
      error.code = 'ACP_CLI_INSTALL_VERIFY_FAILED';
      error.availability = availability;
      throw error;
    }
    return {
      ok: true,
      harness: recipe.harness,
      label: recipe.label,
      phase: 'install',
      command: `Install ${recipe.label} on the gateway runtime`,
      stdout: redactManagedAcpCliOutput(result?.stdout || '', 8_000),
      stderr: redactManagedAcpCliOutput(result?.stderr || '', 4_000),
      availability,
      nextStep: availability.authenticated === true
        ? `${recipe.label} is ready for ACP.`
        : recipe.authHint,
    };
  }
}
