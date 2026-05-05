import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

export function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

export function writeTextFileIfChanged(filePath, content, options = {}) {
  const next = String(content ?? '');
  let previous = null;
  if (existsSync(filePath)) {
    try {
      previous = readFileSync(filePath, options.encoding || 'utf8');
    } catch {
      previous = null;
    }
  }
  if (previous === next) {
    return { written: false, unchanged: true };
  }
  if (options.ensureDir !== false) {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }
  writeFileSync(filePath, next, options.encoding || 'utf8');
  return { written: true, unchanged: false };
}

export function writeJsonFileIfChanged(filePath, value, options = {}) {
  return writeTextFileIfChanged(filePath, stableJson(value), options);
}
