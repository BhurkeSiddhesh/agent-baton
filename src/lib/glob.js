import { toPosix } from './util.js';

/** Paths any packet may touch; never counted as scope violations. */
export const BUILTIN_COORDINATION = ['.baton/ledger/', '.baton/state/', '.baton/views/', '.baton/archives/'];

/** Paths reserved exclusively for orchestrator authority / administration. */
export const BUILTIN_ORCHESTRATOR_ONLY = [
  '.baton/config.json',
  'AGENTS.md',
  'docs/GOVERNANCE.md',
];

/** Read-only project governance and configuration paths. */
export const BUILTIN_READ_ONLY = [
  ...BUILTIN_ORCHESTRATOR_ONLY,
];

const PROTECTED_NAME_GLOBS = [
  '.env', '.env.*',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.crt', '*.cer', '*.der', '*.p8',
  'id_rsa*', 'id_ed25519*', 'id_ecdsa*', 'id_dsa*',
  '*credentials*.json', 'client_secret*.json', 'token*.json',
  '*azure*token*', '*azuretokens*', 'accesstokens.json',
  '*.sqlite', '*.sqlite3', '*.db', '*.duckdb', '*.kdbx',
];
const PROTECTED_DIRS = ['.git', 'secrets', '.aws', '.azure', '.gcloud'];

const PROTECTED_PATH_PATTERNS = [
  '**/.aws/credentials*',
  '**/aws/credentials*',
  '**/.aws/config*',
  '**/aws/config*',
  '**/gcloud/credentials.db*',
  '**/.config/gcloud/**',
  '**/.azure/**',
  '**/azure/tokens*',
];

/** Windows and macOS file systems are case-insensitive by default: there `Src/A.js` and `src/a.js` are one file. */
export const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

export function normPath(p) {
  // NFC: macOS hands back NFD names.
  return toPosix(p).normalize('NFC').replace(/^(\.\/)+/, '');
}

/** Directory prefix `dir/` is sugar for `dir/**`. */
function normPattern(pattern) {
  let p = normPath(pattern);
  if (p.endsWith('/')) p += '**';
  return p;
}

const reCache = new Map();

function toRegExp(pattern, ci = CASE_INSENSITIVE_FS) {
  const key = (ci ? 'i:' : 's:') + pattern;
  let re = reCache.get(key);
  if (re) return re;
  let out = '^';
  for (let i = 0; i < pattern.length;) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i += 2;
        if (pattern[i] === '/') { out += '(?:.*/)?'; i++; } else out += '.*';
      } else { out += '[^/]*'; i++; }
    } else if (c === '?') { out += '[^/]'; i++; } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  re = new RegExp(out + '$', ci ? 'i' : '');
  reCache.set(key, re);
  return re;
}

/**
 * Does `pattern` match `path`? `*` and `?` stay inside one segment, `**` crosses segments,
 * a trailing `/` means "everything under this directory", anything else is literal.
 */
export function matchPath(pattern, path, ci = CASE_INSENSITIVE_FS) {
  const pat = normPattern(pattern);
  if (!pat) return false;
  return toRegExp(pat, ci).test(normPath(path));
}

function segOverlap(a, b) {
  const memo = new Map();
  const f = (i, j) => {
    const key = i * 4096 + j;
    if (memo.has(key)) return memo.get(key);
    let r;
    if (i === a.length && j === b.length) r = true;
    else if (a[i] === '*') r = f(i + 1, j) || (j < b.length && f(i, j + 1));
    else if (b[j] === '*') r = f(i, j + 1) || (i < a.length && f(i + 1, j));
    else if (i === a.length || j === b.length) r = false;
    else r = (a[i] === b[j] || a[i] === '?' || b[j] === '?') && f(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return f(0, 0);
}

/** Could some path match both patterns? Conservative (never says no when a shared path exists). */
export function patternsOverlap(a, b, ci = CASE_INSENSITIVE_FS) {
  if (ci) { a = String(a).toLowerCase(); b = String(b).toLowerCase(); }
  const A = normPattern(a).split('/').map((s) => (s === '**' ? s : s.replace(/\*{2,}/g, '*')));
  const B = normPattern(b).split('/').map((s) => (s === '**' ? s : s.replace(/\*{2,}/g, '*')));
  const memo = new Map();
  const g = (i, j) => {
    const key = i * 4096 + j;
    if (memo.has(key)) return memo.get(key);
    let r;
    if (i === A.length && j === B.length) r = true;
    else if (A[i] === '**') r = g(i + 1, j) || (j < B.length && g(i, j + 1));
    else if (B[j] === '**') r = g(i, j + 1) || (i < A.length && g(i + 1, j));
    else if (i === A.length || j === B.length) r = false;
    else r = segOverlap(A[i], B[j]) && g(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return g(0, 0);
}

/** Is `path` covered by any pattern in `owns`? */
export function ownedBy(path, owns) {
  return (owns || []).some((o) => matchPath(o, path));
}

/**
 * Built-in protected paths plus `extraGlobs` (patterns without `/` match the file name at any depth).
 * Always case-insensitive: over-protecting `.ENV` on Linux is harmless, under-protecting it on Windows is not.
 */
export function isProtected(path, extraGlobs = []) {
  if (typeof path !== 'string') return false;
  const posix = normPath(path);
  const segs = posix.split('/').filter(Boolean);
  if (!segs.length) return false;
  const lowerSegs = segs.map((s) => s.toLowerCase());
  const lowerPosix = posix.toLowerCase();
  const name = segs[segs.length - 1];
  const lname = lowerSegs[lowerSegs.length - 1];

  if (Array.isArray(extraGlobs)) {
    for (const rawG of extraGlobs) {
      if (!rawG || typeof rawG !== 'string') continue;
      const g = normPath(rawG);
      const lowerG = g.toLowerCase();
      if (g.includes('/')) {
        if (matchPath(g, posix, true) || matchPath(lowerG, lowerPosix, true)) return true;
        if (g.endsWith('/**') && lowerPosix === g.slice(0, -3).toLowerCase()) return true;
        if (g.endsWith('/') && lowerPosix === g.slice(0, -1).toLowerCase()) return true;
        if (posix.endsWith('/**') && lowerG.startsWith(lowerPosix.slice(0, -3) + '/')) return true;
        if (posix.endsWith('/') && lowerG.startsWith(lowerPosix)) return true;
        if (patternsOverlap(posix, g, true)) return true;
      } else {
        if (matchPath(g, lname, true) || matchPath(lowerG, lname, true)) return true;
        if (matchPath(posix, g, true)) return true;
      }
    }
  }

  if (lowerSegs.some((s) => PROTECTED_DIRS.includes(s))) return true;
  if (lname === '.env.example') return false;
  if (PROTECTED_PATH_PATTERNS.some((p) => matchPath(p, posix, true) || matchPath(p, lowerPosix, true))) return true;
  return PROTECTED_NAME_GLOBS.some((g) => matchPath(g, lname, true) || matchPath(g, name, true));
}

/** Built-in coordination paths plus `extra` (config.coordination). */
export function isCoordination(path, extra = []) {
  return ownedBy(path, [...BUILTIN_COORDINATION, ...extra]);
}

/** Check if path is reserved for orchestrator authority. */
export function isOrchestratorOnly(path, extra = []) {
  if (typeof path !== 'string') return false;
  const posix = normPath(path);
  const lowerPosix = posix.toLowerCase();
  const allGlobs = [...BUILTIN_ORCHESTRATOR_ONLY, ...(extra || [])];
  return allGlobs.some((g) => {
    if (typeof g !== 'string') return false;
    const ng = normPath(g);
    return matchPath(ng, posix, true) || matchPath(ng.toLowerCase(), lowerPosix, true);
  });
}

/** Check if path is read-only. */
export function isReadOnly(path, extra = []) {
  if (typeof path !== 'string') return false;
  const posix = normPath(path);
  const lowerPosix = posix.toLowerCase();
  const allGlobs = [...BUILTIN_READ_ONLY, ...(extra || [])];
  return allGlobs.some((g) => {
    if (typeof g !== 'string') return false;
    const ng = normPath(g);
    return matchPath(ng, posix, true) || matchPath(ng.toLowerCase(), lowerPosix, true);
  });
}
