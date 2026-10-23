import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BatonError, UsageError } from '../lib/errors.js';
import { ownedBy, isProtected, isCoordination, isOrchestratorOnly, isReadOnly, normPath } from '../lib/glob.js';
import { toPosix } from '../lib/util.js';
import { PERMISSION_PROFILES, hasRole } from '../lib/config.js';

export const name = 'guard';
export const group = 'Execution';
export const summary = 'Tool-call hook: allow or deny an edit by the agent\'s packet ownership';
export const usage = 'baton guard [--agent <id>] [--hook claude|cursor|generic]   (tool-call JSON on stdin)';
export const description = [
  'Reads a tool-call JSON from stdin (tool_input.file_path | path | file), finds the agent\'s IN_PROGRESS packets and decides',
  'by config.guard.mode: off (always allow), warn (allow, print a warning), block (exit 2 with a message on stderr).',
  'Coordination paths and files owned by the agent\'s packets are always allowed; protected paths are never allowed in block mode.',
  'Paths are resolved (.., absolute, backslashes, symlinks) and compared case-insensitively. Paths outside the repository are not guarded.',
  'In block mode, unparsable JSON and unknown payload shapes fail closed (exit 2). In warn mode, they fail open with a warning on stderr.',
].join('\n');
export const options = {
  agent: { type: 'string', alias: 'a', description: 'acting agent id (or BATON_AGENT)' },
  hook: { type: 'string', description: 'payload/response dialect: claude | cursor | generic', default: 'generic' },
};

const PATH_KEYS = [
  'file_path', 'filePath', 'path', 'file', 'notebook_path', 'target_file',
  'source_file', 'dest_file', 'destination', 'target', 'filename', 'fileName',
  'old_path', 'new_path', 'uri', 'url',
];

const KNOWN_NON_FILE_TOOLS = new Set([
  'read', 'read_file', 'view', 'grep', 'glob', 'search', 'list_dir', 'find', 'cat',
  'head', 'tail', 'list', 'ls', 'browser', 'web_search',
  'bash', 'terminal', 'sh', 'exec', 'powershell', 'cmd', 'zsh', 'run_command',
  'curl', 'fetch', 'download', 'wget', 'network',
]);

const KNOWN_WRITE_TOOLS = new Set([
  'edit', 'write', 'create', 'delete', 'remove', 'patch', 'update', 'append',
  'rename', 'move', 'replace', 'str_replace_editor', 'notebookeditcell', 'multiedit',
]);

function readStdin(ctx) {
  if (typeof ctx.stdin === 'string') return ctx.stdin;
  if (typeof ctx.stdin === 'function') return String(ctx.stdin() || '');
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, ''); } catch { return ''; }
}

function cleanPathString(s) {
  if (typeof s !== 'string' || !s) return null;
  if (s.startsWith('file://')) {
    try {
      return fileURLToPath(s);
    } catch {
      return s.replace(/^file:\/\//, '');
    }
  }
  return s;
}

/** Every path the tool call would touch. */
export function extractPaths(payload) {
  const out = [];
  const seen = new Set();

  const take = (obj, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 8 || seen.has(obj)) return;
    seen.add(obj);

    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (typeof item === 'string' && item) {
          const cleaned = cleanPathString(item);
          if (cleaned) out.push(cleaned);
        } else if (item && typeof item === 'object') {
          take(item, depth + 1);
        }
      }
      return;
    }

    for (const k of PATH_KEYS) {
      const v = obj[k];
      if (typeof v === 'string' && v) {
        const cleaned = cleanPathString(v);
        if (cleaned) out.push(cleaned);
      } else if (v && typeof v === 'object') {
        take(v, depth + 1);
      }
    }

    if (Array.isArray(obj.files)) take(obj.files, depth + 1);
    if (Array.isArray(obj.edits)) take(obj.edits, depth + 1);
    if (Array.isArray(obj.changes)) take(obj.changes, depth + 1);
    if (Array.isArray(obj.documents)) take(obj.documents, depth + 1);
    if (Array.isArray(obj.items)) take(obj.items, depth + 1);
  };

  take(payload?.tool_input);
  take(payload?.toolInput);
  take(payload);

  return [...new Set(out.filter(Boolean))];
}

/** Check if payload is an unknown or corrupt shape that cannot be verified */
export function isUnknownPayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const toolName = String(payload.tool_name || payload.toolName || payload.tool || '').toLowerCase();

  // Known non-file execution or read tools are not unknown shapes
  if (KNOWN_NON_FILE_TOOLS.has(toolName)) return false;
  if (typeof payload.command === 'string' || typeof payload.tool_input?.command === 'string') return false;
  if (typeof payload.query === 'string' || typeof payload.tool_input?.query === 'string') return false;

  const paths = extractPaths(payload);
  if (paths.length > 0) return false;

  // If it's a known write tool without paths, it's definitely unparseable write tool
  if (KNOWN_WRITE_TOOLS.has(toolName) || Array.from(KNOWN_WRITE_TOOLS).some((w) => toolName.includes(w))) {
    return true;
  }

  // Any non-empty object with tool metadata or unrecognized fields that touches no known paths
  const keys = Object.keys(payload);
  if (keys.length === 0) return false;
  return Boolean(payload.tool_name || payload.toolName || payload.tool || payload.tool_input || payload.toolInput);
}

/** Safely decode URI-encoded or double-encoded path segments */
export function safeDecode(raw) {
  let cur = String(raw);
  for (let round = 0; round < 4; round++) {
    if (!cur.includes('%')) break;
    let next;
    try {
      next = decodeURIComponent(cur);
    } catch {
      next = cur.replace(/%([0-9a-fA-F]{2})/g, (_m, hex) => {
        const code = parseInt(hex, 16);
        return String.fromCharCode(code);
      });
    }
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

/** Strip extended-length prefix \\?\ or \\.\ from Windows paths */
export function stripExtendedPrefix(p) {
  if (typeof p !== 'string') return p;
  if (/^\\\\[?.]\\UNC\\/i.test(p) || /^\/\/[?.]\/UNC\//i.test(p)) {
    return '//' + p.slice(8).replace(/\\/g, '/');
  }
  if (/^(\\\\[?.]\\|\/\/[?.]\/)[a-zA-Z]:/.test(p)) {
    return p.slice(4);
  }
  return p;
}

/** realpath of the longest existing prefix plus the not-yet-existing rest. Returns null for a dangling symlink. */
function realish(abs) {
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const realCur = stripExtendedPrefix(fs.realpathSync.native(cur));
      return path.join(realCur, ...tail.reverse());
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
  const normBase = stripExtendedPrefix(base);
  const normTarget = stripExtendedPrefix(target);
  const r = path.relative(normBase, normTarget);
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
  let p = safeDecode(raw);
  if (p.includes('\0')) return { deny: 'path contains a NUL byte' };
  p = p.replace(/\\/g, '/');
  if (p.startsWith('//')) {
    const u = windowsUncToDrive(p);
    if (u.deny) return { deny: u.deny };
    if (u.path) p = u.path;
  }
  let abs = path.resolve(baseDir, p);
  const { root: drive } = path.parse(abs);
  const segs = abs.slice(drive.length).split(/[\\/]/);
  if (segs.some((s) => s.includes(':'))) return { deny: 'path uses an NTFS alternate data stream' };
  if (segs.some((s) => /^[. ]{3,}$/.test(s))) return { deny: 'path contains invalid dot/space sequence' };
  abs = drive + segs.map((s) => (/^[. ]+$/.test(s) ? s : s.replace(/[. ]+$/, ''))).join(path.sep);

  const realRoot = stripExtendedPrefix(fs.realpathSync.native(root));
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
  const orchExtra = config.protected?.orchestratorOnly || [];
  const readOnlyExtra = config.protected?.readOnly || [];
  const posix = normPath(rel);
  if (isProtected(posix, extra) || isProtected(lower(posix), extra.map(lower))) {
    const isOrch = agent === config.orchestrator || agent === 'human' || hasRole(config, agent, 'orchestrator');
    const myPackets = (mine || []).map((id) => plan?.packets?.find((p) => p.id === id)).filter(Boolean);
    const hasAuthorizedException = isOrch && myPackets.some((p) => p.allow_protected && p.description && String(p.description).trim());
    if (!hasAuthorizedException) {
      return { allow: false, reason: 'protected path (secrets, credentials, databases, .git)', hard: true };
    }
  }
  if (isCoordination(lower(posix), (config.coordination || []).map(lower))) return { allow: true };
  if ((agent === config.orchestrator || agent === 'human') && ['.baton/plan.json', '.baton/config.json'].includes(lower(posix))) return { allow: true };

  if (isOrchestratorOnly(posix, orchExtra)) {
    const isOrch = agent === config.orchestrator || agent === 'human' || hasRole(config, agent, 'orchestrator');
    if (!isOrch) {
      return { allow: false, reason: `orchestrator-only path (${posix}) requires orchestrator role` };
    }
  }

  if (isReadOnly(posix, readOnlyExtra) && !isOrchestratorOnly(posix, orchExtra)) {
    return { allow: false, reason: `read-only path (${posix}) cannot be modified` };
  }

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
  let mode = 'warn';
  const respond = (allow, message, modeOverride) => {
    // Claude Code: exit 2 + stderr blocks. Cursor: JSON on stdout and exit 2 denies. Generic: exit 2 + stderr.
    const effectiveMode = modeOverride || mode;
    const deny = !allow && effectiveMode === 'block';
    if (hook === 'cursor') {
      ctx.json({ permission: deny ? 'deny' : 'allow', user_message: message || undefined, agent_message: message || undefined });
    } else if (message) ctx.err(message);
    return deny ? 2 : 0;
  };

  let loaded;
  try { loaded = ctx.loadState(); } catch (e) {
    if (e instanceof BatonError && e.code === 'NOT_INIT') return respond(true);
    if (e instanceof BatonError && e.code === 'BAD_CONFIG' && e.message.includes('unsupported isolation')) {
      return respond(false, `baton guard: blocked: unsupported enforcement requested. ${e.message}`, 'block');
    }
    throw e;
  }
  const { config, plan, state } = loaded;
  mode = config.guard?.mode || 'warn';
  if (mode === 'off') return respond(true);

  const failClosed = config.guard?.failClosed !== undefined
    ? Boolean(config.guard.failClosed)
    : (mode === 'block');

  const raw = readStdin(ctx);
  let payload;
  try { payload = raw.trim() ? JSON.parse(raw) : null; } catch { payload = undefined; }
  if (payload === undefined) {
    if (failClosed) {
      return respond(false, 'baton guard: blocked: stdin is not valid JSON (failing closed in block mode)', 'block');
    }
    return respond(true, 'baton guard: warning: stdin is not valid JSON; allowing (fail open)', 'warn');
  }
  if (!payload) return respond(true);

  if (isUnknownPayload(payload)) {
    if (failClosed) {
      return respond(false, 'baton guard: blocked: unknown payload shape; unable to determine file safety (failing closed in block mode)', 'block');
    }
    return respond(true, 'baton guard: warning: unknown payload shape; allowing (fail open)', 'warn');
  }

  const agent = ctx.agent(args.agent, { required: false });
  const mine = agent ? plan.packets.filter((p) => state.packets[p.id]?.status === 'IN_PROGRESS' && state.packets[p.id]?.by === agent).map((p) => p.id) : [];

  // Resolve active execution permission profile
  let profileName = 'workspace-write';
  if (mine.length) {
    profileName = plan.packets.find((p) => p.id === mine[0])?.profile || 'workspace-write';
  } else if (agent === config.orchestrator || agent === 'human') {
    profileName = 'privileged';
  } else if (agent) {
    const ag = config.agents?.find((a) => a.id === agent);
    profileName = ag?.profile || (ag?.roles?.includes('worker') ? 'workspace-write' : 'review-only');
  }
  const profiles = { ...PERMISSION_PROFILES, ...(config.security?.profiles || {}) };
  const profile = profiles[profileName] || PERMISSION_PROFILES['workspace-write'];

  // Explicit refusal for unsupported kernel/network sandbox enforcement
  if (profile.isolation === 'kernel' || profile.isolation === 'network' || profile.sandbox === 'os') {
    return respond(false, `baton guard: blocked: unsupported enforcement requested by profile "${profileName}". Baton operates in user space and does not provide OS kernel or network sandboxing.`, 'block');
  }

  // Check execution capabilities (shell and network tools)
  const toolName = String(payload.tool_name || payload.toolName || payload.tool || '').toLowerCase();
  const isShellTool = ['bash', 'terminal', 'sh', 'exec', 'powershell', 'cmd'].includes(toolName)
    || typeof payload.tool_input?.command === 'string'
    || typeof payload.command === 'string';
  if (isShellTool && profile.allowShell === false) {
    return respond(false, `baton guard: blocked: ${agent || 'agent'} operates under "${profileName}" profile which forbids shell execution.`, mode);
  }

  const isNetworkTool = ['curl', 'fetch', 'download', 'wget', 'network'].includes(toolName)
    || payload.network === true
    || payload.tool_input?.network === true;
  if (isNetworkTool && profile.allowNetwork === false) {
    return respond(false, `baton guard: blocked: ${agent || 'agent'} operates under "${profileName}" profile which forbids network access.`, mode);
  }

  const paths = extractPaths(payload);
  if (!paths.length) return respond(true); // not a file tool (Bash, Read, ...)

  if (profile.allowWrite === false) {
    return respond(false, `baton guard: blocked: ${agent || 'agent'} operates under "${profileName}" profile which forbids workspace file modifications.`, mode);
  }

  const baseDir = typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd) ? payload.cwd : ctx.cwd;
  const dctx = { config, plan, agent, mine };

  const violations = [];
  for (const raw1 of paths) {
    const r = resolveToolPath(ctx.root, raw1, baseDir);
    if (r.outside) continue;
    if (r.deny) { violations.push({ path: raw1, reason: r.deny, hard: true }); continue; }
    for (const rel of r.rels) {
      const d = decide(rel, dctx);
      if (!d.allow) { violations.push({ path: rel, reason: d.reason, noPacket: d.noPacket, hard: d.hard || d.reason.startsWith('protected') }); break; }
    }
  }
  if (!violations.length) return respond(true);

  // Prioritize hard violations (protected paths or traversal errors)
  const v = violations.find((item) => item.hard) || violations[0];
  let guidance;
  if (v.hard || v.reason.startsWith('protected')) {
    guidance = 'Protected paths (secrets, credentials, databases, .git) cannot be edited.';
  } else if (v.noPacket) {
    guidance = `Run "baton begin <packet> --agent ${agent || '<id>'}" first.`;
  } else {
    guidance = `Edit only files your packet owns. Need this one? baton bus post --from ${agent || '<id>'} --type REQUEST --text "need ${v.path}: <why>"`;
  }
  const message = `baton guard: ${mode === 'block' ? 'blocked' : 'warning'}: ${agent || 'agent'} may not edit "${v.path}" (${v.reason}). ${guidance}`;
  // A warn-mode guard with no packet stays silent about ownership (but protected paths always speak).
  if (mode === 'warn' && v.noPacket && !v.hard) return respond(true);
  return respond(false, message, mode);
}
