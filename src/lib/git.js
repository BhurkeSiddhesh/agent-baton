import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { toPosix, slugify } from './util.js';

/**
 * Run git without a shell. Returns {status, stdout, stderr} or null when git cannot be spawned.
 * @param {string} root working directory
 * @param {string[]} args
 * @param {{input?: string}} [opts]
 */
export function git(root, args, { input } = {}) {
  try {
    const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: root, input, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error) return null;
    return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
  } catch {
    return null;
  }
}

/** Trimmed stdout on success, otherwise null. */
export function gitOut(root, args) {
  const r = git(root, args);
  return r && r.status === 0 ? r.stdout.trim() : null;
}

export function gitOk(root, args) {
  const r = git(root, args);
  return !!r && r.status === 0;
}

export function isGit(root) {
  return gitOut(root, ['rev-parse', '--git-dir']) !== null;
}

/** Top level of the work tree containing cwd (posix, absolute) or null. */
export function repoRoot(cwd) {
  const out = gitOut(cwd, ['rev-parse', '--show-toplevel']);
  return out ? toPosix(path.resolve(out)) : null;
}

const commonCache = new Map();

// Cheap filesystem test that avoids spawning git (slow on Windows) for plain folders.
function hasDotGitAbove(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return true;
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/** Absolute git common dir (shared by every worktree of a clone) or null. Only positive answers are cached. */
export function commonDir(root) {
  if (commonCache.has(root)) return commonCache.get(root);
  let dir = null;
  try {
    const dotgit = path.join(root, '.git');
    if (fs.statSync(dotgit).isDirectory()) dir = dotgit;
  } catch { /* not a plain repo root */ }
  if (!dir && hasDotGitAbove(root)) {
    const out = gitOut(root, ['rev-parse', '--git-common-dir']);
    if (out) dir = path.resolve(root, out);
  }
  if (dir) commonCache.set(root, dir);
  return dir;
}

export function currentBranch(root) {
  return gitOut(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
}

export function headCommit(root) {
  if (!hasDotGitAbove(root)) return null;
  return gitOut(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
}

/**
 * Uncommitted changes (staged, unstaged, untracked), ignoring root-relative paths in `exclude`.
 * Returns false outside git.
 */
export function isDirty(root, { exclude = [] } = {}) {
  if (!hasDotGitAbove(root)) return false;
  const specs = exclude.map((p) => `:(exclude)${toPosix(p).replace(/\/+$/, '')}`);
  const out = gitOut(root, ['status', '--porcelain', '--untracked-files=all', '--', '.', ...specs]);
  return !!out;
}

/**
 * Files changed since `base`: committed (base..HEAD) + staged + unstaged + untracked. Sorted, posix.
 * `base` may be null (then only the working tree changes). Returns [] outside git.
 */
export function changedFiles(root, base) {
  const set = new Set();
  const collect = (args) => {
    const r = git(root, args);
    if (r && r.status === 0) for (const f of r.stdout.split('\0')) if (f) set.add(toPosix(f));
  };
  if (base) collect(['diff', '--name-only', '-z', '--no-renames', `${base}..HEAD`]);
  collect(['diff', '--name-only', '-z', '--no-renames', '--cached']);
  collect(['diff', '--name-only', '-z', '--no-renames']);
  collect(['ls-files', '--others', '--exclude-standard', '-z']);
  return [...set].sort();
}

/** First existing branch of [preferred, main, master], else null. */
export function mainRef(root, preferred) {
  for (const b of [preferred, 'main', 'master']) {
    if (b && gitOk(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`])) return b;
  }
  return null;
}

/** `git worktree list --porcelain` parsed: [{path, head, branch, bare}]. */
export function listWorktrees(root) {
  const out = gitOut(root, ['worktree', 'list', '--porcelain']);
  if (!out) return [];
  const rows = [];
  for (const block of out.split(/\r?\n\r?\n/)) {
    const row = { path: null, head: null, branch: null, bare: false };
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) row.path = toPosix(line.slice(9));
      else if (line.startsWith('HEAD ')) row.head = line.slice(5);
      else if (line.startsWith('branch ')) row.branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (line === 'bare') row.bare = true;
    }
    if (row.path) rows.push(row);
  }
  return rows;
}

/**
 * Creates a permanent rescue git ref preserving any uncommitted changes (index + worktree)
 * without clearing or altering the working directory.
 * @param {string} root Git repository or worktree root
 * @param {string} [label] Label used for commit message and ref naming
 * @returns {{preserved: boolean, ref: string|null, sha: string|null, dirty: boolean}}
 */
export function preserveGitWork(root, label = 'rescue') {
  if (!isGit(root)) return { preserved: false, ref: null, sha: null, dirty: false };
  const dirty = isDirty(root, { exclude: ['.baton/ledger', '.baton/state', '.baton/views'] });
  if (!dirty) {
    return { preserved: false, ref: null, sha: headCommit(root), dirty: false };
  }
  const cleanLabel = slugify(label);
  // Stage all changes (excluding .baton) so untracked files are captured by stash create
  git(root, ['add', '-A', '--', ':!.baton']);
  const out = gitOut(root, ['stash', 'create', `baton rescue: ${label}`]);
  // Reset index to HEAD so working copy remains uncommitted and untouched
  git(root, ['reset', 'HEAD', '--quiet']);
  if (!out) {
    return { preserved: false, ref: null, sha: null, dirty: true };
  }
  const sha = out.trim();
  const ref = `refs/baton/rescue/${cleanLabel}`;
  git(root, ['update-ref', ref, sha]);
  return { preserved: true, ref, sha, dirty: true };
}
