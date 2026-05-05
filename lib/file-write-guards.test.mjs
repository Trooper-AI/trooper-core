import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { writeJsonFileIfChanged, writeTextFileIfChanged } from './file-write-guards.mjs';

test('writeTextFileIfChanged does not touch files when content is unchanged', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-write-guard-'));
  const file = path.join(dir, 'AGENTS.md');
  const first = writeTextFileIfChanged(file, '# Agents\n');
  const mtime = statSync(file).mtimeMs;

  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = writeTextFileIfChanged(file, '# Agents\n');

  assert.equal(first.written, true);
  assert.equal(second.unchanged, true);
  assert.equal(readFileSync(file, 'utf8'), '# Agents\n');
  assert.equal(statSync(file).mtimeMs, mtime);
});

test('writeJsonFileIfChanged serializes stable pretty JSON', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bridge-json-guard-'));
  const file = path.join(dir, 'openclaw.json');
  const result = writeJsonFileIfChanged(file, { channels: { telegram: { mode: 'polling' } } });

  assert.equal(result.written, true);
  assert.equal(readFileSync(file, 'utf8'), '{\n  "channels": {\n    "telegram": {\n      "mode": "polling"\n    }\n  }\n}');
});
