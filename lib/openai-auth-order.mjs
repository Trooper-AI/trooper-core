function normalizeOpenAiProfileId(value = '') {
  const id = String(value || '').trim();
  const legacy = id.match(/^openai-codex:(.+)$/i);
  return legacy ? `openai:codex-${legacy[1]}` : id;
}

function profileKind(profileId, profile) {
  if (!/^openai:/i.test(normalizeOpenAiProfileId(profileId))) return '';
  if (!['openai', 'openai-codex'].includes(String(profile?.provider || '').toLowerCase())) return '';
  const type = String(profile?.type || '').toLowerCase();
  if (type === 'oauth' && (profile?.access || profile?.refresh || profile?.oauthRef)) return 'oauth';
  if (type === 'api_key' && profile?.key) return 'api_key';
  return '';
}

/**
 * Keep OpenClaw's explicit OpenAI route aligned with the account Trooper marks
 * as active. A stale explicit order prevents OpenClaw from considering newly
 * saved profiles, so append every usable OAuth account after the active one.
 * API-key profiles are kept only when the existing route explicitly included
 * them (or the user explicitly selected one), avoiding an unexpected switch
 * from subscription quota to paid API billing.
 */
export function buildOpenAiAuthOrder(authDoc = {}, currentOrder = []) {
  const profiles = authDoc?.profiles && typeof authDoc.profiles === 'object'
    ? authDoc.profiles
    : {};
  const entries = Object.entries(profiles);
  const hasCanonicalCounterpart = (profileId, profile) => {
    if (!/^openai-codex:/i.test(profileId)) return false;
    const identity = String(profile?.accountId || profile?.email || '').trim().toLowerCase();
    if (!identity) return false;
    return entries.some(([candidateId, candidate]) =>
      /^openai:codex-/i.test(candidateId)
      && String(candidate?.accountId || candidate?.email || '').trim().toLowerCase() === identity
      && profileKind(candidateId, candidate) === 'oauth',
    );
  };
  const kinds = new Map(entries
    .filter(([id, profile]) => !hasCanonicalCounterpart(id, profile))
    .map(([id, profile]) => [id, profileKind(id, profile)])
    .filter(([, kind]) => kind));
  const oauthIds = [...kinds].filter(([, kind]) => kind === 'oauth').map(([id]) => id);
  const apiKeyIds = [...kinds].filter(([, kind]) => kind === 'api_key').map(([id]) => id);
  const resolveProfileId = (value) => {
    const raw = String(value || '').trim();
    if (kinds.has(raw)) return raw;
    const canonical = normalizeOpenAiProfileId(raw);
    return kinds.has(canonical) ? canonical : '';
  };
  const configured = Array.isArray(currentOrder) ? currentOrder : [];
  const usableConfigured = configured.map(resolveProfileId).filter(Boolean);
  const preferredRaw = authDoc?.lastGood?.openai || authDoc?.lastGood?.['openai-codex'] || '';
  const selected = resolveProfileId(preferredRaw);

  const oauthOrder = [
    ...(selected && kinds.get(selected) === 'oauth' ? [selected] : []),
    ...usableConfigured.filter((id) => kinds.get(id) === 'oauth' && id !== selected),
    ...oauthIds.filter((id) => id !== selected && !usableConfigured.includes(id)),
  ];
  const apiKeyOrder = [
    ...(selected && kinds.get(selected) === 'api_key' ? [selected] : []),
    ...usableConfigured.filter((id) => kinds.get(id) === 'api_key' && id !== selected),
  ];
  return [...new Set([...oauthOrder, ...apiKeyOrder])];
}
