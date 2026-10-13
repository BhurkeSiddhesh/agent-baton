import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../lib/util.js';
import { BatonError } from '../lib/errors.js';
import { AGENT_ID_RE, RESERVED_AGENTS } from '../lib/config.js';
import { defaultAgentFor, DETECT_BINS } from './registry.js';

/** Resolve an executable on PATH without spawning anything. Returns the absolute path or null. */
export function findOnPath(bin, env = process.env, cwd = process.cwd()) {
  if (!bin) return null;
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path');
  const dirs = (key ? env[key] : '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? ['', ...((env.PATHEXT || env.Pathext || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean))]
    : [''];
  const hasSep = /[\\/]/.test(bin);
  const candidates = hasSep ? [path.resolve(cwd, bin)] : dirs.map((d) => path.join(d, bin));
  for (const base of candidates) {
    for (const ext of exts) {
      try {
        if (fs.statSync(base + ext).isFile()) return base + ext;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

function exists(root, rel) {
  try { return fs.existsSync(path.join(root, rel)); } catch { return false; }
}

function topLevel(root) {
  try { return fs.readdirSync(root); } catch { return []; }
}

function realTestScript(script) {
  return typeof script === 'string' && script.trim() && !/no test specified/i.test(script);
}

/**
 * Detect the project's stack, a default test command, name and description. Never throws on odd files.
 * @returns {{stack: string[], testCommand: string, name: string, description: string}}
 */
export function detectStack(root) {
  const stack = [];
  const tests = [];
  let name = path.basename(root);
  let description = '';
  const names = topLevel(root);

  if (exists(root, 'package.json')) {
    stack.push('node');
    let pkg = {};
    try { pkg = readJson(path.join(root, 'package.json')); } catch { /* unreadable package.json: still node */ }
    if (typeof pkg.name === 'string' && pkg.name) name = pkg.name.replace(/^@[^/]+\//, '');
    if (typeof pkg.description === 'string') description = pkg.description;
    if (realTestScript(pkg.scripts?.test)) {
      const runner = exists(root, 'pnpm-lock.yaml') ? 'pnpm' : exists(root, 'yarn.lock') ? 'yarn' : 'npm';
      tests.push(`${runner} test`);
    }
  }
  if (['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'].some((f) => exists(root, f))) {
    stack.push('python');
    tests.push('python -m pytest -q');
  }
  if (exists(root, 'go.mod')) { stack.push('go'); tests.push('go test ./...'); }
  if (exists(root, 'Cargo.toml')) { stack.push('rust'); tests.push('cargo test'); }
  if (exists(root, 'pom.xml')) { stack.push('java'); tests.push('mvn -q test'); }
  if (['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'].some((f) => exists(root, f))) {
    if (!stack.includes('java')) stack.push('java');
    tests.push(exists(root, 'gradlew') ? './gradlew test' : 'gradle test');
  }
  if (names.some((n) => /\.(csproj|sln|fsproj)$/i.test(n))) { stack.push('dotnet'); tests.push('dotnet test'); }
  if (exists(root, 'Gemfile')) { stack.push('ruby'); tests.push('bundle exec rake test'); }
  if (exists(root, 'composer.json')) { stack.push('php'); tests.push('composer test'); }
  if (names.includes('Makefile') || names.includes('makefile')) {
    stack.push('make');
    try {
      const mk = fs.readFileSync(path.join(root, names.includes('Makefile') ? 'Makefile' : 'makefile'), 'utf8');
      if (/^test\s*:/m.test(mk)) tests.push('make test');
    } catch { /* ignore */ }
  }
  return { stack, testCommand: tests[0] || '', name, description };
}

/**
 * Which known agents are installed (CLI on PATH) or already present in the repo (dirs/files).
 * @returns {{id, label, bins: {bin: string, path: string}[], dirs: string[], files: string[], installed: boolean, present: boolean}[]}
 */
export function detectAgents(root, registry, env = process.env) {
  return registry.adapters.map((a) => {
    const bins = [];
    for (const b of a.detect.bins || []) {
      const p = findOnPath(b, env, root);
      if (p) bins.push({ bin: b, path: p });
    }
    const dirs = (a.detect.dirs || []).filter((d) => exists(root, d));
    const files = (a.detect.files || []).filter((f) => exists(root, f));
    return { id: a.id, label: a.label, bins, dirs, files, installed: bins.length > 0, present: dirs.length + files.length > 0 };
  });
}

/** Extra tools (gh, code, ...) found on PATH, for `doctor` and `agents list`. */
export function detectTools(root, env = process.env) {
  const out = {};
  for (const b of DETECT_BINS) {
    const p = findOnPath(b, env, root);
    if (p) out[b] = p;
  }
  return out;
}

/**
 * Choose roster entries. `spec`: `auto` (detected agents; padded to two with claude/codex), `all`, or `a,b,c` (explicit, never padded).
 * Unknown ids become `custom` agents. Guarantees one orchestrator.
 * @returns {{agents: object[], padded: string[]}}
 */
export function selectRoster(registry, detected, spec = 'auto', { ensureOrchestrator = true } = {}) {
  const ids = [];
  const padded = [];
  const push = (id) => { if (!ids.includes(id)) ids.push(id); };
  const s = String(spec || 'auto').trim().toLowerCase();
  if (s === 'all') registry.adapters.forEach((a) => push(a.id));
  else if (s === 'auto') {
    const found = detected.filter((d) => d.installed || d.present).map((d) => d.id);
    // claude first (orchestrator), then the registry order
    for (const id of ['claude', ...registry.adapters.map((a) => a.id)]) if (found.includes(id)) push(id);
    for (const id of ['claude', 'codex']) if (ids.length < 2 && !ids.includes(id)) { push(id); padded.push(id); }
  } else {
    for (const part of s.split(',').map((x) => x.trim()).filter(Boolean)) {
      if (!AGENT_ID_RE.test(part) || RESERVED_AGENTS.includes(part)) throw new BatonError(`invalid agent id "${part}" in --agents`, { code: 'BAD_AGENT' });
      push(part);
    }
    if (!ids.length) throw new BatonError('--agents is empty', { code: 'BAD_AGENT' });
  }
  const agents = ids.map((id) => defaultAgentFor(registry, id));
  if (ensureOrchestrator && !agents.some((a) => a.roles.includes('orchestrator'))) agents[0].roles = ['orchestrator', ...agents[0].roles];
  return { agents, padded };
}
