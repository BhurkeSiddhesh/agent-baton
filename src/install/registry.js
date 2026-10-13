import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../lib/util.js';
import { templatesDir } from '../lib/paths.js';
import { BatonError } from '../lib/errors.js';
import { AGENT_ID_RE } from '../lib/config.js';

export const ROLES = ['orchestrator', 'worker', 'reviewer', 'auditor'];
export const ROLE_TITLES = { orchestrator: 'Orchestrator', worker: 'Worker', reviewer: 'Reviewer', auditor: 'Auditor' };
export const COMMANDS = ['plan', 'next', 'review', 'status', 'audit', 'digest'];
export const CMD_TITLES = { plan: 'Plan', next: 'Next', review: 'Review', status: 'Status', audit: 'Audit', digest: 'Digest' };

/** Built-in knowledge about each adapter. templates/adapters.json overrides and extends it at runtime. */
export const BUILTIN_ADAPTERS = [
  { id: 'claude', label: 'Claude Code', detect: { bins: ['claude'], dirs: ['.claude'], files: ['CLAUDE.md'] }, install: 'npm install -g @anthropic-ai/claude-code',
    defaults: { name: 'Claude', roles: ['orchestrator', 'worker', 'reviewer', 'auditor'], strengths: ['architecture', 'security', 'review'] } },
  { id: 'codex', label: 'Codex CLI', detect: { bins: ['codex'], dirs: ['.codex'], files: [] }, install: 'npm install -g @openai/codex',
    defaults: { name: 'Codex', roles: ['worker', 'reviewer', 'auditor'], strengths: ['backend', 'tests', 'integration'] } },
  { id: 'gemini', label: 'Gemini CLI', detect: { bins: ['gemini'], dirs: ['.gemini'], files: ['GEMINI.md'] }, install: 'npm install -g @google/gemini-cli',
    defaults: { name: 'Gemini', roles: ['worker', 'reviewer'], strengths: ['frontend', 'docs', 'research'] } },
  { id: 'antigravity', label: 'Antigravity', detect: { bins: ['antigravity'], dirs: ['.agent', '.agents'], files: [] }, install: 'https://antigravity.google',
    defaults: { name: 'Antigravity', roles: ['worker', 'reviewer', 'auditor'], strengths: ['frontend', 'ui', 'audit'] } },
  { id: 'cursor', label: 'Cursor', detect: { bins: ['cursor-agent', 'cursor'], dirs: ['.cursor'], files: [] }, install: 'https://cursor.com',
    defaults: { name: 'Cursor', roles: ['worker', 'reviewer'], strengths: ['frontend', 'refactoring'] } },
  { id: 'copilot', label: 'GitHub Copilot', detect: { bins: ['copilot'], dirs: [], files: ['.github/copilot-instructions.md'] }, install: 'npm install -g @github/copilot',
    defaults: { name: 'Copilot', roles: ['worker', 'reviewer'], strengths: ['tests', 'refactoring'] } },
  { id: 'windsurf', label: 'Windsurf', detect: { bins: ['windsurf'], dirs: ['.windsurf'], files: [] }, install: 'https://windsurf.com',
    defaults: { name: 'Windsurf', roles: ['worker', 'reviewer'], strengths: ['frontend'] } },
  { id: 'cline', label: 'Cline', detect: { bins: [], dirs: ['.clinerules'], files: ['.clinerules'] }, install: 'install the Cline extension in your editor',
    defaults: { name: 'Cline', roles: ['worker', 'reviewer'], strengths: ['refactoring'] } },
  { id: 'aider', label: 'Aider', detect: { bins: ['aider'], dirs: [], files: ['.aider.conf.yml', 'CONVENTIONS.md'] }, install: 'python -m pip install aider-chat',
    defaults: { name: 'Aider', roles: ['worker', 'reviewer'], strengths: ['refactoring', 'tests'] } },
  { id: 'opencode', label: 'OpenCode', detect: { bins: ['opencode'], dirs: ['.opencode'], files: [] }, install: 'npm install -g opencode-ai',
    defaults: { name: 'OpenCode', roles: ['worker', 'reviewer'], strengths: ['backend'] } },
];

/** Files every project gets, and optional files switched on by an install flag (`when`): used when adapters.json lacks them. */
export const DEFAULT_SHARED = [{ src: 'agents-block.md.tpl', dest: 'AGENTS.md', each: null, mode: 'block' }];
export const DEFAULT_EXTRAS = [
  { src: 'hooks/claude-settings.json', dest: '.claude/settings.json', each: null, mode: 'merge-json', when: 'hooks' },
  { src: 'github/baton-ci.yml.tpl', dest: '.github/workflows/baton-ci.yml', each: null, mode: 'file', when: 'cloud', postprocess: 'github-expressions' },
  { src: 'github/baton-claude.yml.tpl', dest: '.github/workflows/baton-claude.yml', each: null, mode: 'file', when: 'cloud', postprocess: 'github-expressions' },
  { src: 'github/baton-dispatch.yml.tpl', dest: '.github/workflows/baton-dispatch.yml', each: null, mode: 'file', when: 'cloud', postprocess: 'github-expressions' },
  { src: 'github/PULL_REQUEST_TEMPLATE.md.tpl', dest: '.github/PULL_REQUEST_TEMPLATE.md', each: null, mode: 'file', when: 'cloud', onlyIfAbsent: true },
  { src: 'docs/ORCHESTRATION.md.tpl', dest: 'docs/BATON.md', each: null, mode: 'file', when: 'docs' },
];

/** CLIs looked up on PATH during detection (some, like gh and code, are tools rather than agents). */
export const DETECT_BINS = ['claude', 'codex', 'gemini', 'cursor-agent', 'aider', 'opencode', 'copilot', 'gh', 'code', 'cursor', 'windsurf'];

/** Directory the templates are read from: BATON_TEMPLATES_DIR (tests, experiments) or the package's own. */
export function templatesRoot(env = process.env) {
  const o = env && env.BATON_TEMPLATES_DIR;
  return o ? path.resolve(o) : templatesDir();
}

function normFileEntry(e, adapterId) {
  if (!e || typeof e.src !== 'string' || typeof e.dest !== 'string') {
    throw new BatonError(`templates/adapters.json: adapter "${adapterId}" has an invalid file entry ${JSON.stringify(e)}`, { code: 'BAD_REGISTRY' });
  }
  const mode = e.mode || 'file';
  if (!['file', 'block', 'merge-json', 'create'].includes(mode)) {
    throw new BatonError(`templates/adapters.json: adapter "${adapterId}" entry ${e.dest} has unknown mode "${mode}"`, { code: 'BAD_REGISTRY' });
  }
  const each = e.each || null;
  if (each && !['role', 'cmd'].includes(each)) {
    throw new BatonError(`templates/adapters.json: adapter "${adapterId}" entry ${e.dest} has unknown each "${each}"`, { code: 'BAD_REGISTRY' });
  }
  const out = { src: e.src, dest: e.dest, each, mode };
  if (e.onlyIfAbsent) out.onlyIfAbsent = true;
  if (e.when) out.when = String(e.when);
  if (e.postprocess) out.postprocess = String(e.postprocess);
  return out;
}

function listFrom(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.adapters)) return raw.adapters;
  if (raw && raw.adapters && typeof raw.adapters === 'object') return Object.entries(raw.adapters).map(([id, v]) => ({ id, ...v }));
  return [];
}

/**
 * Load the adapter registry: built-ins merged with templates/adapters.json (accepted shapes: an array, `{adapters: [...]}`
 * or `{adapters: {id: {...}}}`; per-adapter file entries live under `files`).
 * @returns {{templates: string, adapters: object[], byId: Map<string, object>}}
 */
export function loadRegistry(env = process.env) {
  const templates = templatesRoot(env);
  const file = path.join(templates, 'adapters.json');
  let raw = null;
  if (fs.existsSync(file)) raw = readJson(file);
  const fromFile = new Map(listFrom(raw).filter((a) => a && typeof a.id === 'string').map((a) => [a.id, a]));
  const adapters = [];
  const seen = new Set();
  const build = (id, base, over) => {
    const o = over || {};
    const detect = { bins: [], dirs: [], files: [], ...(base?.detect || {}), ...(o.detect || {}) };
    const filesRaw = o.files ?? o.entries ?? [];
    return {
      id,
      label: o.label || base?.label || id,
      detect,
      install: o.install || base?.install || '',
      defaults: { name: base?.defaults?.name || o.label || id, roles: ['worker', 'reviewer'], strengths: [], ...(base?.defaults || {}), ...(o.defaults || {}) },
      notes: o.notes || '',
      files: filesRaw.map((e) => normFileEntry(e, id)),
    };
  };
  for (const b of BUILTIN_ADAPTERS) { adapters.push(build(b.id, b, fromFile.get(b.id))); seen.add(b.id); }
  for (const [id, a] of fromFile) if (!seen.has(id) && id !== 'custom') adapters.push(build(id, null, a));
  const list = (v, label) => (Array.isArray(v) ? v.map((e) => normFileEntry(e, label)) : null);
  return {
    templates,
    adapters,
    byId: new Map(adapters.map((a) => [a.id, a])),
    shared: list(raw?.shared, 'shared') || DEFAULT_SHARED,
    extras: list(raw?.extras, 'extras') || DEFAULT_EXTRAS,
    postprocessors: raw?.postprocessors && typeof raw.postprocessors === 'object' ? raw.postprocessors : {},
    planStarter: typeof raw?.planStarter === 'string' ? raw.planStarter : 'plan.starter.json',
  };
}

/** User-declared adapters in `.baton/agents.json`: [{id, label, instructionFile, templateDir}]. */
export function loadCustomAdapters(root) {
  const file = path.join(root, '.baton', 'agents.json');
  if (!fs.existsSync(file)) return [];
  const raw = readJson(file);
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.agents) ? raw.agents : [];
  return arr.filter((a) => a && AGENT_ID_RE.test(String(a.id)));
}

/** Default roster entry for an adapter kind (unknown kinds get a plain worker/reviewer). */
export function defaultAgentFor(registry, kind, id = kind) {
  const a = registry.byId.get(kind);
  const d = a?.defaults || { name: id, roles: ['worker', 'reviewer'], strengths: [] };
  return { id, name: id === kind ? d.name : id, kind: a ? kind : 'custom', roles: [...d.roles], strengths: [...d.strengths] };
}
