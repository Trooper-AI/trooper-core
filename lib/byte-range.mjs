/** Parse one RFC 7233 byte range. Multi-range responses are intentionally unsupported. */
export function parseSingleByteRange(value, size) {
  const total = Math.max(0, Number(size) || 0);
  const raw = String(value || '').trim();
  if (!raw || !total) return null;
  const match = raw.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match || (!match[1] && !match[2])) return { invalid: true };

  let start;
  let end;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, total - suffixLength);
    end = total - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : total - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= total) {
      return { invalid: true };
    }
    end = Math.min(end, total - 1);
  }
  return { start, end, length: end - start + 1 };
}
