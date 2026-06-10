import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isManagedBackupName,
  resolveManagedBackupPath,
  validateTarEntryNames,
} from './local-backup.mjs';

test('managed backup names are narrowly scoped', () => {
  assert.equal(isManagedBackupName('backup-1710000000000.tar.gz'), true);
  assert.equal(isManagedBackupName('pre-purge-1710000000000.tar.gz'), true);
  assert.equal(isManagedBackupName('backup-latest.tar.gz'), false);
  assert.equal(isManagedBackupName('backup-1.tar'), false);
});

test('managed backup paths cannot escape the backup directory', () => {
  const root = '/tmp/trooper-backups';
  assert.equal(
    resolveManagedBackupPath('backup-1710000000000.tar.gz', root),
    '/tmp/trooper-backups/backup-1710000000000.tar.gz',
  );
  assert.equal(
    resolveManagedBackupPath('/tmp/trooper-backups/pre-purge-1710000000000.tar.gz', root),
    '/tmp/trooper-backups/pre-purge-1710000000000.tar.gz',
  );
  assert.throws(
    () => resolveManagedBackupPath('../backup-1710000000000.tar.gz', root),
    /managed archive/,
  );
  assert.throws(
    () => resolveManagedBackupPath('/tmp/backup-1710000000000.tar.gz', root),
    /managed archive/,
  );
  assert.throws(
    () => resolveManagedBackupPath('anything.tar.gz; touch /tmp/pwned', root),
    /managed archive/,
  );
});

test('tar entry validation rejects absolute and traversal paths', () => {
  assert.deepEqual(
    validateTarEntryNames('opt/openclaw-data/bridge.db\nhome/node/.openclaw/workspace/\n'),
    ['opt/openclaw-data/bridge.db', 'home/node/.openclaw/workspace/'],
  );
  assert.throws(() => validateTarEntryNames('/etc/shadow\n'), /unsafe path/);
  assert.throws(() => validateTarEntryNames('opt/openclaw/../../etc/shadow\n'), /unsafe path/);
  assert.throws(() => validateTarEntryNames(''), /empty/);
});
