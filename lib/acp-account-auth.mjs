import { execFile as nodeExecFile, spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const TERMINAL_STATES = new Set(['connected', 'failed', 'cancelled', 'expired']);
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_RETENTION_MS = 15 * 60_000;

// Command lines below are verified against the pinned CLI releases from the
// gateway image (claude 2.1.220, opencode 1.14.48, kimi 0.30.0, copilot
// 1.0.75). OpenCode's `--method` labels must match the CLI's advertised
// method names exactly; without a method it renders an interactive arrow-key
// picker that a headless job can never answer.
export const ACP_ACCOUNT_AUTH_CATALOG = Object.freeze({
  claude: Object.freeze({
    label: 'Claude Code',
    binaryPath: '/usr/local/bin/claude',
    loginArgs: ['auth', 'login'],
    statusArgs: ['auth', 'status', '--json'],
    authMode: 'official_browser_login',
    promptType: 'authorization_code',
    // `claude auth login` prints "If the browser didn't open, visit:
    // https://claude.com/…oauth/authorize…" and then waits on
    // "Paste code here if prompted >". Anthropic moved its login pages to
    // claude.com; the older hosts stay for CLI releases that still use them.
    hosts: ['claude.com', 'claude.ai', 'anthropic.com'],
  }),
  kimi: Object.freeze({
    label: 'Kimi Code',
    binaryPath: '/usr/local/bin/kimi',
    loginArgs: ['login'],
    statusArgs: null,
    authMode: 'device_code',
    promptType: 'none',
    hosts: ['kimi.com', 'moonshot.cn', 'moonshot.ai'],
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
        // The headless method prints a device URL + one-time code, which is
        // the only ChatGPT method that works without a VPS-side browser.
        loginArgs: ['auth', 'login', '--provider', 'openai', '--method', 'ChatGPT Pro/Plus (headless)'],
        hosts: ['openai.com', 'chatgpt.com'],
      }),
      xai: Object.freeze({
        label: 'xAI SuperGrok',
        // OpenCode's xai provider has no account OAuth: it asks
        // "Enter your API key" directly. The job accepts the key through the
        // same guarded input channel used for authorization codes.
        loginArgs: ['auth', 'login', '--provider', 'xai'],
        promptType: 'api_key',
        hosts: ['x.ai'],
      }),
      'github-copilot': Object.freeze({
        label: 'GitHub Copilot',
        loginArgs: ['auth', 'login', '--provider', 'github-copilot', '--method', 'Login with GitHub Copilot'],
        // After the method, OpenCode still asks "Select GitHub deployment
        // type" with GitHub.com preselected; a carriage return accepts it.
        autoRespond: Object.freeze([
          Object.freeze({ pattern: 'select\\s+github\\s+deployment\\s+type', response: '\r' }),
        ]),
        hosts: ['github.com'],
      }),
    }),
  }),
});

// The real prompts these CLIs print while logging in headlessly:
//   claude 2.1.220:      "Paste code here if prompted > "
//   opencode 1.14.48:    "Enter your API key" (xai)
// Older/other CLIs may still use "paste/enter the authorization code" or a
// callback-URL prompt, so those stay recognized.
const AUTHORIZATION_CODE_PROMPT_PATTERN = /paste\s+code\s+here|paste\s+(?:the\s+)?(?:authorization|verification)\s+code|enter\s+(?:the\s+)?authorization\s+code|callback\s+url/i;
const API_KEY_PROMPT_PATTERN = /enter\s+your\s+api\s+key/i;
const INPUT_PROMPT_TYPES = new Set(['authorization_code', 'api_key']);

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

/**
 * `opencode auth list` prints display labels ("GitHub Copilot oauth",
 * "xAI api", "OpenAI oauth"), not provider ids, so compare with all
 * non-alphanumerics removed and per line to avoid matching path or count
 * lines.
 */
export function opencodeCredentialListHasProvider(provider, output) {
  const normalizedProvider = String(provider || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (!normalizedProvider) return false;
  return String(output || '').split(/\r?\n/).some((line) => {
    const normalizedLine = line.replace(/[^a-z0-9]/gi, '').toLowerCase();
    return normalizedLine.startsWith(normalizedProvider) && !/^credentials/.test(normalizedLine);
  });
}

function authStatusFromOutput(target, result, output) {
  if (target.harness === 'claude') {
    try {
      const parsed = JSON.parse(String(output || '').trim());
      // An explicit negative must win even when the CLI exits zero.
      if (parsed?.loggedIn === true || parsed?.authenticated === true) return true;
      if (parsed?.loggedIn === false || parsed?.authenticated === false) return false;
      return result?.code === 0;
    } catch {
      return result?.code === 0;
    }
  }
  if (target.harness === 'opencode') {
    return opencodeCredentialListHasProvider(target.provider, output);
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
    // Fixed catalog auto-responses (for example accepting OpenCode's default
    // "GitHub.com" deployment). Each rule fires at most once and only sends
    // its catalog-defined keystroke, never request data.
    const autoRespond = job.target.recipe.autoRespond || [];
    autoRespond.forEach((rule, index) => {
      if (job.autoResponded.has(index)) return;
      if (!new RegExp(rule.pattern, 'i').test(job.output)) return;
      job.autoResponded.add(index);
      job.child?.stdin?.write(rule.response);
    });
    const parsed = parseAccountAuthInstructions(job.output, job.target.recipe.hosts || []);
    if (parsed.verificationUrl) job.verificationUrl = parsed.verificationUrl;
    if (parsed.userCode) job.userCode = parsed.userCode;
    // Once input was submitted, only a fresh prompt in the new chunk may pull
    // the job back to waiting_for_input; the old prompt text stays in the
    // accumulated transcript forever and must not undo `verifying`.
    const promptSource = job.status === 'verifying' ? String(value || '') : job.output;
    if (API_KEY_PROMPT_PATTERN.test(promptSource)) {
      job.status = 'waiting_for_input';
      job.phase = 'input';
      job.promptType = 'api_key';
    } else if (AUTHORIZATION_CODE_PROMPT_PATTERN.test(promptSource)) {
      job.status = 'waiting_for_input';
      job.phase = 'input';
      job.promptType = 'authorization_code';
    } else if (job.status !== 'verifying' && (job.verificationUrl || job.userCode)) {
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
      autoResponded: new Set(),
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
        // The transcript is already credential-redacted; its last lines carry
        // the CLI's actual reason (for example an unknown login-method label
        // after a CLI upgrade), which the operator needs to see.
        const detail = String(job.output || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter((line) => line && !/^[─-╿]+$/.test(line))
          .slice(-3)
          .join(' ')
          .slice(0, 400);
        job.error = detail
          ? `The provider did not complete account login: ${detail}`
          : 'The provider did not complete account login. Start a fresh login and verify the selected account.';
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
    if (!INPUT_PROMPT_TYPES.has(job.promptType)) {
      const error = new Error('This provider login does not accept browser input.');
      error.code = 'ACP_AUTH_INPUT_NOT_EXPECTED';
      throw error;
    }
    const code = String(value || '').trim();
    if (!code || code.length > 2_048 || /[\u0000\r\n]/.test(code)) {
      const error = new Error(job.promptType === 'api_key'
        ? 'A valid API key is required.'
        : 'A valid authorization code is required.');
      error.code = 'ACP_AUTH_INPUT_INVALID';
      throw error;
    }
    // CR then LF: interactive CLI prompts (clack/ink) submit on carriage
    // return only — a bare "\n" is dropped as an unknown keypress and the
    // login hangs — while plain readline prompts consume CRLF as one line.
    job.child?.stdin?.write(`${code}\r\n`);
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
