import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const script = readFileSync(new URL('../setup-local-windows-host.ps1', import.meta.url), 'utf8');

test('Windows local installer keeps one persistent workspace binding per computer', () => {
  assert.match(script, /\$InstallationIdFile = Join-Path \$TrooperParentDir "install-id"/);
  assert.match(script, /\$ExistingOrgId -ne "local-unpaired"/);
  assert.match(script, /Trooper will not replace it with workspace \$OrgId/);
  assert.match(script, /\[guid\]::NewGuid\(\)/);
  assert.match(script, /TROOPER_INSTALLATION_ID = \$HostDeviceId/);
  assert.ok(script.indexOf('$ExistingOrgId =') < script.indexOf('Ensure-Command "git"'));
});
