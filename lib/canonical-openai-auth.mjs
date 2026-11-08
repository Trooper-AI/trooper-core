import { createHash } from 'node:crypto';

function profileIdentity(profile) {
  return String(profile?.accountId || profile?.email || '').trim().toLowerCase();
}

function safeSuffix(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'default';
}

function canonicalProfileId(legacyId, profile, profiles) {
  const suffix = safeSuffix(String(legacyId || '').replace(/^(?:openai-codex|openai):/i, '').replace(/^codex-/i, ''));
  const base = `openai:codex-${suffix}`;
  const existing = profiles[base];
  const identity = profileIdentity(profile);
  if (!existing || (identity && existing.type === 'oauth'
      && String(existing.provider || '').toLowerCase() === 'openai'
      && profileIdentity(existing) === identity)) return base;
  const collisionKey = identity || legacyId;
  const hash = createHash('sha256').update(collisionKey).digest('hex').slice(0, 10);
  return `${base}-${hash}`;
}

/**
 * Copy legacy OpenAI Codex OAuth profiles into OpenClaw's canonical `openai`
 * namespace. Keep the original profile and any `openai:default` API key intact.
 */
export function addCanonicalOpenAiOAuthProfiles(authDoc = {}) {
  const current = authDoc && typeof authDoc === 'object' && !Array.isArray(authDoc) ? authDoc : {};
  const profiles = current.profiles && typeof current.profiles === 'object' && !Array.isArray(current.profiles)
    ? { ...current.profiles }
    : {};
  const lastGood = current.lastGood && typeof current.lastGood === 'object' && !Array.isArray(current.lastGood)
    ? { ...current.lastGood }
    : {};
  const legacy = Object.entries(profiles).filter(([id, profile]) =>
    /^(?:openai-codex|openai):/i.test(id)
    && !/^openai:codex-/i.test(id)
    && profile && typeof profile === 'object'
    && profile.type === 'oauth'
    && ['openai', 'openai-codex'].includes(String(profile.provider || '').toLowerCase())
    && Boolean(profile.access || profile.refresh || profile.oauthRef),
  );
  if (!legacy.length) return { authDoc: current, changed: false, migrated: [] };

  const migrated = [];
  for (const [legacyId, profile] of legacy) {
    const id = canonicalProfileId(legacyId, profile, profiles);
    if (!profiles[id]) {
      profiles[id] = { ...profile, provider: 'openai' };
      migrated.push({ from: legacyId, to: id });
    }
    if (lastGood.openai === legacyId || lastGood['openai-codex'] === legacyId) {
      lastGood.openai = id;
    }
  }
  delete lastGood['openai-codex'];

  const active = profiles[lastGood.openai];
  const activeIsOpenAiOAuth = active?.type === 'oauth'
    && String(active.provider || '').toLowerCase() === 'openai'
    && Boolean(active.access || active.refresh || active.oauthRef);
  if (!activeIsOpenAiOAuth) {
    const selectedLegacyId = [lastGood['openai-codex'], lastGood.openai]
      .find((id) => legacy.some(([legacyId]) => legacyId === id))
      || legacy[0][0];
    const selected = legacy.find(([legacyId]) => legacyId === selectedLegacyId);
    if (selected) lastGood.openai = canonicalProfileId(selected[0], selected[1], profiles);
  }

  const changed = migrated.length > 0 || JSON.stringify(lastGood) !== JSON.stringify(current.lastGood || {});
  return {
    authDoc: changed ? { ...current, version: current.version || 1, profiles, lastGood } : current,
    changed,
    migrated,
  };
}
