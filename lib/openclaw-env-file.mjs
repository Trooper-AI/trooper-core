import path from 'path';

// Dedicated VPS installs keep provider env in /opt/openclaw/.env. App-pool
// images have no /opt/openclaw directory and cannot create one, so the same
// write has to land beside the live OpenClaw config instead of aborting the
// channel update.
export function openClawEnvFileCandidates({
  primary = '/opt/openclaw/.env',
  configPath = '',
} = {}) {
  const candidates = [primary];
  const configDir = configPath ? path.dirname(configPath) : '';
  const fallback = configDir ? path.join(configDir, '.env') : '';
  if (fallback && fallback !== primary && !candidates.includes(fallback)) {
    candidates.push(fallback);
  }
  return candidates;
}

export function writeOpenClawEnvFile(content, {
  write,
  candidates = ['/opt/openclaw/.env'],
  warn = () => {},
} = {}) {
  let lastError = null;
  for (const target of candidates) {
    try {
      write(target, content);
      return { written: true, path: target };
    } catch (error) {
      lastError = error;
    }
  }
  warn(`[bridge] Provider env file was not written: ${lastError?.message || 'unknown error'}`);
  return { written: false, path: null };
}
