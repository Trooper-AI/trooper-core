import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_SKILL_PACK,
  OPENCLAW_RUNTIME_SKILL_PACK,
  OPENCLAW_RUNTIME_SKILLS,
  PROVISIONED_DEFAULT_SKILL_PACK,
  ensureVolumeSkillPacks,
  installSkillFilesToVolume,
  listVolumeSkills,
  normalizeSkillSlug,
  removeSkillFromVolume,
  resolveWorkspaceSkillRoots,
} from './default-skill-pack.mjs';

test('default skill pack exposes the expected curated Trooper skills', () => {
  assert.equal(DEFAULT_SKILL_PACK.length, 5);

  const slugs = DEFAULT_SKILL_PACK.map((skill) => skill.slug);
  assert.deepEqual(slugs, [
    'trooper-structured-research-export',
    'trooper-data-table-ops',
    'trooper-task-decomposition-handoff',
    'trooper-artifact-output-formatting',
    'trooper-verification-qa',
  ]);
});

test('default skills are authored as real SKILL.md documents with activation metadata', () => {
  DEFAULT_SKILL_PACK.forEach((skill) => {
    assert.match(skill.content, /^---\n[\s\S]+?\n---\n#\s+/);
    assert.match(skill.content, /\bsummary:\s*.+/);
    assert.match(skill.content, /\bwhenToUse:\s*.+/);
    assert.match(skill.content, /## Deliverable Rules/);
  });
});

test('provisioned skill pack includes OpenClaw runtime skills', () => {
  assert.equal(OPENCLAW_RUNTIME_SKILLS.length, 57);
  assert.equal(OPENCLAW_RUNTIME_SKILL_PACK.length, OPENCLAW_RUNTIME_SKILLS.length);
  assert.equal(PROVISIONED_DEFAULT_SKILL_PACK.length, DEFAULT_SKILL_PACK.length + OPENCLAW_RUNTIME_SKILL_PACK.length);

  const slugs = new Set(PROVISIONED_DEFAULT_SKILL_PACK.map((skill) => skill.slug));
  ['xurl', 'discord', 'slack', 'github', 'gog', 'coding-agent', 'summarize', 'wacli', 'weather', 'taskflow', 'canvas', 'notion'].forEach((slug) => {
    assert.equal(slugs.has(slug), true, `${slug} should be provisioned`);
  });
});

test('OpenClaw runtime skills are authored as executable CLI guidance', () => {
  OPENCLAW_RUNTIME_SKILL_PACK.forEach((skill) => {
    assert.match(skill.content, /^---\n[\s\S]+?\n---\n#\s+/);
    assert.match(skill.content, /\ballowedTools:\n\s+- exec/);
    assert.match(skill.content, /Preferred CLI\/tool:/);
    assert.match(skill.content, /Report missing credentials or unavailable binaries clearly/);
  });
});

test('volume skill helpers install list and remove without host packages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trooper-skills-'));
  assert.equal(normalizeSkillSlug('My Skill!!'), 'my-skill');

  const installed = installSkillFilesToVolume(root, {
    slug: 'demo-skill',
    content: '# Demo\n\nHello volume skill.\n',
    files: { 'notes.txt': 'note' },
  });
  assert.equal(installed.ok, true);
  assert.ok(fs.existsSync(path.join(root, 'demo-skill', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(root, 'demo-skill', 'notes.txt')));

  const listed = listVolumeSkills(root);
  assert.equal(listed.some((s) => s.slug === 'demo-skill'), true);

  const removed = removeSkillFromVolume(root, 'demo-skill');
  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.equal(listVolumeSkills(root).length, 0);

  fs.rmSync(root, { recursive: true, force: true });
});

test('ensureVolumeSkillPacks writes default pack under workspace and agents roots', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trooper-slot-skills-'));
  const workspaceRoot = path.join(base, 'workspace');
  const configRoot = path.join(base, 'config');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(configRoot, { recursive: true });

  const roots = resolveWorkspaceSkillRoots({ workspaceRoot, configRoot });
  assert.equal(roots.length, 2);

  const results = ensureVolumeSkillPacks({ workspaceRoot, configRoot });
  assert.equal(results.length, 2);
  for (const result of results) {
    assert.ok(result.skillCount >= DEFAULT_SKILL_PACK.length);
    assert.ok(fs.existsSync(path.join(result.root, 'trooper-verification-qa', 'SKILL.md')));
  }

  fs.rmSync(base, { recursive: true, force: true });
});
