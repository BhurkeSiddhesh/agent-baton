import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Directory that contains `src/` and `templates/`. Works in this repo and in a vendored copy at
 * `.baton/runtime/` because it is derived from this file's own location (src/lib/paths.js).
 */
export function packageRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function templatesDir() {
  return path.join(packageRoot(), 'templates');
}

/** Version from the package.json next to src/ ('0.0.0' when absent or unreadable). */
export function packageVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(packageRoot(), 'package.json'), 'utf8')).version;
    return typeof v === 'string' ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
