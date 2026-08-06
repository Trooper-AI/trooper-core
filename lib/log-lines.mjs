/** Shared journal/docker log line helpers for bridge admin endpoints. */

export function parseLogLineTimestampMs(line) {
  const raw = String(line || '');
  const iso = raw.match(
    /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/,
  );
  if (iso) {
    const ms = Date.parse(iso[1]);
    if (Number.isFinite(ms)) return ms;
  }
  const spaceDate = raw.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (spaceDate) {
    const ms = Date.parse(`${spaceDate[1]}T${spaceDate[2]}Z`);
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}

export function isJournalBootMarker(line) {
  return /^-- Boot [0-9a-fA-F]+ --$/.test(String(line || '').trim());
}

export function resolveLogLineTimestamps(lines = []) {
  const list = Array.isArray(lines) ? lines : [];
  const explicit = list.map((line) => parseLogLineTimestampMs(line));
  const ts = explicit.slice();

  let lastValid = NaN;
  for (let i = 0; i < ts.length; i += 1) {
    if (Number.isFinite(explicit[i])) lastValid = explicit[i];
    else if (Number.isFinite(lastValid)) ts[i] = lastValid;
  }

  lastValid = NaN;
  for (let i = ts.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(explicit[i])) lastValid = explicit[i];
    else if (!Number.isFinite(ts[i]) && Number.isFinite(lastValid)) ts[i] = lastValid;
  }

  return ts;
}

export function annotateUntimestampedLogLines(lines = []) {
  const list = (Array.isArray(lines) ? lines : []).map((line) => String(line || ''));
  const explicit = list.map((line) => parseLogLineTimestampMs(line));
  return list.map((line, index) => {
    if (Number.isFinite(explicit[index])) return line;
    if (!isJournalBootMarker(line)) return line;
    let nextTs = NaN;
    for (let j = index + 1; j < list.length; j += 1) {
      if (Number.isFinite(explicit[j])) {
        nextTs = explicit[j];
        break;
      }
    }
    let prevTs = NaN;
    for (let j = index - 1; j >= 0; j -= 1) {
      if (Number.isFinite(explicit[j])) {
        prevTs = explicit[j];
        break;
      }
    }
    const stamp = Number.isFinite(nextTs) ? nextTs : prevTs;
    if (!Number.isFinite(stamp)) return line;
    return `${new Date(stamp).toISOString()} ${line.trim()}`;
  });
}

export function dedupeJournalBootMarkers(lines = []) {
  const out = [];
  let lastBoot = null;
  for (const line of (Array.isArray(lines) ? lines : [])) {
    const trimmed = String(line || '').trim();
    const bootId = trimmed.match(/-- Boot ([0-9a-fA-F]+) --/)?.[1] || null;
    if (bootId && bootId === lastBoot) continue;
    lastBoot = bootId || null;
    out.push(String(line || ''));
  }
  return out;
}

export function sortLogLinesChronologically(lines = []) {
  const prepared = annotateUntimestampedLogLines(dedupeJournalBootMarkers(lines));
  return prepared
    .map((line, index) => ({ line: String(line || ''), index, ts: parseLogLineTimestampMs(line) }))
    .sort((a, b) => {
      const aValid = Number.isFinite(a.ts);
      const bValid = Number.isFinite(b.ts);
      if (aValid && bValid && a.ts !== b.ts) return a.ts - b.ts;
      if (aValid && !bValid) return -1;
      if (!aValid && bValid) return 1;
      return a.index - b.index;
    })
    .map((entry) => entry.line);
}
