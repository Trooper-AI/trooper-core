const CONTENT_TYPES = new Map(Object.entries({
  avif: 'image/avif',
  bmp: 'image/bmp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
  aac: 'audio/aac',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  weba: 'audio/webm',
  avi: 'video/x-msvideo',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  ogv: 'video/ogg',
  webm: 'video/webm',
  csv: 'text/csv; charset=utf-8',
  css: 'text/css; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  jsx: 'text/javascript; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  sh: 'text/x-shellscript; charset=utf-8',
  ts: 'text/typescript; charset=utf-8',
  tsx: 'text/typescript; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
  yml: 'application/yaml; charset=utf-8',
  json: 'application/json; charset=utf-8',
  jsonl: 'application/x-ndjson; charset=utf-8',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '7z': 'application/x-7z-compressed',
  gz: 'application/gzip',
  rar: 'application/vnd.rar',
  tar: 'application/x-tar',
  tgz: 'application/gzip',
  zip: 'application/zip',
}));

export function getFileContentType(filePath = '') {
  const clean = String(filePath || '').split(/[?#]/, 1)[0];
  const ext = clean.includes('.') ? clean.split('.').pop().toLowerCase() : '';
  return CONTENT_TYPES.get(ext) || 'application/octet-stream';
}

export function buildWeakFileEtag(size, modifiedMs = 0) {
  const normalizedSize = Math.max(0, Number(size) || 0);
  const normalizedModified = Math.max(0, Math.floor(Number(modifiedMs) || 0));
  return `W/\"${normalizedSize.toString(16)}-${normalizedModified.toString(16)}\"`;
}

export function ifRangeAllowsRange(ifRange, { etag, modifiedMs = 0 } = {}) {
  const value = String(ifRange || '').trim();
  if (!value) return true;
  if (value.startsWith('"') || value.startsWith('W/')) return value === etag;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  return Math.floor(Number(modifiedMs || 0) / 1000) <= Math.floor(timestamp / 1000);
}
