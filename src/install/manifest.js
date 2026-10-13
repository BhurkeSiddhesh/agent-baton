import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic, sha256 } from '../lib/util.js';

export const MANIFEST_VERSION = 1;
export const manifestPath = (root) => path.join(root, '.baton', 'manifest.json');

/** Hash that ignores CRLF vs LF for text (git autocrlf must not make a file look modified); binary is hashed raw. */
export function hashContent(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  if (buf.includes(0)) return sha256(buf);
  return sha256(Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8'));
}

export function emptyManifest() {
  return { version: MANIFEST_VERSION, baton: '0.0.0', files: {} };
}

/**
 * Entry shape: `{mode: 'file'|'block'|'merge-json'|'json-key'|'vendor', group, sha256?, managed?, style?, snippet?, key?, value?}`.
 * @returns {{version: number, baton: string, files: Record<string, any>}}
 */
export function loadManifest(root) {
  const m = readJson(manifestPath(root), null);
  if (!m || typeof m !== 'object' || typeof m.files !== 'object' || !m.files) return emptyManifest();
  // entries that could point outside the repository are ignored (reported through `unsafe`), never acted on
  const unsafe = [];
  const files = {};
  for (const [k, v] of Object.entries(m.files)) {
    const p = String(k).replaceAll('\\', '/').replace(/^\.\//, '');
    if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) unsafe.push(k);
    else files[k] = v;
  }
  return Object.defineProperty({ ...m, files }, 'unsafe', { value: unsafe, enumerable: false });
}

export function saveManifest(root, manifest) {
  const files = {};
  for (const k of Object.keys(manifest.files).sort()) files[k] = manifest.files[k];
  writeJsonAtomic(manifestPath(root), { version: MANIFEST_VERSION, baton: manifest.baton, files });
}

export function hashFileOnDisk(abs) {
  try { return hashContent(fs.readFileSync(abs)); } catch { return null; }
}
