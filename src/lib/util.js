import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BatonError } from './errors.js';

/** Current time. `BATON_NOW` (ISO string) overrides it for tests and replays. */
export function utcnow() {
  const o = process.env.BATON_NOW;
  if (o) {
    const d = new Date(o);
    if (Number.isNaN(d.getTime())) throw new BatonError(`BATON_NOW is not a valid ISO date: ${o}`);
    return d;
  }
  return new Date();
}

/** `YYYY-MM-DDTHH:MM:SSZ` (UTC, no milliseconds). */
export function stamp(d = utcnow()) {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function addHours(d, hours) {
  return new Date(d.getTime() + hours * 3600 * 1000);
}

/** Parse an ISO string into a Date, or null when invalid/empty. */
export function parseTime(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

export function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) if (v[k] !== undefined) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}

/** Deterministic JSON: object keys sorted recursively, no whitespace, undefined dropped. */
export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

/** Throw unless `file` resolves to a path strictly inside `dir` (defence against ids like "a/../../x"). */
export function assertInside(dir, file) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  if (!rel || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new BatonError(`refusing a path outside the state directory: ${toPosix(file)}`, { code: 'UNSAFE_PATH' });
  }
  return file;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Read and parse JSON. With a fallback, a missing file returns it; a corrupt file always throws BatonError. */
export function readJson(file, ...fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' && fallback.length) return fallback[0];
    throw new BatonError(`cannot read ${toPosix(file)}: ${e.message}`, { code: 'IO' });
  }
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new BatonError(`invalid JSON in ${toPosix(file)}: ${e.message}`, { code: 'BAD_JSON' });
  }
}

/** Blocking sleep (used by the lock). */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Write via temp file + rename. Retries the rename on transient Windows errors. */
export function writeFileAtomic(file, text) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 40 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) {
        try { fs.unlinkSync(tmp); } catch { /* ignore */ }
        throw e;
      }
      sleepSync(10);
    }
  }
}

/** 2-space JSON with a trailing newline, key order as given. */
export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export const DEFAULT_SKIP_DIRS = ['.git', 'node_modules', '__pycache__', '.pytest_cache', '.venv', 'venv', '.ruff_cache', '.mypy_cache', '.tox'];
export const DEFAULT_SKIP_PATHS = ['.baton/state', '.baton/ledger', '.baton/views'];

/**
 * List files under root as sorted posix relative paths. Symlinks are skipped.
 * skipDirs: directory names skipped at any depth. skipPaths: root-relative prefixes skipped.
 * @param {string} root
 * include: optional predicate on the relative path, checked before any stat or read.
 * @param {{skipDirs?: string[], skipPaths?: string[], maxSize?: number|null, include?: ((rel: string) => boolean)|null}} [opts]
 */
export function walk(root, { skipDirs = DEFAULT_SKIP_DIRS, skipPaths = DEFAULT_SKIP_PATHS, maxSize = 5_000_000, include = null } = {}) {
  const dirs = new Set(skipDirs);
  const prefixes = skipPaths.map((p) => toPosix(p).replace(/\/+$/, ''));
  const out = [];
  const visit = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (prefixes.includes(r)) continue;
      if (e.isDirectory()) {
        if (!dirs.has(e.name)) visit(path.join(abs, e.name), r);
      } else if (e.isFile()) {
        if (include && !include(r)) continue;
        if (maxSize != null) {
          try { if (fs.statSync(path.join(abs, e.name)).size > maxSize) continue; } catch { continue; }
        }
        out.push(r);
      }
    }
  };
  visit(root, '');
  return out.sort();
}

/** Map of relative path -> sha1 of content for every walked file. */
export function hashTree(root, opts) {
  const map = {};
  for (const rel of walk(root, opts)) {
    try { map[rel] = crypto.createHash('sha1').update(fs.readFileSync(path.join(root, rel))).digest('hex'); } catch { /* vanished */ }
  }
  return map;
}

/** sha256 over the whole working tree (excluding .git, baton state/ledger/views, dependency dirs). */
export function fingerprint(root, opts) {
  return sha256(canonicalJson(hashTree(root, opts)));
}

export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'item';
}

/** Flatten `a,b` / ['a,b','c'] / undefined into a trimmed string array. */
export function list(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : [value];
  return arr.flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean);
}

/** Decode bytes leniently (BOMs, UTF-16 without BOM, binary). */
export function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2, 2 + ((buf.length - 2) & ~1))).swap16().toString('utf16le');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf.includes(0)) return buf.toString('utf16le') + '\n' + buf.toString('latin1');
  return buf.toString('utf8');
}

/** Whole days from `now` to the date part of `iso` (negative when past); null if unparsable. */
export function daysUntil(iso, now = utcnow()) {
  const d = parseTime(iso);
  if (!d) return null;
  const a = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const b = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((a - b) / 86400000);
}

export function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/** Check if a process ID is currently running on the system. */
export function isProcessAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
