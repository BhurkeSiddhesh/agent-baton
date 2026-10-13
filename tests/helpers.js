import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(REPO, 'bin', 'baton.js');

const SCRUB = ['BATON_AGENT', 'BATON_ROOT', 'BATON_NOW', 'BATON_DEBUG'];

/** Environment for child processes: the real one minus baton variables, plus fixed git identity. */
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of SCRUB) delete env[k];
  Object.assign(env, {
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
    GIT_CONFIG_NOSYSTEM: '1',
  }, extra);
  return env;
}

/** Sample roster/config. `over` is shallow-merged. */
export function sampleConfig(over = {}) {
  return {
    version: 1,
    project: { name: 'sample', description: '', stack: ['node'] },
    orchestrator: 'claude',
    agents: [
      { id: 'claude', name: 'Claude', kind: 'claude', roles: ['orchestrator', 'worker', 'reviewer', 'auditor'], strengths: ['architecture', 'review'] },
      { id: 'codex', name: 'Codex', kind: 'codex', roles: ['worker', 'reviewer', 'auditor'], strengths: ['backend', 'tests'] },
      { id: 'gemini', name: 'Gemini', kind: 'gemini', roles: ['worker', 'reviewer'], strengths: ['frontend'] },
    ],
    test: { command: 'node -e "process.exit(0)"', required: true, timeoutSeconds: 60 },
    protected: { globs: [] },
    coordination: [],
    lease: { hours: 8 },
    escalateAfterRejections: 2,
    requireDifferentReviewer: true,
    branches: { main: 'main', trackPrefix: 'track/', packetPrefix: 'baton/' },
    guard: { mode: 'warn' },
    ledger: { mirror: true },
    runtime: { vendored: true, command: 'node .baton/runtime/bin/baton.js' },
    ...over,
  };
}

/**
 * Sample plan: tracks api (codex) and ui (gemini); WP-001 (api) <- WP-002 (api, same track dep);
 * WP-003 (ui, deps WP-001 cross-track); WP-004 gated by G1. Reviewers rotate.
 */
export function samplePlan(over = {}) {
  return {
    version: 1,
    goal: 'Ship the sample',
    tracks: [
      { id: 'api', owner: 'codex', theme: 'API', owns: ['src/api/', 'tests/api/'] },
      { id: 'ui', owner: 'gemini', theme: 'UI', owns: ['src/ui/', 'tests/ui/'] },
    ],
    gates: [{ id: 'G1', title: 'Prod key provisioned', owner: 'human', open: false }],
    milestones: [{ id: 'M1', title: 'Alpha', due: '2026-11-01' }],
    packets: [
      { id: 'WP-001', title: 'Exporter', track: 'api', agent: 'codex', reviewer: 'claude', owns: ['src/api/export.js', 'tests/api/export.test.js'], deps: [], priority: 'P0', milestone: 'M1', done_checks: ['tests green'] },
      { id: 'WP-002', title: 'Export route', track: 'api', agent: 'codex', reviewer: 'claude', owns: ['src/api/route.js'], deps: ['WP-001'], priority: 'P1', milestone: 'M1' },
      { id: 'WP-003', title: 'Export button', track: 'ui', agent: 'gemini', reviewer: 'codex', owns: ['src/ui/button.js'], deps: ['WP-001'], priority: 'P1', milestone: 'M1' },
      { id: 'WP-004', title: 'Prod rollout', track: 'api', agent: 'codex', reviewer: 'claude', owns: ['src/api/rollout.js'], deps: [], gate: 'G1', priority: 'P2', milestone: 'M1' },
    ],
    ...over,
  };
}

/**
 * Create a temp directory (optionally a git repo with one commit) and return helpers.
 * @param {{git?: boolean, files?: Record<string,string>, config?: object|true, plan?: object|true, commit?: boolean}} [o]
 *   config/plan: pass an object, or `true` for the samples; they are written to .baton/.
 */
export function makeTempRepo({ git = false, files = {}, config, plan, commit = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'baton-test-')));
  const write = (rel, text) => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  const run = (...args) => {
    const r = spawnSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: root, encoding: 'utf8', env: cleanEnv() });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  if (config) write('.baton/config.json', JSON.stringify(config === true ? sampleConfig() : config, null, 2) + '\n');
  if (plan) write('.baton/plan.json', JSON.stringify(plan === true ? samplePlan() : plan, null, 2) + '\n');
  if (git) {
    run('init', '-q');
    run('symbolic-ref', 'HEAD', 'refs/heads/main');
    run('config', 'user.name', 'Test');
    run('config', 'user.email', 'test@example.com');
    run('config', 'commit.gpgsign', 'false');
    if (commit) {
      write('README.md', '# temp\n');
      run('add', '-A');
      run('commit', '-q', '-m', 'init');
    }
  }
  return {
    root,
    write,
    read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    git: run,
    commitAll: (msg = 'wip') => { run('add', '-A'); run('commit', '-q', '-m', msg); return run('rev-parse', 'HEAD'); },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
  };
}

/**
 * Run the real CLI in a child process.
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string,string>} [env] extra environment (e.g. BATON_AGENT, BATON_NOW)
 * @returns {{status: number|null, stdout: string, stderr: string}}
 */
export function runCli(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: cleanEnv(env) });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Run a node script (path + args) in a child process. */
export function runNode(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', env: cleanEnv(env) });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
