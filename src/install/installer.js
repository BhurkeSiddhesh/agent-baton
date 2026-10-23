import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { BatonError } from '../lib/errors.js';
import { render } from '../lib/template.js';
import { packageVersion, packageRoot } from '../lib/paths.js';
import { configPath, defaultConfig, validateConfig, AGENT_ID_RE } from '../lib/config.js';
import { readJson, toPosix, canonicalJson, writeFileAtomic, ensureDir } from '../lib/util.js';
import { appendEvent, readEvents } from '../lib/store.js';
import { ROLES, ROLE_TITLES, COMMANDS, CMD_TITLES, loadRegistry, loadCustomAdapters } from './registry.js';
import { detectStack, detectAgents, selectRoster } from './detect.js';
import { applyBlock, blockText, blockHash, extractBlock, removeBlock } from './managed-block.js';
import { loadManifest, saveManifest, hashContent, hashFileOnDisk } from './manifest.js';
import { mergeJson, unmergeJson, stringifyLike } from './hooks.js';
import { collectRuntime, shims, runningFromRuntime, readLicense, RUNTIME_COMMAND } from './vendor.js';
import { extraApplies, FALLBACK_HOOKS_SNIPPET, postprocess } from './ci.js';

export const SIDECAR_SUFFIX = '.baton-new';
const GITIGNORE_BODY = '.baton/state/\n.baton/views/';
const GITATTRIBUTES_BODY = '.baton/ledger/** -diff linguist-generated\n.baton/baton text eol=lf\n.baton/baton.cmd text eol=crlf';
const FALLBACK_STARTER_PLAN = { version: 1, goal: '', tracks: [], gates: [], milestones: [], packets: [] };
const FALLBACK_CUSTOM_BLOCK = 'This project coordinates AI agents with baton. Follow the protocol in AGENTS.md.\nStart every session with `{{cli}} check` and `{{cli}} next --agent {{agent.id}}`.';

/* ------------------------------------------------------------------ helpers */

/** Repo-relative posix path, rejecting anything that could leave the repo root. */
export function safeRel(rel) {
  const p = toPosix(rel).replace(/^\.\//, '');
  if (!p || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.split('/').includes('..')) {
    throw new BatonError(`refusing to write outside the repository: "${rel}"`, { code: 'UNSAFE_PATH' });
  }
  return p;
}

/**
 * Add `"sub": value` to the existing top-level object `top` by splicing text, so every other byte (number
 * formatting, big integers, key order, minified layout) is preserved. null when it cannot be done safely.
 */
function spliceKey(text, top, sub, value, expected) {
  const key = `"${top}"`;
  if (text.split(key).length !== 2) return null;
  const m = new RegExp(`${key}\\s*:\\s*\\{`).exec(text);
  if (!m) return null;
  const at = m.index + m[0].length;
  // find the closing brace of the object (string aware)
  let depth = 1;
  let end = -1;
  for (let i = at, inStr = false; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  const body = text.slice(at, end);
  const trimmed = body.replace(/\s+$/, '');
  const tail = body.slice(trimmed.length);
  const empty = !trimmed.trim();
  const entry = `${JSON.stringify(sub)}: ${JSON.stringify(value)}`;
  const nl = /^[ \t]*(\r?\n)([ \t]*)/.exec(body);
  const sep = nl ? `${nl[1]}${nl[2]}` : (empty ? '' : ' ');
  const out = `${text.slice(0, at)}${trimmed}${empty ? '' : ','}${empty && nl ? `${nl[1]}${nl[2]}  ` : sep}${entry}${tail}${text.slice(end)}`;
  try {
    return canonicalJson(JSON.parse(out.replace(/^﻿/, ''))) === canonicalJson(expected) ? out : null;
  } catch { return null; }
}

/** Returned by readText for an existing file that is not valid UTF-8 text (UTF-16, legacy code pages, binary). */
export const BAD_ENCODING = Symbol('bad-encoding');
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const BAD_ENC_DETAIL = 'is not UTF-8 text (UTF-16 or a legacy encoding); left untouched';

/** null when missing; BAD_ENCODING when the bytes are not strict UTF-8 (a UTF-8 BOM is kept in the string). */
function readText(abs) {
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return null; }
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return BAD_ENCODING;
  try { return STRICT_UTF8.decode(buf); } catch { return BAD_ENCODING; }
}

function realKey(abs) {
  try { return fs.realpathSync.native(abs); } catch { return path.resolve(abs); }
}

/**
 * Refuse a write whose real location (after symlinks/junctions in the target or any parent directory) is
 * outside the real repository root.
 */
export function assertInsideRoot(root, abs) {
  const realRoot = realKey(root);
  let probe = path.resolve(abs);
  try { if (fs.lstatSync(probe).isSymbolicLink()) probe = fs.realpathSync.native(probe); } catch { /* missing: check the parent */ }
  for (;;) {
    if (fs.existsSync(probe)) break;
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const real = realKey(probe);
  const rel = path.relative(realRoot, real);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new BatonError(`refusing to write outside the repository: "${toPosix(abs)}" resolves to ${toPosix(real)}`, { code: 'UNSAFE_PATH' });
  }
}

/** Write without breaking symlinks (the target is written through) or hardlinks (written in place). */
function writeKeepingLinks(abs, data) {
  let st = null;
  try { st = fs.lstatSync(abs); } catch { /* new file */ }
  if (st?.isSymbolicLink()) { writeFileAtomic(fs.realpathSync(abs), data); return; }
  if (st?.isFile() && st.nlink > 1) { fs.writeFileSync(abs, data); return; }
  writeFileAtomic(abs, data);
}

function snapshotPath(abs) {
  let st;
  try { st = fs.lstatSync(abs); } catch (e) {
    if (e.code === 'ENOENT') return { abs, existed: false };
    throw e;
  }
  if (st.isSymbolicLink()) {
    let targetIsDirectory = false;
    try { targetIsDirectory = fs.statSync(abs).isDirectory(); } catch { /* dangling link */ }
    return { abs, existed: true, kind: 'symlink', link: fs.readlinkSync(abs), targetIsDirectory };
  }
  if (st.isFile()) return { abs, existed: true, kind: 'file', data: fs.readFileSync(abs), mode: st.mode };
  return { abs, existed: true, kind: 'other' };
}

function restoreSnapshot(s) {
  let current = null;
  try { current = fs.lstatSync(s.abs); } catch { /* missing */ }
  if (!s.existed) {
    if (current && !current.isDirectory()) fs.rmSync(s.abs, { force: true });
    return;
  }
  if (s.kind === 'other') return;
  ensureDir(path.dirname(s.abs));
  if (s.kind === 'symlink') {
    if (current) fs.rmSync(s.abs, { force: true, recursive: current.isDirectory() && !current.isSymbolicLink() });
    fs.symlinkSync(s.link, s.abs, process.platform === 'win32' ? (s.targetIsDirectory ? 'junction' : 'file') : undefined);
    return;
  }
  if (current && !current.isFile()) {
    fs.rmSync(s.abs, { force: true, recursive: current.isDirectory() && !current.isSymbolicLink() });
    current = null;
  }
  if (current?.isFile()) fs.writeFileSync(s.abs, s.data);
  else writeFileAtomic(s.abs, s.data);
  try { fs.chmodSync(s.abs, s.mode); } catch { /* not supported on this filesystem */ }
}

function rollbackFiles(snapshots, createdDirs) {
  const failures = [];
  for (const s of [...snapshots].reverse()) {
    try { restoreSnapshot(s); } catch (e) { failures.push(`${toPosix(s.abs)}: ${e.code || e.message}`); }
  }
  for (const dir of [...createdDirs].sort((a, b) => b.length - a.length)) {
    try { fs.rmdirSync(dir); } catch { /* non-empty, already gone, or retained by the host */ }
  }
  return failures;
}

function parseJsonText(text) {
  return JSON.parse(text.replace(/^﻿/, ''));
}

/** Render a template string. `${{ ... }}` (GitHub Actions expressions) is passed through untouched. */
export function renderText(src, vars, { partialsDir, strict = false } = {}) {
  const held = [];
  const guarded = src.replace(/\$\{\{[\s\S]*?\}\}/g, (m) => { held.push(m); return `${held.length - 1}`; });
  const out = render(guarded, vars, { strict, partialsDir });
  return out.replace(/(\d+)/g, (_, i) => held[Number(i)]);
}

function makeRenderer(registry, env) {
  const strict = !!(env && env.BATON_TEMPLATE_STRICT);
  const partialsDir = path.join(registry.templates, 'partials');
  const wrap = (label, fn) => {
    try { return fn(); } catch (e) {
      if (e instanceof BatonError && e.code === 'TEMPLATE') throw new BatonError(`${label}: ${e.message}`, { code: 'TEMPLATE', hint: e.hint });
      throw e;
    }
  };
  return {
    text: (s, vars, label = 'template') => wrap(label, () => renderText(s, vars, { partialsDir, strict: false })),
    file: (rel, vars) => {
      const file = path.join(registry.templates, rel);
      if (!fs.existsSync(file)) return null;
      return wrap(rel, () => renderText(fs.readFileSync(file, 'utf8'), vars, { partialsDir, strict }));
    },
  };
}

export function readRawConfig(root) {
  return readJson(configPath(root), null);
}

/** Variables every template sees (SPEC 7.1). */
export function baseVars(config) {
  return {
    project: { name: config.project?.name || '', description: config.project?.description || '', stack: config.project?.stack || [] },
    cli: config.runtime?.command || 'baton',
    agents: (config.agents || []).map((a) => ({ id: a.id, name: a.name, kind: a.kind, roles: a.roles, strengths: a.strengths })),
    orchestrator: config.orchestrator,
    testCommand: config.test?.command || '',
    roles: ROLES,
    cmds: COMMANDS,
    baton: { version: packageVersion() },
  };
}

/* ------------------------------------------------------------------ desired state */

/**
 * Build the list of things the installer wants on disk. Pure with respect to the repo (reads only templates and detection).
 * @returns {{entries: object[], notices: string[], missing: Set<string>}}
 */
function buildDesired({ root, env, config, registry, opts, prevManifest }) {
  const rend = makeRenderer(registry, env);
  const notices = [];
  const missing = new Set();
  const entries = [];
  const seen = new Set();
  const add = (e) => {
    e.path = safeRel(e.path);
    if (seen.has(e.path)) return;
    seen.add(e.path);
    entries.push(e);
  };
  const vars0 = baseVars(config);
  const has = (group) => Object.values(prevManifest.files).some((r) => r.group === group);

  const fromTemplate = (rel, vars, label) => {
    const text = rend.file(rel, vars);
    if (text == null) { notices.push(`template not found: ${rel}${label ? ` (${label})` : ''}`); return null; }
    return text;
  };

  /** Expand registry-style file entries ({src,dest,each,mode}) into installer entries. */
  const expand = (spec, group, vars) => {
    const variants = spec.each === 'role' ? ROLES.map((role) => ({ role, roleTitle: ROLE_TITLES[role] }))
      : spec.each === 'cmd' ? COMMANDS.map((cmd) => ({ cmd, cmdTitle: CMD_TITLES[cmd] }))
        : [{}];
    for (const extra of variants) {
      const v = { ...vars, ...extra };
      const dest = rend.text(spec.dest, v, `dest ${spec.dest}`).trim();
      if (!dest) { notices.push(`empty destination for template ${spec.src}`); continue; }
      let body = fromTemplate(spec.src, v, group);
      if (body == null) { missing.add(safeRel(dest)); continue; }
      if (spec.postprocess) body = postprocess(body, spec.postprocess, registry.postprocessors);
      if (spec.onlyIfAbsent && spec.mode === 'file') add({ kind: 'create', path: dest, data: body, group });
      else if (spec.mode === 'block') add({ kind: 'block', path: dest, body, style: 'html', group });
      else if (spec.mode === 'merge-json') add({ kind: 'merge-json', path: dest, snippet: body, group });
      else if (spec.mode === 'create') add({ kind: 'create', path: dest, data: body, group });
      else add({ kind: 'file', path: dest, data: body, group });
    }
  };

  const only = opts.only || null;

  if (!only) {
    // shared files (the AGENTS.md managed block with the protocol)
    for (const spec of registry.shared) expand(spec, 'core', vars0);
    add({ kind: 'config', path: '.baton/config.json', data: `${JSON.stringify(config, null, 2)}\n`, group: 'core' });
    const starter = rend.file(registry.planStarter, vars0);
    add({ kind: 'plan', path: '.baton/plan.json', data: starter ?? `${JSON.stringify(FALLBACK_STARTER_PLAN, null, 2)}\n`, group: 'core' });
    for (const role of ROLES) {
      const v = { ...vars0, role, roleTitle: ROLE_TITLES[role] };
      const text = rend.file(`prompts/${role}.md`, v);
      if (text == null) { notices.push(`template not found: prompts/${role}.md`); missing.add(`.baton/prompts/${role}.md`); continue; }
      add({ kind: 'file', path: `.baton/prompts/${role}.md`, data: text, group: 'prompts' });
    }
    if (!opts.noGitIgnore) {
      add({ kind: 'block', path: '.gitignore', body: GITIGNORE_BODY, style: 'hash', group: 'core' });
      add({ kind: 'block', path: '.gitattributes', body: GITATTRIBUTES_BODY, style: 'hash', group: 'core' });
    }
    if (fs.existsSync(path.join(root, 'package.json'))) {
      add({ kind: 'json-key', path: 'package.json', key: 'scripts.baton', value: config.runtime?.vendored ? RUNTIME_COMMAND : 'baton', group: 'core' });
    }
    // Adapters are MIT-covered even when --no-vendor skips the runtime.
    add({ kind: 'file', path: '.baton/LICENSE', data: readLicense(), group: 'core' });
    if (opts.vendor) {
      for (const f of collectRuntime({ srcRoot: packageRoot(), templates: registry.templates })) add({ kind: 'file', path: f.rel, data: f.data, group: 'runtime', always: true });
      for (const f of shims()) add({ kind: 'file', path: f.rel, data: f.data, group: 'runtime', always: true, exec: !!f.exec });
    }
  }

  // adapter files
  const customs = loadCustomAdapters(root);
  for (const agent of config.agents) {
    if (only && agent.id !== only) continue;
    const group = `adapter:${agent.id}`;
    const adapter = registry.byId.get(agent.kind);
    const label = adapter?.label || agent.kind;
    const vars = { ...vars0, agent: { id: agent.id, name: agent.name, kind: agent.kind, label } };
    if (adapter) {
      if (!adapter.files.length) notices.push(`adapter ${adapter.id} has no file entries in templates/adapters.json`);
      for (const spec of adapter.files) expand(spec, group, vars);
      continue;
    }
    const custom = customs.find((c) => c.id === agent.id);
    if (!custom) { notices.push(`agent ${agent.id}: kind "${agent.kind}" has no adapter (declare it in .baton/agents.json)`); continue; }
    if (custom.instructionFile) {
      const tplFile = registry.templates && path.join(registry.templates, 'adapters', 'custom', 'instruction.md.tpl');
      const src = tplFile && fs.existsSync(tplFile) ? fs.readFileSync(tplFile, 'utf8') : FALLBACK_CUSTOM_BLOCK;
      add({ kind: 'block', path: custom.instructionFile, body: rend.text(src, vars, 'custom instruction'), style: 'html', group });
    }
    if (custom.templateDir) {
      const dir = path.join(root, safeRel(custom.templateDir));
      const walkDir = (d, rel) => {
        for (const e of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) {
          if (e.isDirectory()) walkDir(path.join(d, e.name), `${rel}${e.name}/`);
          else if (e.name.endsWith('.tpl')) {
            const dest = rend.text(`${rel}${e.name.slice(0, -4)}`, vars).trim();
            add({ kind: 'file', path: dest, data: rend.text(fs.readFileSync(path.join(d, e.name), 'utf8'), vars, `${rel}${e.name}`), group });
          }
        }
      };
      walkDir(dir, '');
    }
  }

  // optional files switched on by a flag (adapters.json `extras`): hooks, cloud workflows, docs
  if (!only) {
    const wantDocs = opts.docs || fs.existsSync(path.join(root, 'docs')) || has('docs');
    const on = { hooks: !!opts.hooks, cloud: !!opts.cloud, docs: wantDocs };
    for (const spec of registry.extras) {
      if (!on[spec.when] || !extraApplies(spec, config)) continue;
      if (spec.when === 'hooks' && !fs.existsSync(path.join(registry.templates, spec.src))) {
        add({ kind: 'merge-json', path: spec.dest, snippet: rend.text(FALLBACK_HOOKS_SNIPPET, vars0, spec.src), group: 'hooks' });
        continue;
      }
      expand(spec, spec.when, vars0);
    }
  }
  return { entries, notices, missing };
}

/* ------------------------------------------------------------------ resolving against disk */

/**
 * Decide what to do for one entry. Returns {op, write, sidecar, record}.
 *  op: {path, action: create|update|unchanged|skip, kind, group, detail?}
 */
function resolveEntry(root, e, prev, { force, read = readText }) {
  const abs = path.join(root, e.path);
  const readText = read;
  const skipBad = () => { op.action = 'skip'; op.detail = BAD_ENC_DETAIL; out.record = prev || null; return out; };
  const op = { path: e.path, kind: e.kind, group: e.group, action: 'unchanged' };
  const out = { op, write: null, sidecar: null, record: null };

  if (e.kind === 'file') {
    const nextHash = hashContent(e.data);
    const cur = fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs) : null;
    out.record = { mode: 'file', group: e.group, sha256: nextHash };
    if (cur == null) { op.action = 'create'; out.write = { abs, data: e.data, exec: e.exec }; return out; }
    const curHash = hashContent(cur);
    if (curHash === nextHash) { op.action = 'unchanged'; return out; }
    if (e.always || force || (prev && prev.sha256 === curHash)) {
      op.action = 'update';
      op.detail = force && !e.always && !(prev && prev.sha256 === curHash) ? 'overwritten (--force)' : undefined;
      out.write = { abs, data: e.data, exec: e.exec };
      return out;
    }
    op.action = 'skip';
    op.detail = `modified by you; new version written to ${e.path}${SIDECAR_SUFFIX}`;
    out.record = prev || null;
    out.sidecar = { path: `${e.path}${SIDECAR_SUFFIX}`, data: e.data };
    return out;
  }

  if (e.kind === 'create' || e.kind === 'config' || e.kind === 'plan') {
    const cur = readText(abs);
    if (cur === BAD_ENCODING) { if (e.kind === 'config') return skipBad(); out.record = e.kind === 'create' ? (prev || null) : { mode: e.kind, group: e.group }; return out; }
    // `create` files are the user's after the first write: tracked by hash only so uninstall can tell if they are untouched
    out.record = e.kind === 'create' ? (prev || null) : { mode: e.kind, group: e.group };
    if (cur == null) {
      op.action = 'create'; out.write = { abs, data: e.data };
      if (e.kind === 'create') out.record = { mode: 'create', group: e.group, sha256: hashContent(e.data) };
      return out;
    }
    if (e.kind === 'config') {
      let same = false;
      try { same = canonicalJson(parseJsonText(cur)) === canonicalJson(parseJsonText(e.data)); } catch { /* corrupt: loadConfig reports it */ }
      if (!same) { op.action = 'update'; out.write = { abs, data: e.data }; }
    }
    return out;
  }

  if (e.kind === 'block') {
    const cur = readText(abs);
    if (cur === BAD_ENCODING) return skipBad();
    const r = applyBlock(cur, e.body, e.style);
    out.record = { mode: 'block', group: e.group, managed: true, style: e.style, sha256: blockHash(blockText(e.body, e.style)) };
    if (r.action === 'malformed') {
      op.action = 'skip';
      op.detail = 'has a baton begin or end marker without its partner; left untouched';
      out.record = prev || null;
      return out;
    }
    if (cur == null) op.action = 'create';
    else if (r.action === 'unchanged') op.action = 'unchanged';
    else { op.action = 'update'; op.detail = r.action === 'append' ? 'block appended' : 'block replaced in place'; }
    if (op.action !== 'unchanged') out.write = { abs, data: r.text };
    return out;
  }

  if (e.kind === 'merge-json') {
    let snippet;
    try { snippet = parseJsonText(e.snippet); } catch (err) {
      op.action = 'skip'; op.detail = `template is not valid JSON: ${err.message}`; return out;
    }
    const cur = readText(abs);
    if (cur === BAD_ENCODING) return skipBad();
    out.record = { mode: 'merge-json', group: e.group, managed: true, snippet };
    if (cur == null) { op.action = 'create'; out.write = { abs, data: stringifyLike(null, snippet) }; return out; }
    let existing;
    try { existing = parseJsonText(cur); } catch (err) {
      op.action = 'skip'; op.detail = `existing file is not valid JSON (${err.message}); left untouched`; out.record = prev || null; return out;
    }
    const merged = mergeJson(existing, snippet);
    if (canonicalJson(merged) === canonicalJson(existing)) return out;
    op.action = 'update'; op.detail = 'merged without removing existing settings';
    out.write = { abs, data: stringifyLike(cur, merged) };
    return out;
  }

  if (e.kind === 'json-key') {
    const cur = readText(abs);
    if (cur === BAD_ENCODING) return skipBad();
    if (cur == null) { op.action = 'skip'; op.detail = 'file missing'; return out; }
    let pkg;
    try { pkg = parseJsonText(cur); } catch (err) {
      op.action = 'skip'; op.detail = `not valid JSON (${err.message}); left untouched`; return out;
    }
    const [top, sub] = e.key.split('.');
    const have = pkg?.[top]?.[sub];
    if (have === e.value) { out.record = { mode: 'json-key', group: e.group, key: e.key, value: e.value }; return out; }
    if (have !== undefined) {
      op.action = 'skip'; op.detail = `${e.key} is already set to "${have}"; left untouched`; out.record = prev || null; return out;
    }
    pkg[top] = { ...(pkg[top] || {}), [sub]: e.value };
    op.action = 'update'; op.detail = `added ${e.key}`;
    out.record = { mode: 'json-key', group: e.group, key: e.key, value: e.value };
    out.write = { abs, data: spliceKey(cur, top, sub, e.value, pkg) ?? stringifyLike(cur, pkg) };
    return out;
  }
  throw new BatonError(`internal: unknown entry kind ${e.kind}`);
}

/* ------------------------------------------------------------------ removal (prune and uninstall) */

function pruneEmptyDirs(root, dir) {
  let d = path.resolve(dir);
  const top = path.resolve(root);
  while (d.startsWith(top + path.sep) && d !== top) {
    try {
      if (path.basename(d) === '.git' || fs.readdirSync(d).length) return;
      fs.rmdirSync(d);
    } catch { return; }
    d = path.dirname(d);
  }
}

/**
 * Remove one manifest-tracked thing if it is still what baton wrote.
 * @returns {{action: 'removed'|'kept'|'missing', detail?: string}}
 */
export function removeTracked(root, rel, rec, { dryRun = false } = {}) {
  const abs = path.join(root, safeRel(rel));
  const done = (detail) => ({ action: 'removed', detail });
  const cur = readText(abs);
  if (cur == null) return { action: 'missing' };
  if (cur === BAD_ENCODING && ['block', 'merge-json', 'json-key'].includes(rec.mode)) return { action: 'kept', detail: 'not UTF-8 text' };
  const drop = () => { if (!dryRun) { fs.rmSync(abs, { force: true }); pruneEmptyDirs(root, path.dirname(abs)); } };
  const rewrite = (text) => { if (!dryRun) { assertInsideRoot(root, abs); writeKeepingLinks(abs, text); } };
  if (rec.mode === 'block') {
    const block = extractBlock(cur, rec.style || 'html');
    if (block == null) return { action: 'missing' };
    if (blockHash(block) !== rec.sha256) return { action: 'kept', detail: 'managed block was edited by you' };
    const next = removeBlock(cur, rec.style || 'html');
    if (!next.trim()) { drop(); return done('file removed (only the block was in it)'); }
    rewrite(next);
    return done('block removed');
  }
  if (rec.mode === 'merge-json') {
    let existing;
    try { existing = parseJsonText(cur); } catch { return { action: 'kept', detail: 'not valid JSON' }; }
    const next = unmergeJson(existing, rec.snippet);
    if (canonicalJson(next) === canonicalJson(existing)) return { action: 'missing' };
    if (!Object.keys(next).length) { drop(); return done('file removed (only baton settings were in it)'); }
    rewrite(stringifyLike(cur, next));
    return done('baton settings removed');
  }
  if (rec.mode === 'json-key') {
    let pkg;
    try { pkg = parseJsonText(cur); } catch { return { action: 'kept', detail: 'not valid JSON' }; }
    const [top, sub] = rec.key.split('.');
    if (pkg?.[top]?.[sub] !== rec.value) return { action: 'kept', detail: `${rec.key} was changed by you` };
    delete pkg[top][sub];
    if (!Object.keys(pkg[top]).length) delete pkg[top];
    rewrite(stringifyLike(cur, pkg));
    return done(`${rec.key} removed`);
  }
  if (rec.sha256 && hashFileOnDisk(abs) === rec.sha256) { drop(); return done(); }
  return { action: 'kept', detail: 'modified by you' };
}

/* ------------------------------------------------------------------ interaction */

function ask(rl, question, def) {
  return new Promise((resolve) => {
    let answered = false;
    rl.question(`${question}${def ? ` [${def}]` : ''}: `, (a) => { answered = true; resolve(a.trim() || def || ''); });
    rl.once('close', () => { if (!answered) resolve(def || ''); });
  });
}

/* ------------------------------------------------------------------ main entry */

/**
 * Plan (and, unless dryRun, apply) an install. Idempotent and non-destructive (SPEC section 7).
 * @param {{root: string, env?: object, stdin?: any}} ctx
 * @param {{mode?: 'init'|'upgrade'|'agents', agents?: string, name?: string, testCmd?: string, yes?: boolean, force?: boolean,
 *   dryRun?: boolean, noVendor?: boolean, cloud?: boolean, hooks?: boolean, noGitIgnore?: boolean, docs?: boolean, only?: string,
 *   config?: object, prune?: boolean, _failAfter?: number}} [opts]
 */
export async function runInstall(ctx, opts = {}) {
  const root = path.resolve(ctx.root);
  const env = ctx.env || process.env;
  const mode = opts.mode || 'init';
  const version = packageVersion();
  const registry = loadRegistry(env);
  const notices = [];

  if (!fs.existsSync(root)) throw new BatonError(`repository root does not exist: ${root}`);
  const prevManifest = loadManifest(root);
  for (const k of prevManifest.unsafe || []) notices.push(`.baton/manifest.json: ignored unsafe entry "${k}" (it points outside the repository)`);
  const rawCfg = readRawConfig(root);
  if (mode !== 'init' && !rawCfg) throw new BatonError('not a baton project: .baton/config.json is missing', { code: 'NOT_INIT', hint: 'run "baton init" first' });

  // ---- config
  let config;
  let newProject = false;
  if (opts.config) config = opts.config;
  else if (rawCfg) {
    config = JSON.parse(JSON.stringify(rawCfg));
    if (opts.name) config.project = { ...(config.project || {}), name: opts.name };
    if (opts.testCmd !== undefined) config.test = { ...(config.test || {}), command: opts.testCmd, required: !!opts.testCmd };
    if (opts.agents && opts.agents !== 'auto') {
      const sel = selectRoster(registry, [], opts.agents, { ensureOrchestrator: false }).agents;
      const ids = new Set((config.agents || []).map((a) => a.id));
      config.agents = [...(config.agents || []), ...sel.filter((a) => !ids.has(a.id))];
    }
  } else {
    newProject = true;
    const stack = detectStack(root);
    const detected = detectAgents(root, registry, env);
    let { agents, padded } = selectRoster(registry, detected, opts.agents || 'auto');
    let testCommand = opts.testCmd !== undefined ? opts.testCmd : stack.testCommand;
    let name = opts.name || stack.name;
    const input = ctx.stdin ?? process.stdin;
    const interactive = !opts.yes && !opts.dryRun && !!input.isTTY && !!process.stdout.isTTY;
    if (interactive) {
      const rl = readline.createInterface({ input, output: process.stdout });
      try {
        name = opts.name || await ask(rl, 'Project name', name);
        if (!opts.agents || opts.agents === 'auto') {
          const answer = await ask(rl, `Agents to set up (comma list, or "all"; detected: ${detected.filter((d) => d.installed || d.present).map((d) => d.id).join(', ') || 'none'})`, agents.map((a) => a.id).join(','));
          agents = selectRoster(registry, detected, answer).agents;
          padded = [];
        }
        if (opts.testCmd === undefined) testCommand = await ask(rl, 'Test command (blank for none)', testCommand);
      } finally { rl.close(); }
    }
    if (padded.length) notices.push(`no second agent detected: added ${padded.join(', ')} to the roster so reviews can be done by a different agent (change with "baton agents")`);
    config = defaultConfig({
      name, description: stack.description, stack: stack.stack, agents, testCommand, testRequired: !!testCommand,
      runtimeVendored: !opts.noVendor,
    });
    if (!testCommand) notices.push('no test command detected: set one with --test-cmd or edit .baton/config.json (test.command)');
  }
  const { errors } = validateConfig(config);
  if (errors.length) throw new BatonError(`invalid configuration:\n  - ${errors.join('\n  - ')}`, { code: 'BAD_CONFIG' });
  for (const a of config.agents) if (!AGENT_ID_RE.test(a.id)) throw new BatonError(`invalid agent id "${a.id}"`);

  // ---- what to install
  const runtimeNeeded = (config.runtime?.vendored ?? true) && !opts.noVendor;
  const fromRuntime = runtimeNeeded && runningFromRuntime(root);
  const vendor = runtimeNeeded && !fromRuntime;
  if (fromRuntime) notices.push('running from the vendored runtime: nothing newer to copy (run "baton upgrade" from a newer baton package)');
  // cloud and hooks files installed earlier keep being refreshed by upgrade and re-runs
  const hadGroup = (g) => Object.values(prevManifest.files).some((r) => r.group === g);
  const dOpts = { ...opts, vendor, cloud: !!opts.cloud || hadGroup('cloud'), hooks: !!opts.hooks || hadGroup('hooks') };
  const desired = buildDesired({ root, env, config, registry, opts: dOpts, prevManifest });
  notices.push(...desired.notices);

  // ---- resolve against disk
  const files = { ...prevManifest.files };
  const ops = [];
  const writes = [];
  const wanted = new Set();
  // text already planned for a file, so two entries that reach one file (CLAUDE.md symlinked to AGENTS.md) build on each other
  const overlay = new Map();
  const read = (abs) => { const k = realKey(abs); return overlay.has(k) ? overlay.get(k) : readText(abs); };
  for (const e of desired.entries) {
    wanted.add(e.path);
    const r = resolveEntry(root, e, prevManifest.files[e.path], { force: !!opts.force, read });
    ops.push(r.op);
    if (r.write) {
      writes.push(r.write);
      if (typeof r.write.data === 'string') overlay.set(realKey(r.write.abs), r.write.data);
    }
    if (r.record) files[e.path] = r.record;
    if (r.sidecar) {
      const sAbs = path.join(root, r.sidecar.path);
      const cur = readText(sAbs);
      const sop = { path: r.sidecar.path, kind: 'sidecar', group: e.group, action: cur == null ? 'create' : hashContent(cur) === hashContent(r.sidecar.data) ? 'unchanged' : 'update' };
      ops.push(sop);
      if (sop.action !== 'unchanged') writes.push({ abs: sAbs, data: r.sidecar.data });
      notices.push(`${e.path} was modified by you: kept as is, new version in ${r.sidecar.path} (merge it by hand or re-run with --force)`);
    } else if (r.op.action !== 'skip' && e.kind === 'file' && fs.existsSync(path.join(root, e.path + SIDECAR_SUFFIX))) {
      ops.push({ path: e.path + SIDECAR_SUFFIX, kind: 'sidecar', group: e.group, action: 'remove', detail: 'stale sidecar' });
      writes.push({ abs: path.join(root, e.path + SIDECAR_SUFFIX), remove: true });
    }
    if (r.op.action === 'skip' && e.kind !== 'file' && r.op.detail) notices.push(`${e.path}: ${r.op.detail}`);
  }

  // ---- prune things baton wrote earlier that are no longer wanted
  const pruneGroup = (g) => !opts.only && opts.prune !== false && (
    g.startsWith('adapter:') || g === 'prompts' || (g === 'runtime' && vendor) || (g === 'cloud' && dOpts.cloud) || (g === 'hooks' && dOpts.hooks));
  for (const [rel, rec] of Object.entries(prevManifest.files)) {
    if (wanted.has(rel) || desired.missing.has(rel) || !pruneGroup(rec.group || '')) continue;
    const r = removeTracked(root, rel, rec, { dryRun: true });
    if (r.action === 'missing') { delete files[rel]; continue; }
    if (r.action === 'kept') { notices.push(`${rel}: no longer needed but ${r.detail}; left in place`); continue; }
    ops.push({ path: rel, kind: rec.mode, group: rec.group, action: 'remove', detail: r.detail });
    writes.push({ prune: { rel, rec } });
    delete files[rel];
  }

  const manifest = { version: 1, baton: version, files };
  const manifestText = (() => { const sorted = {}; for (const k of Object.keys(files).sort()) sorted[k] = files[k]; return `${JSON.stringify({ version: 1, baton: version, files: sorted }, null, 2)}\n`; })();
  const curManifest = readText(path.join(root, '.baton', 'manifest.json'));
  const manifestAction = curManifest == null ? 'create' : curManifest === manifestText ? 'unchanged' : 'update';
  ops.push({ path: '.baton/manifest.json', kind: 'manifest', group: 'core', action: manifestAction });

  const changed = ops.some((o) => o.action !== 'unchanged');
  const result = {
    root: toPosix(root), mode, dryRun: !!opts.dryRun, version, previousVersion: prevManifest.files && Object.keys(prevManifest.files).length ? prevManifest.baton : null,
    ops, notices, changed, newProject, agents: config.agents.map((a) => a.id), config,
    cloud: !!dOpts.cloud, hooks: !!dOpts.hooks, vendored: runtimeNeeded,
  };
  if (opts.dryRun) return result;

  // ---- apply (every target is checked first so a refusal leaves the tree untouched)
  // Legal notices must never write through symlinks or hardlinks into a host LICENSE.
  for (const rel of ['.baton/LICENSE', '.baton/runtime/LICENSE']) {
    const abs = path.join(root, rel);
    let st;
    try { st = fs.lstatSync(abs); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (st && (st.isSymbolicLink() || st.nlink > 1)) {
      throw new BatonError(`refusing aliased license target ${rel}; replace the link yourself before installing`, { code: 'UNSAFE_PATH' });
    }
  }
  for (const w of writes) if (w.abs && !w.remove) assertInsideRoot(root, w.abs);
  const manifestAbs = path.join(root, '.baton', 'manifest.json');
  const targets = [...writes.map((w) => w.abs || (w.prune && path.join(root, w.prune.rel))).filter(Boolean), manifestAbs];
  const snapshots = [];
  const seenSnapshots = new Set();
  for (const abs of targets) {
    const key = path.resolve(abs);
    if (seenSnapshots.has(key)) continue;
    seenSnapshots.add(key);
    const logical = snapshotPath(key);
    snapshots.push(logical);
    if (logical.kind === 'symlink') {
      const target = fs.realpathSync.native(key);
      if (!seenSnapshots.has(target)) { seenSnapshots.add(target); snapshots.push(snapshotPath(target)); }
    }
  }
  const createdDirs = new Set();
  for (const abs of targets) {
    let dir = path.dirname(abs);
    while (dir.startsWith(root + path.sep) && dir !== root && !fs.existsSync(dir)) {
      createdDirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  let current = null;
  let mutations = 0;
  const injectedFailure = () => {
    mutations++;
    if (Number.isInteger(opts._failAfter) && opts._failAfter === mutations) {
      const err = new Error(`injected installer failure after mutation ${mutations}`);
      err.code = 'BATON_TEST_FAILURE';
      throw err;
    }
  };
  try {
    for (const w of writes) {
      current = w.abs || null;
      if (w.prune) { current = path.join(root, w.prune.rel); removeTracked(root, w.prune.rel, w.prune.rec); injectedFailure(); continue; }
      if (w.remove) { fs.rmSync(w.abs, { force: true }); injectedFailure(); continue; }
      ensureDir(path.dirname(w.abs));
      writeKeepingLinks(w.abs, w.data);
      if (w.exec) {
        try { fs.chmodSync(w.abs, 0o755); } catch { /* not supported on this filesystem */ }
        if (process.platform === 'win32' && !notices.some((n) => n.includes('update-index'))) {
          notices.push(`Windows cannot record the executable bit: after committing, run "git update-index --chmod=+x ${toPosix(path.relative(root, w.abs))}" (or call it as "sh ${toPosix(path.relative(root, w.abs))}")`);
        }
      }
      injectedFailure();
    }
    current = manifestAbs;
    if (manifestAction !== 'unchanged') { saveManifest(root, manifest); injectedFailure(); }
  } catch (err) {
    const rollbackFailures = rollbackFiles(snapshots, createdDirs);
    if (rollbackFailures.length) {
      throw new BatonError(`install failed at ${toPosix(path.relative(root, current || root))} and rollback was incomplete: ${rollbackFailures.join('; ')}`, {
        code: 'ROLLBACK_FAILED', hint: 'preserve the repository and restore the listed paths from version control or backup before retrying',
      });
    }
    if (err instanceof BatonError || !['EPERM', 'EACCES', 'EBUSY', 'EROFS'].includes(err.code)) throw err;
    throw new BatonError(`cannot write ${toPosix(path.relative(root, current || root))}: ${err.code} (is it read-only or open in another program?)`, {
      code: 'IO', hint: 'the partial install was rolled back; fix the file, then re-run the command',
    });
  }
  if (mode === 'init' && (newProject || !readEvents(root).some((ev) => ev.kind === 'init'))) {
    appendEvent(root, { kind: 'init', by: 'harness', note: 'baton init', data: { version, agents: result.agents } });
  }
  return result;
}

/* ------------------------------------------------------------------ output */

/** Human readable report of a runInstall result. */
export function formatResult(r, { title } = {}) {
  const lines = [];
  const verb = r.dryRun ? 'would ' : '';
  const shown = r.ops.filter((o) => o.action !== 'unchanged');
  const label = { create: `${verb}create`, update: `${verb}update`, remove: `${verb}remove`, skip: 'skip' };
  if (title) lines.push(title);
  const pad = r.dryRun ? 13 : 7;
  const runtimeOps = shown.filter((o) => o.group === 'runtime');
  const runtimeCounts = {};
  for (const o of runtimeOps) runtimeCounts[o.action] = (runtimeCounts[o.action] || 0) + 1;
  const runtimeSeen = new Set();
  for (const o of shown) {
    if (o.group === 'runtime') {
      // dozens of vendored files: one line per action (--json lists every file)
      if (runtimeSeen.has(o.action)) continue;
      runtimeSeen.add(o.action);
      const n = runtimeCounts[o.action];
      lines.push(`  ${(label[o.action] || o.action).padEnd(pad)} .baton/runtime/ and shims  (${n} file${n === 1 ? '' : 's'})`);
      continue;
    }
    lines.push(`  ${(label[o.action] || o.action).padEnd(pad)} ${o.path}${o.detail ? `  (${o.detail})` : ''}`);
  }
  const unchanged = r.ops.length - shown.length;
  if (!shown.length) lines.push('  nothing to change: everything is up to date');
  else if (unchanged) lines.push(`  ${unchanged} file${unchanged === 1 ? '' : 's'} already up to date`);
  for (const n of r.notices) lines.push(`note: ${n}`);
  if (r.dryRun) lines.push('dry run: nothing was written');
  return lines.join('\n');
}

