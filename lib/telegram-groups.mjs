/**
 * Telegram group sessions the control plane should mirror as Trooper channels.
 * DMs and username-shaped keys stay out. The filter is pure.
 */

const TELEGRAM_GROUP_KEY_RE = /:telegram:group:(-?\d+)$/;

export function telegramGroupSessions(listResult) {
  const rows = Array.isArray(listResult?.sessions) ? listResult.sessions
    : Array.isArray(listResult?.rows) ? listResult.rows
      : Array.isArray(listResult) ? listResult : [];
  const groups = [];
  for (const row of rows) {
    const key = String(row?.key || row?.sessionKey || '').trim();
    const match = key.match(TELEGRAM_GROUP_KEY_RE);
    if (!match) continue;
    groups.push({
      key,
      chatId: match[1],
      status: String(row?.status || row?.state || '').toLowerCase(),
      ...(row?.updatedAt ? { updatedAt: row.updatedAt } : {}),
      ...(row?.displayName ? { displayName: String(row.displayName) } : {}),
    });
  }
  return groups;
}
