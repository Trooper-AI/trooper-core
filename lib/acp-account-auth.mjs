import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const TERMINAL_STATES = new Set(['connected', 'failed', 'cancelled', 'expired']);
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_RETENTION_MS = 15 * 60_000;

export const ACP_ACCOUNT_AUTH_CATALOG = Object.freeze({
  claude: Object.freeze({
    label: 'Claude Code',
    binaryPath: '/usr/local/bin/claude',
    loginArgs: ['auth', 'login'],
    statusArgs: ['auth', 'status', '--json'],
    authMode: 'official_browser_login',
    promptType: 'authorization_code',
    hosts: ['claude.ai', 'console.anthropic.com'],
  }),
  kimi: Object.freeze({
    label: 'Kimi Code',
    binaryPath: '/usr/local/bin/kimi',
    loginArgs: ['login'],
    statusArgs: null,
    authMode: 'device_code',
    promptType: 'none',
    hosts: ['kimi.com', 'moonshot.cn'],
  }),
  copilot: Object.freeze({
    label: 'GitHub Copilot',
    binaryPath: '/usr/local/bin/copilot',
    loginArgs: ['login'],
    statusArgs: null,
    authMode: 'device_code',
    promptType: 'none',
    hosts: ['github.com'],
  }),
  opencode: Object.freeze({
    label: 'OpenCode',
    binaryPath: '/usr/local/bin/opencode',
    statusArgs: ['auth', 'list'],
    authMode: 'provider_account_login',
    promptType: 'authorization_code',
    providers: Object.freeze({
      openai: Object.freeze({
        label: 'OpenAI / ChatGPT',
        loginArgs: ['auth', 'login', '--provider', 'openai'],
        hosts: ['openai.com', 'chatgpt.com'],
      }),
      xai: Object.freeze({
        label: 'xAI SuperGrok',
        loginArgs: ['auth', 'login', '--provider', 'xai'],
        hosts: ['x.ai'],
      }),
      'github-copilot': Object.freeze({
        label: 'GitHub Copilot',
        loginArgs: ['auth', 'login', '--provider', 'github-copilot'],
        hosts: ['github.com'],
      }),
    }),
  }),
});

function normalizeContainerName(value) {
  const name = String(value || '').trim();
  if (!CONTAINER_NAME_PATTERN.test(name)) throw new Error('Invalid gateway container name');
  return name;
}

export function normalizeAccountAuthTarget(harnessValue, providerValue = '') {
  const harness = String(harnessValue || '').trim().toLowerCase();
  if (!NAME_PATTERN.test(harness)) return null;
  const recipe = ACP_ACCOUNT_AUTH_CATALOG[harness];
  if (!recipe) return null;
  if (!recipe.providers) return { harness, provider: null, recipe };
  const provider = String(providerValue || '').trim().toLowerCase();
  const providerRecipe = recipe.providers[provider];
  if (!providerRecipe) return null;
  return {
    harness,
    provider,
    recipe: { ...recipe, ...providerRecipe, providers: undefined },
  };
}

function defaultExecFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    nodeExecFile(file, args, { encoding: 'utf8', maxBuffer: 256 * 1024, ...options }, (error, stdout = '', stderr = '') => {
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

function clamp(value, limit = 8_000) {
  const text = String(value || '');
  return text.length <= limit ? text : `${text.slice(-limit)}\n[Earlier output omitted]`;
}

export function redactAccountAuthOutput(value, limit = 8_000) {
  let text = String(value || '')
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
  text = text
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/(["']?(?:access_token|refresh_token|id_token|session_token|token|api[_-]?key|authorization|secret|password)["']?\s*[:=]\s*["']?)([^\s,"'}\]]+)/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/\b(?:sk|gh[opusr])-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
  return clamp(text, limit);
}

function trimPunctuation(value) {
  return String(value || '').replace(/[),.;:'"]+$/g, '');
}

export function parseAccountAuthInstructions(value, allowedHosts = []) {
  const output = redactAccountAuthOutput(value);
  let verificationUrl = null;
  for (const candidate of output.match(/https:\/\/[^\s<>"'\u0000-\u001F\u007F]+/gi) || []) {
    try {
      const parsed = new URL(trimPunctuation(candidate));
      const hostname = parsed.hostname.toLowerCase();
      if (allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
        verificationUrl = parsed.toString();
        break;
      }
    } catch {
      // Wait for a complete URL in a later stream chunk.
    }
  }
  const match = output.match(/(?:device|verification|user|one[-\s]?time|authorization)\s+code(?:\s*(?:is|:|=)\s*|\s*\r?\n\s*)[`"']?([A-Z0-9]{4,}(?:[- ][A-Z0-9]{2,}){0,5})/i);
  const userCode = match?.[1] ? String(match[1]).trim().replace(/\s+/g, ' ').slice(0, 48) : null;
  return { verificationUrl, userCode };
}

export function buildAccountAuthDockerArgs({ containerName, target, commandArgs, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const container = normalizeContainerName(containerName);
  if (!target?.recipe?.binaryPath || !Array.isArray(commandArgs)) throw new Error('Invalid account-auth command');
  const environment = [
    'exec', '-i', '-u', 'node', '-w', '/home/node',
    '-e', 'HOME=/home/node',
    '-e', 'XDG_CONFIG_HOME=/home/node/.openclaw/acpx/config',
    '-e', 'XDG_DATA_HOME=/home/node/.openclaw/acpx/data',
    '-e', 'XDG_STATE_HOME=/home/node/.openclaw/acpx/state',
  ];
  if (target.harness === 'opencode') {
    environment.push('-e', 'OPENCODE_CONFIG=/home/node/.openclaw/acpx/opencode-config/opencode.json');
  }
  if (target.harness === 'copilot') {
    environment.push('-e', 'COPILOT_HOME=/home/node/.openclaw/acpx/copilot-home');
  }
  return [
    ...environment,
    container,
    'timeout', '--foreground', '--signal=TERM', '--kill-after=10s', `${Math.ceil(timeoutMs / 1000)}s`,
    target.recipe.binaryPath,
    ...commandArgs,
  ];
}

function safeError(error) {
  return redactAccountAuthOutput(error?.stderr || error?.stdout || error?.message || 'Account login failed', 800);
}

function authStatusFromOutput(target, result, output) {
  if (target.harness === 'claude') {
    try {
      const parsed = JSON.parse(String(output || '').trim());
      return parsed?.loggedIn === true || parsed?.authenticated === true || result?.code === 0;
    } catch {
      return result?.code === 0;
    }
  }
  if (target.harness === 'opencode') {
    return new RegExp(target.provider.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(output);
  }
  return null;
}

export class AcpAccountAuthJobManager {
  constructor({
    containerName,
    execFile = defaultExecFile,
    spawnProcess = nodeSpawn,
    now = () => Date.now(),
    createId = () => randomUUID(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retentionMs = DEFAULT_RETENTION_MS,
    audit = () => {},
  } = {}) {
    this.containerName = normalizeContainerName(containerName);
    this.execFile = execFile;
    this.spawnProcess = spawnProcess;
    this.now = now;
    this.createId = createId;
    this.timeoutMs = Math.max(60_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.retentionMs = Math.max(60_000, Number(retentionMs) || DEFAULT_RETENTION_MS);
    this.audit = typeof audit === 'function' ? audit : () => {};
    this.jobs = new Map();
  }

  record(job, event, details = {}) {
    this.audit({
      event,
      harness: job.target.harness,
      provider: job.target.provider,
      jobId: job.id,
      cliVersion: job.cliVersion || null,
      phase: job.phase,
      durationMs: Math.max(0, this.now() - job.createdAtMs),
      exitCode: Number.isInteger(details.exitCode) ? details.exitCode : null,
      errorCategory: details.errorCategory || job.errorCategory || null,
    });
  }

  resolve(harness, provider) {
    const target = normalizeAccountAuthTarget(harness, provider);
    if (!target) {
      const error = new Error('This ACP account-login target is not supported.');
      error.code = 'ACP_AUTH_UNSUPPORTED';
      throw error;
    }
    return target;
  }

  async execTarget(target, commandArgs, timeoutMs = 15_000) {
    return this.execFile('docker', buildAccountAuthDockerArgs({
      containerName: this.containerName,
      target,
      commandArgs,
      timeoutMs,
    }), { timeout: timeoutMs + 2_000 });
  }

  async getStatus(harness, provider) {
    const target = this.resolve(harness, provider);
    let version = null;
    try {
      const versionResult = await this.execTarget(target, ['--version']);
      version = redactAccountAuthOutput(`${versionResult.stdout || ''}\n${versionResult.stderr || ''}`, 160).split(/\r?\n/).find(Boolean) || null;
    } catch (error) {
      return {
        harness: target.harness,
        provider: target.provider,
        installed: false,
        authenticated: false,
        version: null,
        errorCode: 'ACP_CLI_MISSING',
        error: safeError(error),
      };
    }

    if (!target.recipe.statusArgs) {
      return {
        harness: target.harness,
        provider: target.provider,
        installed: true,
        authenticated: null,
        version,
        authMode: target.recipe.authMode,
        status: 'verification_requires_canary',
      };
    }
    try {
      const result = await this.execTarget(target, target.recipe.statusArgs);
      const output = redactAccountAuthOutput(`${result.stdout || ''}\n${result.stderr || ''}`, 1_000);
      const authenticated = authStatusFromOutput(target, result, output) === true;
      return {
        harness: target.harness,
        provider: target.provider,
        installed: true,
        authenticated,
        version,
        authMode: target.recipe.authMode,
        status: authenticated ? 'connected' : 'sign_in_required',
        error: authenticated ? null : 'The CLI account is not connected in the persistent VPS runtime.',
      };
    } catch (error) {
      return {
        harness: target.harness,
        provider: target.provider,
        installed: true,
        authenticated: false,
        version,
        authMode: target.recipe.authMode,
        status: 'sign_in_required',
        error: safeError(error),
      };
    }
  }

  snapshot(job) {
    if (!job) return null;
    return {
      jobId: job.id,
      id: job.id,
      harness: job.target.harness,
      provider: job.target.provider,
      status: job.status,
      phase: job.phase,
      verificationUrl: job.verificationUrl,
      userCode: job.userCode,
      promptType: job.promptType,
      expiresAt: new Date(job.expiresAtMs).toISOString(),
      createdAt: new Date(job.createdAtMs).toISOString(),
      updatedAt: new Date(job.updatedAtMs).toISOString(),
      error: job.error,
      errorCategory: job.errorCategory,
    };
  }

  appendOutput(job, value) {
    if (TERMINAL_STATES.has(job.status)) return;
    job.output = redactAccountAuthOutput(`${job.output}${String(value || '')}`);
    const parsed = parseAccountAuthInstructions(job.output, job.target.recipe.hosts || []);
    if (parsed.verificationUrl) job.verificationUrl = parsed.verificationUrl;
    if (parsed.userCode) job.userCode = parsed.userCode;
    if (/paste\s+(?:the\s+)?authorization code|enter\s+(?:the\s+)?authorization code|callback\s+url/i.test(job.output)) {
      job.status = 'waiting_for_input';
      job.phase = 'input';
      job.promptType = 'authorization_code';
    } else if (job.verificationUrl || job.userCode) {
      job.status = 'waiting_for_browser';
      job.phase = 'approval';
    }
    job.updatedAtMs = this.now();
  }

  start(harness, { provider = '', force = false } = {}) {
    const target = this.resolve(harness, provider);
    const existing = [...this.jobs.values()].find((job) => (
      job.target.harness === target.harness
      && job.target.provider === target.provider
      && !TERMINAL_STATES.has(job.status)
    ));
    if (existing && !force) return this.snapshot(existing);
    if (existing) this.cancel(existing.id);

    const now = this.now();
    const job = {
      id: this.createId(),
      target,
      status: 'starting',
      phase: 'login',
      promptType: 'none',
      createdAtMs: now,
      updatedAtMs: now,
      expiresAtMs: now + this.timeoutMs,
      verificationUrl: null,
      userCode: null,
      output: '',
      error: null,
      errorCategory: null,
      child: null,
    };
    this.jobs.set(job.id, job);
    this.record(job, 'login_started');
    const args = buildAccountAuthDockerArgs({
      containerName: this.containerName,
      target,
      commandArgs: target.recipe.loginArgs,
      timeoutMs: this.timeoutMs,
    });
    const child = this.spawnProcess('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    job.child = child;
    child.stdout?.on('data', (chunk) => this.appendOutput(job, chunk));
    child.stderr?.on('data', (chunk) => this.appendOutput(job, chunk));
    child.once('error', (error) => {
      job.status = 'failed';
      job.phase = 'complete';
      job.error = safeError(error);
      job.errorCategory = 'process_error';
      job.updatedAtMs = this.now();
      this.record(job, 'login_failed', { errorCategory: job.errorCategory });
    });
    child.once('close', async (code, signal) => {
      if (TERMINAL_STATES.has(job.status)) return;
      job.updatedAtMs = this.now();
      job.phase = 'complete';
      if (code === 0) {
        if (target.recipe.statusArgs) {
          const status = await this.getStatus(target.harness, target.provider);
          if (status.authenticated !== true) {
            job.status = 'failed';
            job.errorCategory = 'status_verification_failed';
            job.error = status.error || 'The CLI login finished, but its official status check did not confirm the account.';
          } else {
            job.status = 'connected';
            job.cliVersion = status.version || null;
          }
        } else {
          job.status = 'connected';
        }
      } else if (this.now() >= job.expiresAtMs || signal === 'SIGTERM') {
        job.status = 'expired';
        job.errorCategory = 'expired';
        job.error = 'The provider login expired. Start a fresh login.';
      } else {
        job.status = 'failed';
        job.errorCategory = 'provider_rejected';
        job.error = 'The provider did not complete account login. Start a fresh login and verify the selected account.';
      }
      this.record(job, job.status === 'connected' ? 'login_connected' : 'login_failed', {
        exitCode: code,
        errorCategory: job.errorCategory,
      });
      const timer = setTimeout(() => this.jobs.delete(job.id), this.retentionMs);
      timer.unref?.();
    });
    return this.snapshot(job);
  }

  getJob(jobId) {
    return this.snapshot(this.jobs.get(String(jobId || '').trim()));
  }

  input(jobId, value) {
    const job = this.jobs.get(String(jobId || '').trim());
    if (!job || TERMINAL_STATES.has(job.status)) return null;
    if (job.promptType !== 'authorization_code') {
      const error = new Error('This provider login does not accept browser input.');
      error.code = 'ACP_AUTH_INPUT_NOT_EXPECTED';
      throw error;
    }
    const code = String(value || '').trim();
    if (!code || code.length > 2_048 || /[\u0000\r\n]/.test(code)) {
      const error = new Error('A valid authorization code is required.');
      error.code = 'ACP_AUTH_INPUT_INVALID';
      throw error;
    }
    job.child?.stdin?.write(`${code}\n`);
    job.status = 'verifying';
    job.phase = 'verification';
    job.updatedAtMs = this.now();
    this.record(job, 'authorization_input_submitted');
    return this.snapshot(job);
  }

  cancel(jobId) {
    const job = this.jobs.get(String(jobId || '').trim());
    if (!job) return null;
    if (!TERMINAL_STATES.has(job.status)) {
      job.status = 'cancelled';
      job.phase = 'complete';
      job.updatedAtMs = this.now();
      job.child?.kill?.('SIGTERM');
      this.record(job, 'login_cancelled');
    }
    return this.snapshot(job);
  }
}
