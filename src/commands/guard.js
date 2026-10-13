import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BatonError, UsageError } from '../lib/errors.js';
import { ownedBy, isProtected, isCoordination, normPath } from '../lib/glob.js';
import { toPosix } from '../lib/util.js';

export const name = 'guard';
export const group = 'Execution';
export const summary = 'Tool-call hook: allow or deny an edit by the agent\'s packet ownership';
export const usage = 'baton guard [--agent <id>] [--hook claude|cursor|generic]   (tool-call JSON on stdin)';
export const description = [
  'Reads a tool-call JSON from stdin (tool_input.file_path | path | file), finds the agent\'s IN_PROGRESS packets and decides',
  'by config.guard.mode: off (always allow), warn (allow, print a warning), block (exit 2 with a message on stderr).',
  'Coordination paths and files owned by the agent\'s packets are always allowed; protected paths are never allowed in block mode.',
  'Paths are resolved (.., absolute, backslashes, symlinks) and compared case-insensitively. Paths outside the repository are not guarded.',
  'Unparsable input fails open with a warning.',
].join('\n');
export const options = {
  agent: { type: 'string', alias: 'a', description: 'acting agent id (or BATON_AGENT)' },
  hook: { type: 'string', description: 'payload/response dialect: claude | cursor | generic', default: 'generic' },
};

const PATH_KEYS = ['file_path', 'filePath', 'path', 'file', 'notebook_path', 'target_file'];

function readStdin(ctx) {
  if (typeof ctx.stdin === 'string') return ctx.stdin;
  if (typeof ctx.stdin === 'function') return String(ctx.stdin() || '');
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8').replace(/^﻿/, ''); } catch { return ''; }
}

/** Every path the tool call would touch. */
export function extractPaths(payload) {
  const out = [];
  const take = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const k of PATH_KEYS) if (typeof obj[k] === 'string' && obj[k]) out.push(obj[k]);
    if (Array.isArray(obj.files)) for (const f of obj.files) if (typeof f === 'string') out.push(f);
    if (Array.isArray(obj.edits)) for (const e of obj.edits) take(e);
  };
  take(payload?.tool_input);
  take(payload?.toolInput);
  take(payload);
  return [...new Set(out)];
}

/** realpath of the longest existing prefix plus the not-yet-existing rest. Returns null for a dangling symlink. */
function realish(abs) {
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...tail.reverse());
    } catch {
      try {
        if (fs.lstatSync(cur).isSymbolicLink()) return null; // link whose target is missing: where would a write land?
      } catch { /* does not exist */ }
      const up = path.dirname(cur);
      if (up === cur) return abs;
      tail.push(path.basename(cur));
      cur = up;
    }
  }
}

function relInside(base, target) {
  const r = path.relative(base, target);
  if (r === '..' || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) return null;
  return toPosix(r) || '.';
}

const LOCAL_HOSTS = () => new Set(['localhost', 'localhost.localdomain', '127.0.0.1', '::1', '[::1]', os.hostname().toLowerCase()]);

/**
 * `//localhost/C$/x`, `//?/C:/x` and friends name local drives through a UNC spelling that the lexical
 * repo check would call "outside". Map them back to a drive path; refuse spellings that cannot be mapped.
 * Genuinely remote UNC paths return {} (treated as outside the repo).
 */
export function windowsUncToDrive(p) {
  const m = /^\/\/([^/]+)\/([^/]+)(\/.*)?$/.exec(p);
  if (!m) return { deny: 'unrecognised UNC path' };
  const host = m[1].toLowerCase();
  const share = m[2];
  const rest = m[3] || '/';
  if (host === '?' || host === '.') {
    if (/^[a-z]:$/i.test(share)) return { path: `${share}${rest}` };
    return { deny: 'device or extended-length path form is not allowed' };
  }
  if (LOCAL_HOSTS().has(host)) {
    const d = /^([a-z])\$$/i.exec(share);
    if (d) return { path: `${d[1]}:${rest}` };
    return { deny: 'path uses a local network share, which cannot be mapped into the repository check' };
  }
  return {};
}

/**
 * Resolve a tool path to repo-relative posix paths.
 * @returns {{outside?: boolean, deny?: string, rels?: string[]}}
 */
export function resolveToolPath(root, raw, baseDir = root) {
  let p = String(raw);
  if (p.includes('\0')) return { deny: 'path contains a NUL byte' };
  p = p.replace(/\\/g, '/');
  if (process.platform === 'win32' && p.startsWith('//')) {
    const u = windowsUncToDrive(p);
    if (u.deny) return { deny: u.deny };
    if (u.path) p = u.path;
  }
  let abs = path.resolve(baseDir, p);
  if (process.platform === 'win32') {
    const { root: drive } = path.parse(abs);
    const segs = abs.slice(drive.length).split(/[\\/]/);
    if (segs.some((s) => s.includes(':'))) return { deny: 'path uses an NTFS alternate data stream' };
    // Windows ignores trailing dots and spaces ("export.js." is "export.js").
    abs = drive + segs.map((s) => s.replace(/[. ]+$/, '')).join(path.sep);
  }
  const realRoot = fs.realpathSync.native(root);
  const real = realish(abs);
  if (real === null) return { deny: 'path is a symlink with a missing target' };
  const lex = relInside(path.resolve(root), abs) ?? relInside(realRoot, abs);
  const rea = relInside(realRoot, real);
  if (lex === null && rea === null) return { outside: true };
  if (lex !== null && rea === null) return { deny: 'path resolves through a symlink to a location outside the repository' };
  return { rels: [...new Set([rea, lex].filter(Boolean))] };
}

const lower = (s) => s.toLowerCase();

function decide(rel, ctx) {
  const { config, agent, mine, plan } = ctx;
  const extra = config.protected?.globs || [];
  const posix = normPath(rel);
  if (isProtected(posix, extra) || isProtected(lower(posix), extra.map(lower))) return { allow: false, reason: 'protected path (secrets, credentials, databases, .git)' };
  if (isCoordination(lower(posix), (config.coordination || []).map(lower))) return { allow: true };
  if ((agent === config.orchestrator || agent === 'human') && ['.baton/plan.json', '.baton/config.json'].includes(lower(posix))) return { allow: true };
  if (!agent) return { allow: true }; // unidentified actor: only the protected-path rule above applies
  if (!mine.length) return { allow: false, reason: `${agent} has no IN_PROGRESS packet`, noPacket: true };
  const owned = mine.find((id) => ownedBy(lower(posix), plan.packets.find((p) => p.id === id).owns.map(lower)));
  if (owned) return { allow: true };
  const owner = plan.packets.find((p) => p.id !== mine[0] && ownedBy(lower(posix), p.owns.map(lower)));
  return { allow: false, reason: `not owned by ${mine.join(', ')}${owner ? ` (owned by ${owner.id})` : ''}` };
}

export async function run(ctx, args) {
  const hook = String(args.hook || 'generic');
  if (!['claude', 'cursor', 'generic'].includes(hook)) throw new UsageError('--hook must be claude, cursor or generic');
  const respond = (allow, message, mode) => {
    // Claude Code: exit 2 + stderr blocks. Cursor: JSON on stdout and exit 2 denies. Generic: exit 2 + stderr.
    const deny = !allow && mode === 'block';
    if (hook === 'cursor') {
      ctx.json({ permission: deny ? 'deny' : 'allow', user_message: message || undefined, agent_message: message || undefined });
    } else if (message) ctx.err(message);
    return deny ? 2 : 0;
  };

  let loaded;
  try { loaded = ctx.loadState(); } catch (e) {
    if (e instanceof BatonError && e.code === 'NOT_INIT') return respond(true);
    throw e;
  }
  const { config, plan, state } = loaded;
  const mode = config.guard?.mode || 'warn';
  if (mode === 'off') return respond(true);

  const raw = readStdin(ctx);
  let payload;
  try { payload = raw.trim() ? JSON.parse(raw) : null; } catch { payload = undefined; }
  if (payload === undefined) return respond(true, 'baton guard: stdin is not valid JSON; allowing (fail open)', 'warn');
  if (!payload) return respond(true);
  const paths = extractPaths(payload);
  if (!paths.length) return respond(true); // not a file tool (Bash, Read, ...)

  const agent = ctx.agent(args.agent, { required: false });
  const mine = agent ? plan.packets.filter((p) => state.packets[p.id].status === 'IN_PROGRESS' && state.packets[p.id].by === agent).map((p) => p.id) : [];
  const baseDir = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : ctx.cwd;
  const dctx = { config, plan, agent, mine };

  const violations = [];
  for (const raw1 of paths) {
    const r = resolveToolPath(ctx.root, raw1, baseDir);
    if (r.outside) continue;
    if (r.deny) { violations.push({ path: raw1, reason: r.deny, hard: true }); continue; }
    for (const rel of r.rels) {
      const d = decide(rel, dctx);
      if (!d.allow) { violations.push({ path: rel, reason: d.reason, noPacket: d.noPacket, hard: d.reason.startsWith('protected') }); break; }
    }
  }
  if (!violations.length) return respond(true);

  const v = violations[0];
  const guidance = v.noPacket
    ? `Run "baton begin <packet> --agent ${agent || '<id>'}" first.`
    : `Edit only files your packet owns. Need this one? baton bus post --from ${agent || '<id>'} --type REQUEST --text "need ${v.path}: <why>"`;
  const message = `baton guard: ${mode === 'block' ? 'blocked' : 'warning'}: ${agent || 'agent'} may not edit "${v.path}" (${v.reason}). ${guidance}`;
  // A warn-mode guard with no packet stays silent about ownership (but protected paths always speak).
  if (mode === 'warn' && v.noPacket) return respond(true);
  return respond(false, message, mode);
}
