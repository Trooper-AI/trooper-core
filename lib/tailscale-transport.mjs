import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const RUNTIME_DIR = '/var/lib/trooper-org-runtime';
const STATUS_PATH = `${RUNTIME_DIR}/tailscale-status.json`;
const CONFIG_PATH = `${RUNTIME_DIR}/tailscale-config.json`;
const TAILSCALE_PATHS = ['/usr/bin/tailscale', '/usr/local/bin/tailscale', '/snap/bin/tailscale'];

function tailscaleBinary() {
  return TAILSCALE_PATHS.find((candidate) => existsSync(candidate)) || null;
}

function cleanHostname(value) {
  const hostname = String(value || '').trim().toLowerCase();
  if (!hostname) return '';
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(hostname)) {
    throw new Error('Tailscale hostname must contain only letters, numbers, and hyphens.');
  }
  return hostname;
}

function cleanTags(value) {
  const tags = String(value || '').trim();
  if (!tags) return '';
  const entries = tags.split(',').map((entry) => entry.trim()).filter(Boolean);
  if (!entries.every((entry) => /^tag:[a-z0-9][a-z0-9-]{0,62}$/i.test(entry))) {
    throw new Error('Tailscale tags must use comma-separated tag:name values.');
  }
  return entries.join(',');
}

export function isValidTailscaleAuthKey(value) {
  return /^tskey-(?:auth-)?[A-Za-z0-9_-]{12,}$/.test(String(value || '').trim());
}

export function normalizeTailscaleTransportInput(body = {}) {
  const authKey = String(body.authKey || '').trim();
  if (!isValidTailscaleAuthKey(authKey)) {
    throw new Error('A valid Tailscale auth key is required.');
  }
  return {
    authKey,
    hostname: cleanHostname(body.hostname),
    tags: cleanTags(body.tags),
  };
}

function runProcess(command, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => `${current}${chunk}`.slice(-16_384);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Command timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      reject(new Error(stderr.trim() || stdout.trim() || `Command exited with status ${code}.`));
    });
  });
}

function writeStatus(status) {
  try {
    mkdirSync(RUNTIME_DIR, { recursive: true });
    writeFileSync(STATUS_PATH, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  } catch {}
}

/** Persist last successful join so reboot/self-heal does not need the control plane. */
export function saveTailscaleTransportConfig(input = {}) {
  const normalized = normalizeTailscaleTransportInput(input);
  mkdirSync(RUNTIME_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    `${JSON.stringify({
      authKey: normalized.authKey,
      hostname: normalized.hostname || '',
      tags: normalized.tags || '',
      updatedAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  return normalized;
}

export function loadTailscaleTransportConfig() {
  try {
    if (!existsSync(CONFIG_PATH)) return null;
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    if (!isValidTailscaleAuthKey(raw?.authKey)) return null;
    return {
      authKey: String(raw.authKey).trim(),
      hostname: cleanHostname(raw.hostname || ''),
      tags: cleanTags(raw.tags || ''),
    };
  } catch {
    return null;
  }
}

export function readTailscaleTransportStatus() {
  const binary = tailscaleBinary();
  if (!binary) {
    return {
      installed: false,
      ready: false,
      ipv4: null,
      backendState: 'not_installed',
      configSaved: Boolean(loadTailscaleTransportConfig()),
    };
  }

  let details = {};
  try {
    details = JSON.parse(execFileSync(binary, ['status', '--json'], {
      timeout: 5000,
      encoding: 'utf8',
    }));
  } catch {}

  let ipv4 = null;
  try {
    ipv4 = execFileSync(binary, ['ip', '-4'], {
      timeout: 5000,
      encoding: 'utf8',
    }).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  } catch {}

  const backendState = String(details.BackendState || details.backendState || '').trim() || 'unknown';
  return {
    installed: true,
    ready: Boolean(ipv4) && backendState.toLowerCase() === 'running',
    ipv4,
    backendState,
    hostname: details.Self?.HostName || details.Self?.DNSName || null,
    configSaved: Boolean(loadTailscaleTransportConfig()),
  };
}

export async function configureTailscaleTransport(body = {}) {
  const input = normalizeTailscaleTransportInput(body);
  let binary = tailscaleBinary();

  if (!binary) {
    await runProcess('/bin/sh', ['-c', 'curl -fsSL https://tailscale.com/install.sh | sh'], {
      timeoutMs: 180000,
    });
    binary = tailscaleBinary();
  }
  if (!binary) throw new Error('Tailscale installed, but its CLI is unavailable.');

  await runProcess('systemctl', ['enable', '--now', 'tailscaled'], { timeoutMs: 30000 });
  const args = [
    'up',
    '--reset',
    `--auth-key=${input.authKey}`,
    '--accept-routes=false',
    '--ssh=false',
  ];
  if (input.hostname) args.push(`--hostname=${input.hostname}`);
  if (input.tags) args.push(`--advertise-tags=${input.tags}`);
  await runProcess(binary, args, { timeoutMs: 120000 });

  // Persist for automatic rejoin after reboot without another user paste.
  try {
    saveTailscaleTransportConfig(input);
  } catch (error) {
    console.warn(`[tailscale] Could not persist join config: ${error.message}`);
  }

  const status = readTailscaleTransportStatus();
  writeStatus({ enabled: true, ...status, updatedAt: new Date().toISOString() });
  if (!status.ready) {
    throw new Error(`Tailscale joined, but is not ready (state: ${status.backendState}).`);
  }
  return status;
}

/**
 * Self-heal: if already on the tailnet, no-op. Otherwise rejoin using the
 * request body key or the last successfully stored key on this VPS.
 */
export async function ensureTailscaleTransport(body = {}) {
  const current = readTailscaleTransportStatus();
  if (current.ready) {
    return { ok: true, ...current, ensured: true, action: 'already_ready' };
  }

  let input = null;
  const bodyKey = String(body?.authKey || '').trim();
  if (bodyKey) {
    input = normalizeTailscaleTransportInput(body);
  } else {
    input = loadTailscaleTransportConfig();
  }

  if (!input?.authKey) {
    return {
      ok: true,
      ...current,
      ensured: false,
      action: 'missing_auth_key',
      error: 'No Tailscale auth key is stored on this VPS yet. Connect once from Trooper Network settings.',
    };
  }

  const status = await configureTailscaleTransport(input);
  return { ok: true, ...status, ensured: true, action: 'joined' };
}

let ensureLoopStarted = false;

/** Background rejoin after reboot / accidental logout. Safe to call multiple times. */
export function startTailscaleTransportSelfHeal({ intervalMs = 5 * 60 * 1000, initialDelayMs = 20_000 } = {}) {
  if (ensureLoopStarted) return;
  ensureLoopStarted = true;

  const tick = async (reason) => {
    try {
      const result = await ensureTailscaleTransport({});
      if (result.action === 'joined') {
        console.log(`[tailscale] Self-heal rejoined tailnet (${reason}); ipv4=${result.ipv4 || 'n/a'}`);
      }
    } catch (error) {
      console.warn(`[tailscale] Self-heal skipped (${reason}): ${error.message}`);
    }
  };

  setTimeout(() => { tick('startup'); }, Math.max(0, initialDelayMs));
  setInterval(() => { tick('interval'); }, Math.max(60_000, intervalMs)).unref?.();
}
