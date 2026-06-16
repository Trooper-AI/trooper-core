import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { migrate } from '../db/migrate.mjs';
import {
  listMemoryEntries,
  listMemorySources,
  searchMemoryEntries,
  syncGitHubMemorySource,
  upsertMemoryEntries,
  upsertMemorySource,
} from './memory-sources.mjs';

function makeDb() {
  const sqlite = new Database(':memory:');
  migrate(sqlite);
  return sqlite;
}

test('memory sources expose synced native entries as searchable memory', () => {
  const sqlite = makeDb();
  const source = upsertMemorySource(sqlite, {
    id: 'files',
    displayName: 'Local Files',
    provider: 'files',
    privacy: { containsPrivateMessages: false },
  });

  assert.equal(source.id, 'files');
  assert.equal(source.entryCount, 0);

  const result = upsertMemoryEntries(sqlite, 'files', [
    {
      externalId: 'notes/trooper.md',
      type: 'file',
      title: 'Trooper Bridge Notes',
      summary: 'Private connector memory layer',
      content: 'Trooper Bridge keeps synced data in user-owned memory.',
      uri: 'file:///notes/trooper.md',
      sensitivity: 'local',
    },
  ]);

  assert.equal(result.upserted, 1);
  assert.equal(result.source.entryCount, 1);

  const sources = listMemorySources(sqlite);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].displayName, 'Local Files');

  const entries = listMemoryEntries(sqlite, 'files');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, 'Trooper Bridge Notes');

  const search = searchMemoryEntries(sqlite, { query: 'private connector', sources: ['files'] });
  assert.equal(search.length, 1);
  assert.equal(search[0].sourceId, 'files');
  assert.equal(search[0].title, 'Trooper Bridge Notes');
});

test('GitHub native sync stores issues and pull requests as memory entries', async () => {
  const sqlite = makeDb();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/repos\/openclaw\/crawlbar\/issues/);
    return {
      ok: true,
      async json() {
        return [
          {
            number: 13,
            title: 'refactor: split CrawlBar surfaces',
            body: 'Preserve menu bar launch contract.',
            state: 'closed',
            html_url: 'https://github.com/openclaw/crawlbar/pull/13',
            updated_at: '2026-06-09T04:39:03Z',
            created_at: '2026-06-08T01:00:00Z',
            user: { login: 'joshp123' },
            pull_request: {},
          },
        ];
      },
    };
  };

  try {
    const result = await syncGitHubMemorySource(sqlite, {
      repos: ['openclaw/crawlbar'],
      pages: 1,
    });

    assert.equal(result.ok, true);
    assert.equal(result.synced, 1);
    assert.equal(result.source.id, 'github');
    assert.equal(result.source.entryCount, 1);

    const entries = listMemoryEntries(sqlite, 'github');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].type, 'pull_request');
    assert.equal(entries[0].metadata.repo, 'openclaw/crawlbar');

    const search = searchMemoryEntries(sqlite, { query: 'menu bar', sources: ['github'] });
    assert.equal(search.length, 1);
    assert.equal(search[0].url, 'https://github.com/openclaw/crawlbar/pull/13');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
