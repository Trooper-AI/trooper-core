import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bridgeSource = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8');

test('runtime skill reads short-circuit to the persisted host copy', () => {
  const start = bridgeSource.indexOf('function readRuntimeSkillFiles(slug)');
  const end = bridgeSource.indexOf('\nfunction stripAnsi', start);
  const source = bridgeSource.slice(start, end);

  assert.ok(start >= 0 && end > start, 'readRuntimeSkillFiles source must be present');
  assert.ok(
    source.indexOf('readHostSkillFiles(alias)') < source.indexOf('readContainerSkillFiles(alias)'),
    'host reads must happen before the Docker fallback',
  );
  assert.doesNotMatch(source, /\[readHostSkillFiles\(alias\),\s*readContainerSkillFiles\(alias\)\]/);
});

test('installed skill inventory is cached and never scans container roots', () => {
  const start = bridgeSource.indexOf("app.get('/skills/installed'");
  const end = bridgeSource.indexOf('\n// ── Desktop API Proxy', start);
  const source = bridgeSource.slice(start, end);

  assert.ok(start >= 0 && end > start, 'installed-skills route source must be present');
  assert.match(source, /getCachedInstalledSkills\(\)/);
  assert.match(source, /cacheInstalledSkills\(/);
  assert.match(source, /readHostSkillMdEntry\(dir\)/);
  assert.doesNotMatch(source, /readRuntimeSkillFiles\(dir\)/);
  assert.doesNotMatch(source, /listContainerSkillAliases\(\)/);
});
