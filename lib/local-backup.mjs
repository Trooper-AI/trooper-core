import path from 'path';

export const LOCAL_BACKUP_DIR = '/opt/openclaw-backup';

const MANAGED_BACKUP_NAME = /^(?:backup|pre-purge)-\d+\.tar\.gz$/;

export function isManagedBackupName(value) {
  return typeof value === 'string' && MANAGED_BACKUP_NAME.test(value);
}

export function resolveManagedBackupPath(value, backupDir = LOCAL_BACKUP_DIR) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new Error('A valid managed backup path is required');
  }

  const backupRoot = path.resolve(backupDir);
  const candidate = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(backupRoot, value);

  if (path.dirname(candidate) !== backupRoot || !isManagedBackupName(path.basename(candidate))) {
    throw new Error('Backup path must reference a managed archive in the backup directory');
  }

  return candidate;
}

export function validateTarEntryNames(listing) {
  const entries = String(listing || '')
    .split(/\r?\n/)
    .map(entry => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) {
    throw new Error('Backup archive is empty');
  }

  for (const entry of entries) {
    const normalized = entry.replace(/^\.\/+/, '');
    const segments = normalized.split('/');
    if (
      !normalized
      || path.posix.isAbsolute(normalized)
      || segments.includes('..')
      || normalized.includes('\0')
    ) {
      throw new Error(`Backup archive contains an unsafe path: ${entry}`);
    }
  }

  return entries;
}
