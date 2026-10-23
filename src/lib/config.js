import fs from 'node:fs';
import path from 'node:path';
import { BatonError } from './errors.js';
import { readJson, writeJsonAtomic, toPosix } from './util.js';
import { repoRoot } from './git.js';

export const ROLES = ['orchestrator', 'worker', 'reviewer', 'auditor'];
export const RESERVED_AGENTS = ['human', 'harness'];
export const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
export const GUARD_MODES = ['off', 'warn', 'block'];

export const PERMISSION_PROFILES = {
  'read-only': {
    description: 'Read-only access; no workspace file modifications, shell or network',
    allowWrite: false,
    allowShell: false,
    allowNetwork: false,
    privileged: false,
  },
  'review-only': {
    description: 'Reviewer access; only findings and verdict events, no source tree edits',
    allowWrite: false,
    allowShell: false,
    allowNetwork: false,
    privileged: false,
  },
  'workspace-write': {
    description: 'Standard worker access; scoped writes to owned packet paths',
    allowWrite: true,
    allowShell: true,
    allowNetwork: false,
    privileged: false,
  },
  'privileged': {
    description: 'Orchestrator and admin access; full plan, config and workspace authority',
    allowWrite: true,
    allowShell: true,
    allowNetwork: true,
    privileged: true,
  },
};

export function configPath(root) { return path.join(root, '.baton', 'config.json'); }
export function planPath(root) { return path.join(root, '.baton', 'plan.json'); }

/**
 * Repo root: BATON_ROOT if set, else the nearest ancestor of cwd containing .baton/config.json,
 * else the git top level, else cwd. Always an absolute native path.
 */
export function findRoot(cwd = process.cwd(), env = process.env) {
  if (env && env.BATON_ROOT) return path.resolve(env.BATON_ROOT);
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(configPath(dir))) return dir;
    // a git boundary ends the walk: a nested repository or submodule is its own project, never its parent's
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const top = repoRoot(cwd);
  return top ? path.resolve(top) : path.resolve(cwd);
}

function normAgent(a) {
  return {
    ...a,
    id: a.id,
    name: a.name ?? a.id,
    kind: a.kind ?? 'custom',
    roles: Array.isArray(a.roles) ? a.roles : ['worker', 'reviewer'],
    strengths: Array.isArray(a.strengths) ? a.strengths : [],
    github: a.github ?? null,
  };
}

/**
 * Build a complete config object.
 * @param {{name?: string, description?: string, stack?: string[], orchestrator?: string, agents?: any[],
 *          testCommand?: string, testRequired?: boolean, runtimeVendored?: boolean}} [opts]
 */
export function defaultConfig(opts = {}) {
  const agents = (opts.agents && opts.agents.length ? opts.agents : [
    { id: 'claude', name: 'Claude', kind: 'claude', roles: ['orchestrator', 'worker', 'reviewer', 'auditor'], strengths: ['architecture', 'security', 'review'] },
    { id: 'codex', name: 'Codex', kind: 'codex', roles: ['worker', 'reviewer', 'auditor'], strengths: ['backend', 'tests', 'integration'] },
  ]).map(normAgent);
  const vendored = opts.runtimeVendored !== false;
  return {
    version: 1,
    project: { name: opts.name ?? 'project', description: opts.description ?? '', stack: opts.stack ?? [] },
    orchestrator: opts.orchestrator ?? agents.find((a) => a.roles.includes('orchestrator'))?.id ?? agents[0].id,
    agents,
    test: { command: opts.testCommand ?? 'npm test', required: opts.testRequired !== false, timeoutSeconds: 900 },
    protected: { globs: [] },
    coordination: [],
    lease: { hours: 8 },
    escalateAfterRejections: 2,
    requireDifferentReviewer: true,
    branches: { main: 'main', trackPrefix: 'track/', packetPrefix: 'baton/' },
    guard: { mode: 'warn' },
    ledger: { mirror: true },
    runtime: { vendored, command: vendored ? 'node .baton/runtime/bin/baton.js' : 'baton' },
  };
}

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function mergeDefaults(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = k in base && isObj(base[k]) && isObj(over[k]) ? mergeDefaults(base[k], over[k]) : over[k];
  return out;
}

/**
 * Check a config object. Returns {errors, warnings} (arrays of strings); never throws.
 * @param {any} cfg
 */
export function validateConfig(cfg) {
  const errors = [];
  const warnings = [];
  if (!isObj(cfg)) return { errors: ['config must be a JSON object'], warnings };
  if (cfg.version !== 1) errors.push(`config.version must be 1 (got ${JSON.stringify(cfg.version)})`);
  if (!isObj(cfg.project) || typeof cfg.project.name !== 'string' || !cfg.project.name) errors.push('config.project.name must be a non-empty string');
  if (!Array.isArray(cfg.agents) || !cfg.agents.length) errors.push('config.agents must be a non-empty array');
  else {
    const seen = new Set();
    for (const a of cfg.agents) {
      if (!isObj(a) || typeof a.id !== 'string' || !AGENT_ID_RE.test(a.id)) { errors.push(`agent id must match ${AGENT_ID_RE}: ${JSON.stringify(a?.id)}`); continue; }
      if (RESERVED_AGENTS.includes(a.id)) errors.push(`agent id "${a.id}" is reserved`);
      if (seen.has(a.id)) errors.push(`duplicate agent id "${a.id}"`);
      seen.add(a.id);
      if (!Array.isArray(a.roles) || !a.roles.length) errors.push(`agent ${a.id}: roles must be a non-empty array`);
      else for (const r of a.roles) if (!ROLES.includes(r)) errors.push(`agent ${a.id}: unknown role "${r}" (one of ${ROLES.join(', ')})`);
    }
    const orch = cfg.agents.find((a) => a?.id === cfg.orchestrator);
    if (!orch) errors.push(`config.orchestrator "${cfg.orchestrator}" is not in the roster`);
    else if (!orch.roles?.includes('orchestrator')) warnings.push(`orchestrator "${cfg.orchestrator}" lacks the orchestrator role`);
  }
  if (!isObj(cfg.test) || typeof cfg.test.command !== 'string') errors.push('config.test.command must be a string');
  else if (!cfg.test.command.trim()) warnings.push('config.test.command is empty: verify cannot run tests');
  if (!isObj(cfg.lease) || !(cfg.lease.hours > 0)) errors.push('config.lease.hours must be a positive number');
  if (!Number.isInteger(cfg.escalateAfterRejections) || cfg.escalateAfterRejections < 1) errors.push('config.escalateAfterRejections must be an integer >= 1');
  if (!isObj(cfg.guard) || !GUARD_MODES.includes(cfg.guard.mode)) errors.push(`config.guard.mode must be one of ${GUARD_MODES.join('|')}`);
  for (const k of ['coordination']) if (!Array.isArray(cfg[k])) errors.push(`config.${k} must be an array`);
  if (!isObj(cfg.protected) || !Array.isArray(cfg.protected.globs)) errors.push('config.protected.globs must be an array');
  if (cfg.security && isObj(cfg.security)) {
    if (cfg.security.profiles) {
      if (!isObj(cfg.security.profiles)) {
        errors.push('config.security.profiles must be an object');
      } else {
        for (const [name, prof] of Object.entries(cfg.security.profiles)) {
          if (!isObj(prof)) {
            errors.push(`config.security.profiles.${name} must be an object`);
            continue;
          }
          if (prof.isolation === 'kernel' || prof.isolation === 'network' || prof.sandbox === 'os') {
            errors.push(`config.security.profiles.${name}: unsupported isolation "${prof.isolation || prof.sandbox}"; Baton runs in user space without kernel/network sandboxing`);
          }
        }
      }
    }
  }
  return { errors, warnings };
}

/**
 * Read .baton/config.json merged over the defaults. Throws BatonError when missing, corrupt or (unless
 * `validate: false`) invalid.
 * @param {string} root
 * @param {{validate?: boolean}} [opts]
 */
export function loadConfig(root, { validate = true } = {}) {
  const file = configPath(root);
  if (!fs.existsSync(file)) {
    throw new BatonError(`not a baton project: ${toPosix(file)} is missing`, { code: 'NOT_INIT', hint: 'run "baton init" first' });
  }
  const raw = readJson(file);
  const cfg = isObj(raw) ? mergeDefaults(defaultConfig({ agents: raw.agents }), raw) : raw;
  if (isObj(cfg) && Array.isArray(cfg.agents)) cfg.agents = cfg.agents.map((a) => (isObj(a) ? normAgent(a) : a));
  if (validate) {
    const { errors } = validateConfig(cfg);
    if (errors.length) throw new BatonError(`invalid .baton/config.json:\n  - ${errors.join('\n  - ')}`, { code: 'BAD_CONFIG' });
  }
  return cfg;
}

export function saveConfig(root, cfg) {
  writeJsonAtomic(configPath(root), cfg);
}

/** Roster helpers. */
export function agentIds(cfg) { return (cfg.agents || []).map((a) => a.id); }
export function getAgent(cfg, id) { return (cfg.agents || []).find((a) => a.id === id) || null; }
export function hasRole(cfg, id, role) { return !!getAgent(cfg, id)?.roles.includes(role); }
export function isKnownActor(cfg, id) { return RESERVED_AGENTS.includes(id) || !!getAgent(cfg, id); }
