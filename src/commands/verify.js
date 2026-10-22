import { spawn, spawnSync } from 'node:child_process';
import { BatonError, UsageError } from '../lib/errors.js';
import { load, recordVerify } from '../lib/engine.js';
import { isGit, currentBranch, headCommit, mainRef, changedFiles, gitOk, gitOut, isDirty } from '../lib/git.js';
import { ownedBy, isProtected, isCoordination, BUILTIN_COORDINATION } from '../lib/glob.js';
import { scanFiles, scanHistory, formatSecretHit } from '../lib/secrets.js';
import { diffSnapshot, packetFingerprint } from '../lib/snapshot.js';
import { stamp, utcnow } from '../lib/util.js';

export const name = 'verify';
export const group = 'Execution';
export const summary = 'Scope guard, secret scan and tests; writes the verify marker';
export const usage = 'baton verify <packet> [--allow-shell] [--no-tests] [--json]';
export const description = [
  'Checks the files this packet changed against its owned paths (protected paths and other packets\' files are violations),',
  'scans them for secrets (plus commit history on a branch), runs the test command and records a verify marker and event.',
  'Scope modes: git-branch (HEAD on a non-main branch), git-shared (on main), snapshot (no git).',
  '"baton submit" needs a passing, current marker. --no-tests only checks scope and secrets and can never be submitted.',
  'Imported packet-specific test commands are untrusted; inspect them and pass --allow-shell to execute. Project-level configured tests retain their existing behavior.',
].join('\n');
export const options = {
  'allow-shell': { type: 'boolean', description: 'explicitly run a packet-defined shell test command' },
  'no-tests': { type: 'boolean', description: 'skip the test command (the result is never submittable)' },
  json: { type: 'boolean', description: 'print one JSON document' },
};

/** Files that only the orchestrator edits; in a shared tree they are tolerated, on a packet branch they are violations. */
const ORCHESTRATOR_FILES = ['.baton/plan.json', '.baton/config.json', '.baton/manifest.json'];

const TAIL_LINES = 20;
const TAIL_CHARS = 4000;

/** Last lines of test output, ANSI colour codes removed. */
export function tailOf(text) {
  const clean = String(text || '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/\r\n/g, '\n').trimEnd();
  const tail = clean.split('\n').slice(-TAIL_LINES).join('\n');
  return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail;
}

function killTree(child) {
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

/**
 * Run a command through the shell with a timeout; on timeout the whole process tree is killed.
 * @returns {Promise<{code: number|null, output: string, timedOut: boolean, error: string|null, ms: number}>}
 */
export function runShell(command, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let timedOut = false;
    let done = false;
    const finish = (code, error = null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, output, timedOut, error, ms: Date.now() - started });
    };
    let child;
    try {
      child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, output: '', timedOut: false, error: e.message, ms: 0 });
      return;
    }
    const add = (d) => {
      output += d.toString('utf8');
      if (output.length > 400000) output = output.slice(-200000); // keep the tail only
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      setTimeout(() => finish(null), 2000); // grandchildren may keep the pipes open
    }, timeoutMs);
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));
  });
}

function scopeMode(root, config) {
  if (!isGit(root)) return 'snapshot';
  const branch = currentBranch(root);
  const main = mainRef(root, config.branches?.main);
  if (branch && main && branch !== main) return 'git-branch';
  return 'git-shared';
}

/** Changed files and the (possibly downgraded) mode. */
function changedFor(root, pid, mode, base, config) {
  if (mode === 'snapshot') return { mode, files: diffSnapshot(root, pid), base: null };
  if (mode === 'git-shared') return { mode, files: changedFiles(root, base), base };
  // git-branch: exact since begin when the begin commit is still an ancestor, else relative to main (rebased work).
  if (base && gitOk(root, ['merge-base', '--is-ancestor', base, 'HEAD'])) return { mode, files: changedFiles(root, base), base };
  const main = mainRef(root, config.branches?.main);
  const mb = main ? gitOut(root, ['merge-base', main, 'HEAD']) : null;
  return { mode: 'git-branch-rebased', files: changedFiles(root, mb), base: mb };
}

/** Sort changed files into in-scope, coordination, foreign and violations. */
export function classify(files, packet, plan, config, mode) {
  const others = plan.packets.filter((q) => q.id !== packet.id);
  const r = { in_scope: [], coordination: [], foreign: [], out_of_scope: [], protected: [] };
  for (const f of files) {
    if (isProtected(f, config.protected?.globs || [])) { r.protected.push(f); r.out_of_scope.push(f); } else if (ownedBy(f, packet.owns)) r.in_scope.push(f);
    else if (isCoordination(f, config.coordination || [])) r.coordination.push(f);
    else if (ORCHESTRATOR_FILES.includes(f)) (mode.startsWith('git-branch') ? r.out_of_scope : r.coordination).push(f);
    else if (others.some((q) => ownedBy(f, q.owns))) (mode === 'git-branch' ? r.out_of_scope : r.foreign).push(f);
    else r.out_of_scope.push(f);
  }
  return r;
}

/**
 * Run the full verification for a packet and record the marker and event.
 * @returns {Promise<object>} the result written to the marker
 */
export async function verifyPacket(ctx, pid, { runTests = true, allowShell = false } = {}) {
  const root = ctx.root;
  const { config, plan, state } = load(root);
  const packet = plan.packets.find((p) => p.id === pid);
  if (!packet) throw new BatonError(`unknown packet ${pid}`, { code: 'UNKNOWN_PACKET' });
  const s = state.packets[pid];
  if (s.status !== 'IN_PROGRESS') throw new BatonError(`${pid} is ${s.status}; verify applies to IN_PROGRESS packets (run "baton begin ${pid}")`, { code: 'NOT_IN_PROGRESS' });

  const mode0 = scopeMode(root, config);
  const { mode, files, base } = changedFor(root, pid, mode0, s.base, config);
  const scope = classify(files, packet, plan, config, mode);
  const problems = [];

  const secrets = scanFiles(root, files).map(formatSecretHit);
  if (mode.startsWith('git-branch') && base) secrets.push(...scanHistory(root, base).map(formatSecretHit));

  const packetCommand = typeof packet.test === 'string' ? packet.test.trim() : '';
  const command = packetCommand || config.test?.command || '';
  const tests = { ran: false, ok: null, tail: '', command, exitCode: null, timedOut: false, ms: 0 };
  if (!runTests) {
    problems.push('tests not run (--no-tests): a sign-off needs a test run');
  } else if (!command) {
    if (config.test?.required === false) tests.ok = true;
    else problems.push('no test command configured (set test.command in .baton/config.json)');
  } else {
    if (packetCommand && !allowShell) {
      throw new UsageError('refusing untrusted packet test command; inspect packet.test in .baton/plan.json and pass --allow-shell to authorize this shell execution');
    }
    const secs = Number(config.test?.timeoutSeconds ?? 900);
    if (!Number.isFinite(secs) || secs < 1 || secs > 86400) {
      throw new UsageError('test.timeoutSeconds must be a finite number between 1 and 86400');
    }
    // Test commands are shell commands (possibly from an imported plan): say what runs before it runs.
    ctx.err(`baton: running ${packetCommand ? 'explicitly authorized packet SHELL' : 'configured project'} test command: ${command}`);
    const r = await runShell(command, { cwd: root, env: { ...process.env, ...ctx.env }, timeoutMs: secs * 1000 });
    tests.ran = true;
    tests.exitCode = r.code;
    tests.timedOut = r.timedOut;
    tests.ms = r.ms;
    tests.ok = r.code === 0 && !r.timedOut && !r.error;
    tests.tail = tailOf(r.output);
    if (r.timedOut) tests.tail = `${tests.tail}\ntests timed out after ${secs}s`.trim();
    if (r.error) tests.tail = `${tests.tail}\ncould not run the test command: ${r.error}`.trim();
  }
  if (tests.ran && !tests.ok) problems.push(tests.timedOut ? 'tests timed out' : `tests failed (exit ${tests.exitCode})`);

  // After the tests, so files they create count: the tree a reviewer sees must equal the tested tree.
  if (mode.startsWith('git-branch') && isDirty(root, { exclude: BUILTIN_COORDINATION })) {
    problems.push('uncommitted changes: commit first, so the tested tree is the reviewed commit');
  }
  if (scope.out_of_scope.length) problems.push(`${scope.out_of_scope.length} file(s) out of scope or protected`);
  if (secrets.length) problems.push(`${secrets.length} secret pattern hit(s)`);

  const ok = problems.length === 0 && tests.ok === true;
  const result = {
    packet: pid, ok, mode, base, commit: headCommit(root), fingerprint: packetFingerprint(root, packet.owns), fingerprint_kind: 'owned', ts: stamp(utcnow()),
    in_scope: scope.in_scope, coordination: scope.coordination, foreign_owned_unattributed: scope.foreign,
    out_of_scope: scope.out_of_scope, protected: scope.protected, secrets, problems, tests,
  };
  recordVerify(root, pid, result);
  return result;
}

const brief = (list, max = 12) => (list.length > max ? `${list.slice(0, max).join(', ')}, ... and ${list.length - max} more` : list.join(', '));

export function render(r) {
  const lines = [`Verify ${r.packet}: ${r.ok ? 'PASS' : 'FAIL'} (scope mode: ${r.mode})`];
  lines.push(`- Tests: ${r.tests.ran ? `${r.tests.ok ? 'passed' : 'FAILED'} (${r.tests.command})` : 'NOT RUN'}`);
  if (r.tests.tail) lines.push(...r.tests.tail.split('\n').slice(-5).map((l) => `    ${l}`));
  lines.push(`- Changed in scope (${r.in_scope.length}): ${brief(r.in_scope) || 'none'}`);
  if (r.coordination.length) lines.push(`- Coordination files: ${brief(r.coordination)}`);
  if (r.foreign_owned_unattributed.length) lines.push(`- Changed in other packets' paths (not attributed to you): ${brief(r.foreign_owned_unattributed)}`);
  if (r.out_of_scope.length) lines.push(`- OUT OF SCOPE or PROTECTED (revert, or post a REQUEST on the bus): ${brief(r.out_of_scope)}`);
  if (r.out_of_scope.some((f) => f.startsWith('.baton/') || f === 'AGENTS.md')) lines.push('- HINT: the baton install files are uncommitted; commit the init (and .baton/plan.json) before "begin" so they are not counted as your changes');
  if (r.secrets.length) lines.push(`- SECRET PATTERNS: ${r.secrets.join('; ')}`);
  for (const p of r.problems) lines.push(`- PROBLEM: ${p}`);
  return lines.join('\n');
}

export async function run(ctx, args) {
  const pid = args._[0];
  if (!pid) throw new UsageError(`missing packet id. Usage: ${usage}`);
  const r = await verifyPacket(ctx, pid, { runTests: !args['no-tests'], allowShell: Boolean(args['allow-shell']) });
  if (args.json) ctx.json(r);
  else ctx.out(render(r));
  // A scope-only check is informational: it is not "ok" (never submittable) but it did not find a violation.
  const onlyNoTests = args['no-tests'] && r.problems.length === 1;
  return r.ok || onlyNoTests ? 0 : 1;
}
