import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';

const STATUS_PATH = '/var/lib/trooper-org-runtime/tailscale-status.json';
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

export function normalizeTailscaleTransportInput(body = {}) {
  const authKey = String(body.authKey || '').trim();
  if (!/^tskey-(?:auth-)?[A-Za-z0-9_-]{12,}$/.test(authKey)) {
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
    mkdirSync('/var/lib/trooper-org-runtime', { recursive: true });
    writeFileSync(STATUS_PATH, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  } catch {}
}

export function readTailscaleTransportStatus() {
  const binary = tailscaleBinary();
  if (!binary) {
    return { installed: false, ready: false, ipv4: null, backendState: 'not_installed' };
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

  const status = readTailscaleTransportStatus();
  writeStatus({ enabled: true, ...status, updatedAt: new Date().toISOString() });
  if (!status.ready) {
    throw new Error(`Tailscale joined, but is not ready (state: ${status.backendState}).`);
  }
  return status;
}
