import { createHash } from 'crypto';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function nowMs() {
  return Date.now();
}

function clampLimit(value, fallback = DEFAULT_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

function safeJsonParse(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function json(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

function stableId(...parts) {
  return createHash('sha256').update(parts.map((part) => String(part ?? '')).join('\0')).digest('hex').slice(0, 32);
}

function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function rowToSource(row) {
  return {
    id: row.id,
    displayName: row.display_name,
    provider: row.provider,
    kind: row.kind || 'native',
    status: row.status || 'idle',
    aiAccess: row.ai_access || 'enabled',
    entryCount: Number(row.entry_count) || 0,
    lastSyncAt: row.last_sync_at || null,
    lastError: row.last_error || null,
    metadata: safeJsonParse(row.metadata, {}),
    privacy: safeJsonParse(row.privacy, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEntry(row) {
  return {
    id: row.id,
    sourceId: row.source_id,
    externalId: row.external_id,
    type: row.type || 'record',
    title: row.title,
    summary: row.summary || '',
    content: row.content || '',
    uri: row.uri || null,
    url: row.url || null,
    timestamp: row.timestamp || null,
    sensitivity: row.sensitivity || 'source',
    metadata: safeJsonParse(row.metadata, {}),
    syncedAt: row.synced_at,
    updatedAt: row.updated_at,
  };
}

export function upsertMemorySource(sqlite, source = {}) {
  const id = String(source.id || '').trim();
  if (!id) throw new Error('source.id is required');
  const displayName = String(source.displayName || source.display_name || id).trim();
  const provider = String(source.provider || id).trim();
  const timestamp = nowMs();
  const existing = sqlite.prepare('SELECT id FROM memory_sources WHERE id = ?').get(id);
  const values = {
    id,
    display_name: displayName,
    provider,
    kind: source.kind || 'native',
    status: source.status || 'idle',
    ai_access: source.aiAccess || source.ai_access || 'enabled',
    entry_count: Number(source.entryCount ?? source.entry_count ?? 0) || 0,
    last_sync_at: source.lastSyncAt ?? source.last_sync_at ?? null,
    last_error: source.lastError ?? source.last_error ?? null,
    metadata: json(source.metadata, {}),
    privacy: json(source.privacy, {}),
    updated_at: timestamp,
  };

  if (existing) {
    sqlite.prepare(`
      UPDATE memory_sources
      SET display_name = @display_name,
          provider = @provider,
          kind = @kind,
          status = @status,
          ai_access = @ai_access,
          entry_count = @entry_count,
          last_sync_at = @last_sync_at,
          last_error = @last_error,
          metadata = @metadata,
          privacy = @privacy,
          updated_at = @updated_at
      WHERE id = @id
    `).run(values);
  } else {
    sqlite.prepare(`
      INSERT INTO memory_sources (
        id, display_name, provider, kind, status, ai_access, entry_count,
        last_sync_at, last_error, metadata, privacy, created_at, updated_at
      )
      VALUES (
        @id, @display_name, @provider, @kind, @status, @ai_access, @entry_count,
        @last_sync_at, @last_error, @metadata, @privacy, @updated_at, @updated_at
      )
    `).run(values);
  }

  return getMemorySource(sqlite, id);
}

export function getMemorySource(sqlite, id) {
  const row = sqlite.prepare('SELECT * FROM memory_sources WHERE id = ?').get(id);
  return row ? rowToSource(row) : null;
}

export function listMemorySources(sqlite) {
  return sqlite.prepare('SELECT * FROM memory_sources ORDER BY updated_at DESC, display_name ASC').all().map(rowToSource);
}

function refreshSourceCount(sqlite, sourceId, patch = {}) {
  const row = sqlite.prepare('SELECT COUNT(*) AS count, MAX(updated_at) AS newest FROM memory_entries WHERE source_id = ?').get(sourceId);
  sqlite.prepare(`
    UPDATE memory_sources
    SET entry_count = ?,
        last_sync_at = COALESCE(?, last_sync_at),
        status = COALESCE(?, status),
        last_error = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    Number(row?.count) || 0,
    patch.lastSyncAt ?? row?.newest ?? null,
    patch.status || null,
    patch.lastError ?? null,
    nowMs(),
    sourceId,
  );
}

export function upsertMemoryEntries(sqlite, sourceId, entries = []) {
  if (!sourceId) throw new Error('sourceId is required');
  if (!Array.isArray(entries)) throw new Error('entries must be an array');
  const timestamp = nowMs();

  const insertEntry = sqlite.prepare(`
    INSERT INTO memory_entries (
      id, source_id, external_id, type, title, summary, content,
      uri, url, timestamp, sensitivity, metadata, synced_at, updated_at
    )
    VALUES (
      @id, @source_id, @external_id, @type, @title, @summary, @content,
      @uri, @url, @timestamp, @sensitivity, @metadata, @synced_at, @updated_at
    )
    ON CONFLICT(source_id, external_id) DO UPDATE SET
      type = excluded.type,
      title = excluded.title,
      summary = excluded.summary,
      content = excluded.content,
      uri = excluded.uri,
      url = excluded.url,
      timestamp = excluded.timestamp,
      sensitivity = excluded.sensitivity,
      metadata = excluded.metadata,
      synced_at = excluded.synced_at,
      updated_at = excluded.updated_at
  `);
  const deleteFts = sqlite.prepare('DELETE FROM memory_entries_fts WHERE entry_id = ?');
  const insertFts = sqlite.prepare(`
    INSERT INTO memory_entries_fts(title, summary, content, source_id, entry_id)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = sqlite.transaction((items) => {
    let saved = 0;
    for (const entry of items) {
      const externalId = String(entry.externalId || entry.external_id || entry.id || entry.uri || entry.url || '').trim();
      const title = String(entry.title || '').trim();
      if (!externalId || !title) continue;
      const id = String(entry.id || stableId(sourceId, externalId)).trim();
      const row = {
        id,
        source_id: sourceId,
        external_id: externalId,
        type: entry.type || 'record',
        title,
        summary: entry.summary || entry.snippet || '',
        content: entry.content || entry.details || entry.body || '',
        uri: entry.uri || null,
        url: entry.url || null,
        timestamp: toEpochMs(entry.timestamp || entry.updatedAt || entry.updated_at || entry.createdAt || entry.created_at),
        sensitivity: entry.sensitivity || 'source',
        metadata: json(entry.metadata, {}),
        synced_at: timestamp,
        updated_at: timestamp,
      };
      insertEntry.run(row);
      deleteFts.run(id);
      insertFts.run(row.title, row.summary, row.content, sourceId, id);
      saved += 1;
    }
    refreshSourceCount(sqlite, sourceId, { status: 'synced', lastSyncAt: timestamp, lastError: null });
    return saved;
  });

  return { upserted: tx(entries), source: getMemorySource(sqlite, sourceId) };
}

export function listMemoryEntries(sqlite, sourceId, { limit = DEFAULT_LIMIT } = {}) {
  const rows = sqlite.prepare(`
    SELECT * FROM memory_entries
    WHERE source_id = ?
    ORDER BY COALESCE(timestamp, updated_at) DESC
    LIMIT ?
  `).all(sourceId, clampLimit(limit));
  return rows.map(rowToEntry);
}

export function searchMemoryEntries(sqlite, { query, sources = [], limit = DEFAULT_LIMIT } = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const sourceList = Array.isArray(sources) ? sources.filter(Boolean).map(String) : [];
  const params = [q];
  let sourceWhere = '';
  if (sourceList.length) {
    sourceWhere = `AND e.source_id IN (${sourceList.map(() => '?').join(', ')})`;
    params.push(...sourceList);
  }
  params.push(clampLimit(limit));

  const rows = sqlite.prepare(`
    SELECT e.*, snippet(memory_entries_fts, 2, '[', ']', '...', 24) AS snippet
    FROM memory_entries_fts
    JOIN memory_entries e ON e.id = memory_entries_fts.entry_id
    WHERE memory_entries_fts MATCH ?
    ${sourceWhere}
    ORDER BY bm25(memory_entries_fts)
    LIMIT ?
  `).all(...params);

  return rows.map((row) => ({
    ...rowToEntry(row),
    snippet: row.snippet || row.summary || row.content || '',
  }));
}

async function githubJson(path, { token, params = {} } = {}) {
  const qs = new URLSearchParams(params);
  const url = `https://api.github.com${path}${qs.size ? `?${qs}` : ''}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'trooper-bridge-memory-sync',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`github_${res.status}: ${body.slice(0, 240)}`);
  }
  return res.json();
}

export async function syncGitHubMemorySource(sqlite, {
  sourceId = 'github',
  repos = [],
  token = process.env.TROOPER_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '',
  pages = 1,
} = {}) {
  const repoList = Array.isArray(repos)
    ? repos.map((repo) => String(repo).trim()).filter(Boolean)
    : String(repos || '').split(',').map((repo) => repo.trim()).filter(Boolean);
  if (repoList.length === 0) throw new Error('At least one GitHub repo is required.');

  upsertMemorySource(sqlite, {
    id: sourceId,
    displayName: 'GitHub',
    provider: 'github',
    kind: 'native',
    status: 'syncing',
    metadata: { repos: repoList },
    privacy: {
      containsPrivateMessages: false,
      exportsSecrets: false,
      localOnlyScopes: ['configured GitHub repositories'],
    },
  });

  const entries = [];
  for (const repo of repoList) {
    for (let page = 1; page <= Math.max(1, Number(pages) || 1); page += 1) {
      const items = await githubJson(`/repos/${repo}/issues`, {
        token,
        params: { state: 'all', sort: 'updated', direction: 'desc', per_page: 100, page },
      });
      if (!Array.isArray(items) || items.length === 0) break;
      for (const item of items) {
        const type = item.pull_request ? 'pull_request' : 'issue';
        entries.push({
          externalId: `${repo}#${item.number}`,
          type,
          title: item.title || `${repo}#${item.number}`,
          summary: item.body || '',
          content: item.body || '',
          uri: `github://${repo}/${type}/${item.number}`,
          url: item.html_url,
          timestamp: item.updated_at || item.created_at,
          sensitivity: 'repository',
          metadata: {
            repo,
            number: item.number,
            state: item.state,
            author: item.user?.login || null,
          },
        });
      }
    }
  }

  const result = upsertMemoryEntries(sqlite, sourceId, entries);
  return {
    ok: true,
    source: result.source,
    synced: result.upserted,
  };
}

