import { randomUUID } from 'crypto';
import { execFile as nodeExecFile, spawn as nodeSpawn } from 'child_process';

// ACP deliberately gives Codex its own home.  Do not replace this with the
// default ~/.codex: the acpx adapter reads this exact directory when it starts
// Codex for a run.
export const DEFAULT_CODEX_ACP_CONTAINER_HOME = '/home/node/.openclaw/acpx/codex-home';
export const DEFAULT_CODEX_DEVICE_AUTH_TIMEOUT_MS = 12 * 60 * 1000;
export const DEFAULT_CODEX_DEVICE_AUTH_RETENTION_MS = 15 * 60 * 1000;
export const DEFAULT_CODEX_DEVICE_AUTH_RESTART_WAIT_MS = 8_000;
export const MAX_CODEX_DEVICE_AUTH_OUTPUT_CHARS = 16_000;

const CONTAINER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const OPENAI_LOGIN_HOSTS = new Set([
  'auth.openai.com',
  'auth0.openai.com',
  'chatgpt.com',
  'login.openai.com',
]);
const NON_DEVICE_AUTH_CODE_WORDS = new Set([
  'authorization',
  'verification',
  'device',
  'browser',
  'continue',
  'openai',
]);

// This is a deliberately small, public-safe failure vocabulary. The CLI's
// detailed output remains redacted, but the client needs enough information to
// distinguish an account/workspace policy rejection from a VPS installation
// problem. Do not turn arbitrary CLI output into a UI error code.
export const CODEX_DEVICE_AUTH_FAILURE_KIND = Object.freeze({
  DEVICE_CODE_NOT_ENABLED: 'device_code_not_enabled',
});

/**
 * Both the browser OAuth bridge and `codex login --device-auth` persist this
 * native schema. Passive runtime probes must preserve a valid existing session
 * rather than copying an older auth-profile over it.
 */
export function hasValidNativeCodexChatGptAuth(auth) {
  const tokens = auth?.tokens && typeof auth.tokens === 'object' ? auth.tokens : {};
  return auth?.auth_mode === 'chatgpt'
    && Boolean(String(tokens.access_token || '').trim())
    && Boolean(String(tokens.refresh_token || '').trim());
}

function clampText(value, limit = MAX_CODEX_DEVICE_AUTH_OUTPUT_CHARS) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return `${text.slice(text.length - limit)}\n[Earlier output omitted]`;
}

/**
 * `codex login --device-auth` writes coloured terminal output even when its
 * streams are piped.  Those escape sequences are not visible text, but a
 * URL parser treats the trailing reset sequence as part of the URL (for
 * example, `.../device%1B[0m`).  Remove terminal controls before either
 * rendering or parsing the managed process output.
 */
function stripTerminalControlSequences(value) {
  return String(value || '')
    // OSC needs to be handled before the one-byte escape sequence form.
    .replace(/\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g, '')
    // CSI (colours, cursor movement, etc.) and single-character escapes.
    .replace(/\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, '')
    // Keep ordinary layout controls, but never surface remaining terminal
    // control bytes to a browser client.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
}

function normalizeContainerName(value) {
  const containerName = String(value || '').trim();
  if (!CONTAINER_NAME_PATTERN.test(containerName)) {
    throw new Error('Invalid gateway container name');
  }
  return containerName;
}

function normalizeCodexHome(value) {
  const codexHome = String(value || '').trim();
  if (codexHome !== DEFAULT_CODEX_ACP_CONTAINER_HOME) {
    throw new Error('Invalid Codex ACP home');
  }
  return codexHome;
}

function commandErrorText(error) {
  const parts = [error?.stderr, error?.stdout, error?.message]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return parts.find(Boolean) || 'Command failed';
}

function commandSucceeded(result) {
  // The bridge's runExecFileAsync returns { stdout, stderr } on success,
  // whereas tests/adapters may include an explicit status field. A fulfilled
  // result is therefore successful unless it expressly says otherwise.
  if (!result) return false;
  if (result?.ok === false) return false;
  if (typeof result?.code === 'number') return result.code === 0;
  if (typeof result?.exitCode === 'number') return result.exitCode === 0;
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

function terminalState(state) {
  return ['connected', 'failed', 'cancelled', 'expired'].includes(state);
}

function trimTrailingPunctuation(value) {
  return String(value || '').replace(/[),.;]+$/, '');
}

/**
 * Device codes are intentionally not redacted: the signed-in human must be
 * able to enter them in the browser handoff.  Actual bearer/API/refresh
 * credentials never leave this process, however, even if a future CLI prints
 * one unexpectedly.
 */
export function redactCodexDeviceAuthOutput(value, limit = MAX_CODEX_DEVICE_AUTH_OUTPUT_CHARS) {
  let text = stripTerminalControlSequences(value);

  // Handle the header-shaped form before generic key/value matching; otherwise
  // the generic expression would redact the word "Bearer" and retain its
  // credential as a separate token.
  text = text.replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, '$1[redacted]');

  // JSON/token assignment forms first, so a later generic replacement cannot
  // accidentally retain a quoted suffix.
  text = text.replace(
    /(["']?(?:access_token|refresh_token|id_token|session_token|token|api[_-]?key|authorization|secret|password)["']?[ \t]*[:=][ \t]*["']?)([^\s,"'}\]]+)/gi,
    '$1[redacted]',
  );
  text = text.replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]');
  text = text.replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[redacted]');
  text = text.replace(/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, '[redacted]');
  text = text.replace(/([?&](?:access_token|refresh_token|id_token|token|api[_-]?key)=)[^&\s]+/gi, '$1[redacted]');
  text = text.replace(/(OPENAI_API_KEY\s*=\s*)[^\s]+/gi, '$1[redacted]');

  return clampText(text, limit);
}

/**
 * Translate the one actionable upstream policy error into a stable UI signal.
 * Device-code login is enabled per personal account *or* by a ChatGPT
 * workspace admin. A browser can therefore show this error even when the
 * person has enabled the personal-account toggle, if they then select a
 * workspace without that permission. Other failures stay generic so Trooper
 * never overclaims why a provider rejected a login.
 */
export function classifyCodexDeviceAuthFailure(value) {
  const output = redactCodexDeviceAuthOutput(value, 4_000);
  if (/enable\s+device\s+code\s+authorization\s+for\s+codex/i.test(output)) {
    return {
      failureKind: CODEX_DEVICE_AUTH_FAILURE_KIND.DEVICE_CODE_NOT_ENABLED,
      error: 'Device-code login was rejected by the selected ChatGPT account or workspace. Enable it in ChatGPT Security settings for a personal account, or ask the ChatGPT workspace admin to allow device-code login. Then start a new code; an existing code cannot pick up the changed permission.',
    };
  }
  return { failureKind: null, error: null };
}

export function parseCodexDeviceAuthInstructions(value) {
  const output = redactCodexDeviceAuthOutput(value);
  const urls = output.match(/https:\/\/[^\s<>"'\u0000-\u001F\u007F]+/gi) || [];
  let verificationUrl = null;
  for (const candidate of urls) {
    try {
      const parsed = new URL(trimTrailingPunctuation(candidate));
      const host = parsed.hostname.toLowerCase();
      if (parsed.protocol === 'https:' && (OPENAI_LOGIN_HOSTS.has(host) || host.endsWith('.openai.com') || host.endsWith('.chatgpt.com'))) {
        verificationUrl = parsed.toString();
        break;
      }
    } catch {
      // A partial URL in streamed output is not useful until a later chunk
      // completes it, so simply keep scanning.
    }
  }

  // Codex's current device flow says "get a device code authorization" just
  // before printing the real code on a later line.  Do not accept any bare
  // word after `code`: that would turn the prose word "authorization" into
  // the user code.  A real value must follow an explicit separator (or a new
  // line), and is normalised only after that structural check.
  const codeMatch = output.match(
    /(?:(?:one[-\s]?time|device|verification|user|authorization)\s+code|code)\b(?:\s*\([^\r\n)]*\))?(?:\s*(?:is|:|=)\s*|\s*\r?\n\s*)[`"']?([A-Z0-9]{4,}(?:[- ][A-Z0-9]{2,}){0,5})[`"']?/i,
  );
  const rawCode = String(codeMatch?.[1] || '').trim().replace(/\s+/g, ' ');
  const plainWord = rawCode.toLowerCase();
  const userCode = rawCode
    && rawCode.length <= 48
    && /^[A-Z0-9]+(?:[- ][A-Z0-9]+){0,5}$/.test(rawCode)
    && !NON_DEVICE_AUTH_CODE_WORDS.has(plainWord)
    ? rawCode
    : null;

  return { verificationUrl, userCode };
}

/**
 * Build the only Docker invocation this feature is allowed to make.  It is
 * intentionally argv-only (no shell interpolation) and pins the Unix user,
 * HOME and CODEX_HOME to the real gateway identity/ACP store.
 */
export function buildCodexDeviceAuthDockerArgs({
  containerName,
  codexHome = DEFAULT_CODEX_ACP_CONTAINER_HOME,
  commandArgs = [],
} = {}) {
  const container = normalizeContainerName(containerName);
  const home = normalizeCodexHome(codexHome);
  if (!Array.isArray(commandArgs) || commandArgs.length === 0 || commandArgs.some((arg) => typeof arg !== 'string' || !arg)) {
    throw new Error('Invalid managed Codex command');
  }
  return [
    'exec',
    '-u', 'node',
    '-w', '/home/node',
    '-e', 'HOME=/home/node',
    '-e', `CODEX_HOME=${home}`,
    // Codex otherwise may prefer an OS keychain.  ACP runs headlessly inside
    // the container, so its native auth file must be used instead.
    '-e', 'CODEX_CLI_AUTH_CREDENTIALS_STORE=file',
    container,
    ...commandArgs,
  ];
}

/**
 * The upstream gateway image normally keeps the global npm prefix under
 * /usr/local, which is root-owned. Installation is therefore one fixed root
 * operation; the CLI is subsequently probed and run as `node`. Nothing from
 * a request is allowed to alter this package, user, or command.
 */
export function buildCodexCliInstallDockerArgs({ containerName } = {}) {
  const container = normalizeContainerName(containerName);
  return [
    'exec',
    '-u', '0',
    '-w', '/home/node',
    container,
    'timeout', '--foreground', '--signal=TERM', '--kill-after=10s', '180s',
    'npm', 'install', '--global', '--no-audit', '--no-fund', '@openai/codex',
  ];
}

export class CodexDeviceAuthJobManager {
  constructor({
    containerName,
    codexHome = DEFAULT_CODEX_ACP_CONTAINER_HOME,
    execFile = defaultExecFile,
    spawnProcess = nodeSpawn,
    now = () => Date.now(),
    createId = () => randomUUID(),
    timeoutMs = DEFAULT_CODEX_DEVICE_AUTH_TIMEOUT_MS,
    retentionMs = DEFAULT_CODEX_DEVICE_AUTH_RETENTION_MS,
    restartWaitMs = DEFAULT_CODEX_DEVICE_AUTH_RESTART_WAIT_MS,
  } = {}) {
    this.containerName = normalizeContainerName(containerName);
    this.codexHome = normalizeCodexHome(codexHome);
    this.execFile = execFile;
    this.spawnProcess = spawnProcess;
    this.now = now;
    this.createId = createId;
    this.timeoutMs = Math.max(60_000, Number(timeoutMs) || DEFAULT_CODEX_DEVICE_AUTH_TIMEOUT_MS);
    this.retentionMs = Math.max(60_000, Number(retentionMs) || DEFAULT_CODEX_DEVICE_AUTH_RETENTION_MS);
    this.restartWaitMs = Math.max(1_000, Number(restartWaitMs) || DEFAULT_CODEX_DEVICE_AUTH_RESTART_WAIT_MS);
    this.jobs = new Map();
    this.activeJobId = null;
  }

  dockerArgs(commandArgs) {
    return buildCodexDeviceAuthDockerArgs({
      containerName: this.containerName,
      codexHome: this.codexHome,
      commandArgs,
    });
  }

  installDockerArgs() {
    return buildCodexCliInstallDockerArgs({ containerName: this.containerName });
  }

  deviceAuthCommandArgs() {
    const seconds = Math.ceil(this.timeoutMs / 1000);
    return [
      // The bridge timer protects the UI. This in-container timeout protects
      // the gateway as well if the bridge process is restarted mid-login.
      'timeout', '--foreground', '--signal=TERM', '--kill-after=10s', `${seconds}s`,
      'codex', '-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth',
    ];
  }

  async execManaged(commandArgs, { timeout = 15_000 } = {}) {
    return this.execFile('docker', this.dockerArgs(commandArgs), { timeout });
  }

  async ensureCodexHome() {
    // No shell and no caller-controlled path: this only creates the fixed ACP
    // home in the gateway volume, owned by the node account.
    await this.execManaged(['mkdir', '-p', this.codexHome], { timeout: 15_000 });
    await this.execManaged(['chmod', '700', this.codexHome], { timeout: 15_000 });
  }

  async getAvailability() {
    let installed = false;
    let version = null;
    let probeError = null;
    try {
      const result = await this.execManaged(['codex', '--version']);
      installed = commandSucceeded(result);
      const output = redactCodexDeviceAuthOutput(`${result?.stdout || ''}\n${result?.stderr || ''}`).trim();
      version = output ? output.split(/\r?\n/).find(Boolean)?.slice(0, 160) || null : null;
    } catch (error) {
      probeError = redactCodexDeviceAuthOutput(commandErrorText(error), 500);
    }

    if (!installed) {
      return {
        installed: false,
        authenticated: false,
        version: null,
        installable: true,
        error: probeError || null,
      };
    }

    try {
      const result = await this.execManaged([
        'codex', '-c', 'cli_auth_credentials_store="file"', 'login', 'status',
      ]);
      const statusOutput = redactCodexDeviceAuthOutput(`${result?.stdout || ''}\n${result?.stderr || ''}`, 500);
      // Codex documents the exit status as the automation contract. Do not
      // make a successful device login look disconnected merely because a
      // future CLI version changes, localizes, or suppresses status wording.
      const authenticated = commandSucceeded(result);
      return {
        installed: true,
        authenticated,
        version,
        installable: true,
        error: authenticated ? null : (statusOutput.trim() || null),
      };
    } catch (error) {
      return {
        installed: true,
        authenticated: false,
        version,
        installable: true,
        error: redactCodexDeviceAuthOutput(commandErrorText(error), 500),
      };
    }
  }

  currentActiveJob() {
    const job = this.activeJobId ? this.jobs.get(this.activeJobId) : null;
    if (!job || terminalState(job.state)) {
      this.activeJobId = null;
      return null;
    }
    return job;
  }

  appendOutput(job, chunk) {
    if (!job || terminalState(job.state)) return;
    const next = redactCodexDeviceAuthOutput(`${job.output || ''}${String(chunk || '')}`);
    job.output = next;
    const instructions = parseCodexDeviceAuthInstructions(next);
    if (instructions.verificationUrl) job.verificationUrl = instructions.verificationUrl;
    if (instructions.userCode) job.userCode = instructions.userCode;
    if (job.state === 'starting' && (job.verificationUrl || job.userCode)) {
      job.state = 'waiting_for_browser';
    }
    job.updatedAtMs = this.now();
  }

  snapshot(job) {
    if (!job) return null;
    const message = job.error
      || (job.state === 'waiting_for_browser'
        ? 'Complete the browser sign-in with the verification code.'
        : job.state === 'installing'
          ? 'Installing Codex CLI on the gateway runtime.'
          : job.state === 'starting'
            ? 'Starting secure Codex device authorization on the gateway runtime.'
            : job.state === 'cancelling'
              ? 'Cancelling Codex device authorization.'
              : job.state === 'connected'
                ? 'Codex is connected to the gateway ACP runtime.'
                : job.state === 'expired'
                  ? 'Codex device authorization expired before completion.'
                  : null);
    return {
      id: job.id,
      jobId: job.id,
      status: job.state,
      state: job.state,
      phase: job.phase,
      createdAtMs: job.createdAtMs,
      updatedAtMs: job.updatedAtMs,
      expiresAtMs: job.expiresAtMs,
      createdAt: new Date(job.createdAtMs).toISOString(),
      updatedAt: new Date(job.updatedAtMs).toISOString(),
      expiresAt: new Date(job.expiresAtMs).toISOString(),
      verificationUrl: job.verificationUrl || null,
      verificationUri: job.verificationUrl || null,
      userCode: job.userCode || null,
      output: redactCodexDeviceAuthOutput(job.output || ''),
      error: job.error ? redactCodexDeviceAuthOutput(job.error, 800) : null,
      failureKind: job.failureKind || null,
      message: message ? redactCodexDeviceAuthOutput(message, 800) : null,
      installed: job.installed === true ? true : undefined,
      authenticated: job.state === 'connected',
    };
  }

  scheduleRetention(job) {
    if (!job || job.retentionTimer) return;
    const timer = setTimeout(() => {
      const current = this.jobs.get(job.id);
      if (current && terminalState(current.state)) this.jobs.delete(job.id);
    }, this.retentionMs);
    timer.unref?.();
    job.retentionTimer = timer;
  }

  async waitForTerminalState(job) {
    if (!job || terminalState(job.state)) return true;
    const completion = job.completion;
    if (!completion || typeof completion.then !== 'function') return false;
    let timer = null;
    try {
      return await Promise.race([
        completion.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), this.restartWaitMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  finish(job, state, { error = null, failureKind = null } = {}) {
    if (!job || terminalState(job.state)) return;
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
    if (job.cancelTimer) clearTimeout(job.cancelTimer);
    job.timeoutTimer = null;
    job.cancelTimer = null;
    job.child = null;
    job.state = state;
    job.phase = state;
    job.error = error ? redactCodexDeviceAuthOutput(error, 800) : null;
    job.failureKind = failureKind || null;
    job.updatedAtMs = this.now();
    if (this.activeJobId === job.id) this.activeJobId = null;
    job.resolveCompletion?.(this.snapshot(job));
    job.resolveCompletion = null;
    this.scheduleRetention(job);
  }

  async beginDeviceAuth(job) {
    if (!job || terminalState(job.state) || job.cancelRequested) return;
    try {
      await this.ensureCodexHome();
    } catch (error) {
      this.finish(job, 'failed', { error: `Could not prepare Codex ACP home: ${commandErrorText(error)}` });
      return;
    }
    if (job.cancelRequested) {
      this.finish(job, 'cancelled');
      return;
    }

    job.phase = 'device_auth';
    job.state = 'starting';
    job.updatedAtMs = this.now();
    let child;
    try {
      child = this.spawnProcess('docker', this.dockerArgs(this.deviceAuthCommandArgs()), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.finish(job, 'failed', { error: commandErrorText(error) });
      return;
    }
    this.observeChild(job, child, 'device_auth');
  }

  beginInstall(job) {
    if (!job || terminalState(job.state) || job.cancelRequested) return;
    job.phase = 'install';
    job.state = 'installing';
    job.updatedAtMs = this.now();
    let child;
    try {
      // This is deliberately a fixed package and flag set.  This endpoint is
      // not a generic package installer or command channel.
      child = this.spawnProcess('docker', this.installDockerArgs(), {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      this.finish(job, 'failed', { error: commandErrorText(error) });
      return;
    }
    this.observeChild(job, child, 'install');
  }

  observeChild(job, child, kind) {
    job.child = child;
    const consume = (chunk) => this.appendOutput(job, chunk);
    child?.stdout?.on?.('data', consume);
    child?.stderr?.on?.('data', consume);
    child?.once?.('error', (error) => {
      if (job.cancelRequested) {
        this.finish(job, 'cancelled');
      } else {
        this.finish(job, 'failed', { error: commandErrorText(error) });
      }
    });
    child?.once?.('close', (code, signal) => {
      void this.handleChildClose(job, kind, code, signal);
    });
  }

  async handleChildClose(job, kind, code, signal) {
    if (!job || terminalState(job.state)) return;
    job.child = null;
    job.updatedAtMs = this.now();
    if (job.cancelRequested) {
      this.finish(job, 'cancelled');
      return;
    }
    if (job.timedOut || code === 124) {
      const installing = kind === 'install';
      this.finish(job, installing ? 'failed' : 'expired', {
        error: installing
          ? 'Timed out installing Codex CLI on the gateway runtime'
          : 'Timed out waiting for Codex device authorization',
      });
      return;
    }
    if (kind === 'install') {
      if (code !== 0) {
        this.finish(job, 'failed', { error: `Codex CLI install exited with ${signal || code || 'an error'}` });
        return;
      }
      const availability = await this.getAvailability();
      if (!availability.installed) {
        this.finish(job, 'failed', { error: availability.error || 'Codex CLI did not become available after installation' });
        return;
      }
      job.installed = true;
      job.output = redactCodexDeviceAuthOutput(`${job.output}\nCodex CLI installed. Starting secure device authorization…`);
      await this.beginDeviceAuth(job);
      return;
    }

    if (code !== 0) {
      const classified = classifyCodexDeviceAuthFailure(job.output);
      this.finish(job, 'failed', {
        error: classified.error || `Codex device authorization exited with ${signal || code || 'an error'}`,
        failureKind: classified.failureKind,
      });
      return;
    }

    const availability = await this.getAvailability();
    if (availability.authenticated) {
      this.finish(job, 'connected');
      return;
    }
    const classified = classifyCodexDeviceAuthFailure(`${job.output}\n${availability.error || ''}`);
    this.finish(job, 'failed', {
      error: classified.error || availability.error || 'Codex did not report an authenticated gateway session after device authorization',
      failureKind: classified.failureKind,
    });
  }

  async start({ force = false, restart = false, installIfMissing = true } = {}) {
    let active = this.currentActiveJob();
    if (active && restart) {
      await this.cancel(active.id);
      const stopped = await this.waitForTerminalState(active);
      active = this.currentActiveJob();
      if (!stopped || active) {
        const error = new Error('The previous Codex sign-in is still stopping. Wait a few seconds, then start a fresh code.');
        error.code = 'CODEX_DEVICE_AUTH_RESTART_PENDING';
        throw error;
      }
    }
    if (active) {
      const snapshot = this.snapshot(active);
      return { reused: true, job: snapshot, ...snapshot };
    }

    const availability = await this.getAvailability();
    if (availability.authenticated && !force) {
      return {
        alreadyAuthenticated: true,
        availability,
        job: null,
        jobId: null,
        status: 'connected',
        state: 'connected',
        message: 'Codex is already connected to the gateway ACP runtime.',
      };
    }
    if (!availability.installed && !installIfMissing) {
      const error = new Error(availability.error || 'Codex CLI is not installed on the gateway');
      error.code = 'CODEX_CLI_MISSING';
      error.availability = availability;
      throw error;
    }

    const now = this.now();
    let resolveCompletion;
    const completion = new Promise((resolve) => { resolveCompletion = resolve; });
    const job = {
      id: this.createId(),
      createdAtMs: now,
      updatedAtMs: now,
      expiresAtMs: now + this.timeoutMs,
      phase: availability.installed ? 'device_auth' : 'install',
      state: availability.installed ? 'starting' : 'installing',
      installed: availability.installed,
      output: '',
      error: null,
      failureKind: null,
      verificationUrl: null,
      userCode: null,
      child: null,
      timeoutTimer: null,
      cancelTimer: null,
      retentionTimer: null,
      cancelRequested: false,
      timedOut: false,
      completion,
      resolveCompletion,
    };
    this.jobs.set(job.id, job);
    this.activeJobId = job.id;
    job.timeoutTimer = setTimeout(() => {
      void this.timeout(job.id);
    }, this.timeoutMs);
    job.timeoutTimer.unref?.();

    if (availability.installed) {
      await this.beginDeviceAuth(job);
    } else {
      this.beginInstall(job);
    }
    const snapshot = this.snapshot(job);
    return {
      alreadyAuthenticated: false,
      availability,
      job: snapshot,
      ...snapshot,
    };
  }

  async timeout(jobId) {
    const job = this.jobs.get(String(jobId || ''));
    if (!job || terminalState(job.state)) return this.snapshot(job);
    job.timedOut = true;
    job.state = 'expiring';
    job.phase = 'expiring';
    job.updatedAtMs = this.now();
    try { job.child?.kill?.('SIGTERM'); } catch {}
    // Docker normally forwards SIGTERM to the foreground exec process.  Keep a
    // bounded fallback so stale client handles cannot leave the UI spinning.
    job.cancelTimer = setTimeout(() => {
      this.finish(job, 'expired', { error: 'Timed out waiting for Codex device authorization' });
    }, 5_000);
    job.cancelTimer.unref?.();
    return this.snapshot(job);
  }

  getStatus(jobId) {
    return this.snapshot(this.jobs.get(String(jobId || '')));
  }

  async cancel(jobId) {
    const job = this.jobs.get(String(jobId || ''));
    if (!job) return null;
    if (terminalState(job.state)) return this.snapshot(job);
    job.cancelRequested = true;
    job.state = 'cancelling';
    job.phase = 'cancelling';
    job.updatedAtMs = this.now();
    try { job.child?.kill?.('SIGTERM'); } catch {}
    job.cancelTimer = setTimeout(() => this.finish(job, 'cancelled'), 5_000);
    job.cancelTimer.unref?.();
    return this.snapshot(job);
  }
}
