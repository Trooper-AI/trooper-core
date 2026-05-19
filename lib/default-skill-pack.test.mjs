import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SKILL_PACK } from './default-skill-pack.mjs';

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
