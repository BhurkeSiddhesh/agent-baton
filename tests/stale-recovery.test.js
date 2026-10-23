import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRepo } from './helpers.js';
import { main } from '../src/cli.js';
import { memoryStream } from '../src/lib/context.js';
import { git, gitOut } from '../src/lib/git.js';
import { readEvents } from '../src/lib/store.js';
import { readVerifyMarker } from '../src/lib/engine.js';

delete process.env.BATON_AGENT;
delete process.env.BATON_ROOT;
delete process.env.BATON_NOW;

const repos = [];
afterEach(() => { while (repos.length) repos.pop().cleanup(); delete process.env.BATON_NOW; });

async function cli(cwd, args, now) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  if (now) process.env.BATON_NOW = now;
  try {
    const status = await main(args, { cwd, env: {}, stdout, stderr });
    return { status, stdout: stdout.text(), stderr: stderr.text() };
  } finally {
    if (now) delete process.env.BATON_NOW;
  }
}
const json = (r) => JSON.parse(r.stdout);
function repo(opts = {}) {
  const r = makeTempRepo({ git: true, config: true, plan: true, ...opts });
  repos.push(r);
  return r;
}

test('BAT-032: differentiate fresh lease from confirmed crashed process via --crashed-pid', async () => {
  const r = repo();
  // Start packet as codex
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'], '2026-10-23T10:00:00Z');

  // Attempting to reclaim while lease is fresh and no pid given throws NOT_STALE
  const fresh = await cli(r.root, ['reclaim', 'WP-001', '--agent', 'gemini'], '2026-10-23T11:00:00Z');
  assert.equal(fresh.status, 1);
  assert.match(fresh.stderr, /not stale/i);

  // Attempting to reclaim with living PID (current process) throws PROCESS_ALIVE
  const alivePid = process.pid;
  const aliveAttempt = await cli(r.root, ['reclaim', 'WP-001', '--agent', 'gemini', '--crashed-pid', String(alivePid)], '2026-10-23T11:00:00Z');
  assert.equal(aliveAttempt.status, 1);
  assert.match(aliveAttempt.stderr, /process \d+ is still alive/i);

  // Reclaim with confirmed dead PID (e.g. 99999999) succeeds immediately despite fresh lease
  const deadPid = 99999999;
  const crashedReclaim = await cli(r.root, ['reclaim', 'WP-001', '--agent', 'gemini', '--crashed-pid', String(deadPid), '--json'], '2026-10-23T11:00:00Z');
  assert.equal(crashedReclaim.status, 0, crashedReclaim.stderr);
  const data = json(crashedReclaim);
  assert.equal(data.packet, 'WP-001');
  assert.equal(data.agent, 'gemini');
  assert.equal(data.recoveredFrom, 'codex');
  assert.equal(data.leaseToken, 2);

  // Event audit trail shows crashed_pid recorded
  const events = readEvents(r.root);
  const beginEv = events.find((e) => e.packet === 'WP-001' && e.kind === 'begin' && e.by === 'gemini');
  assert.ok(beginEv);
  assert.equal(beginEv.data.crashed_pid, deadPid);
  assert.equal(beginEv.data.recovered_from, 'codex');
});

test('BAT-032: preserve uncommitted work (dirty changes and untracked files) to rescue ref without data loss', async () => {
  const r = repo();
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'], '2026-10-23T10:00:00Z');

  // Codex writes dirty changes (tracked and untracked)
  r.write('src/api/export.js', '// valuable uncommitted work\n');
  r.write('src/api/helper.js', '// untracked new file\n');

  // Lease expires
  const rec = await cli(r.root, ['reclaim', 'WP-001', '--agent', 'gemini', '--json'], '2026-10-23T20:00:00Z');
  assert.equal(rec.status, 0, rec.stderr);
  const recJson = json(rec);
  assert.ok(recJson.rescueRef, 'expected rescueRef in output');

  // Verify rescue ref exists in git
  const show = gitOut(r.root, ['show', '--stat', recJson.rescueRef]);
  assert.ok(show, 'rescue ref should be queryable in git');
  assert.match(show, /export\.js/);

  // Verify working directory still has the files untouched for gemini to continue
  assert.equal(fs.readFileSync(path.join(r.root, 'src', 'api', 'export.js'), 'utf8'), '// valuable uncommitted work\n');
  assert.equal(fs.readFileSync(path.join(r.root, 'src', 'api', 'helper.js'), 'utf8'), '// untracked new file\n');
});

test('BAT-032: fencing token blocks stale agent from submitting or sending heartbeats', async () => {
  const r = repo();
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'], '2026-10-23T10:00:00Z');
  r.write('src/api/export.js', '// work\n');
  await cli(r.root, ['verify', 'WP-001']);

  // Lease expires and gemini reclaims
  const rec = await cli(r.root, ['reclaim', 'WP-001', '--agent', 'gemini'], '2026-10-23T20:00:00Z');
  assert.equal(rec.status, 0, rec.stderr);

  // Codex (the stale agent) attempts to submit
  const codexSubmit = await cli(r.root, ['submit', 'WP-001', '--agent', 'codex'], '2026-10-23T20:05:00Z');
  assert.equal(codexSubmit.status, 1);
  assert.match(codexSubmit.stderr, /held by gemini.*cannot submit/i);

  // Codex attempts to heartbeat
  const codexHb = await cli(r.root, ['heartbeat', 'WP-001', '--agent', 'codex'], '2026-10-23T20:05:00Z');
  assert.equal(codexHb.status, 1);
  assert.match(codexHb.stderr, /held by gemini/i);
});

test('BAT-032: reclaimed packet requires fresh verification before submit', async () => {
  const r = repo();
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'], '2026-10-23T10:00:00Z');
  r.write('src/api/export.js', '// work\n');
  // Codex verified under lease token 1
  await cli(r.root, ['verify', 'WP-001']);

  // Lease expires and gemini reclaims
  await cli(r.root, ['reclaim', 'WP-001', '--agent', 'gemini'], '2026-10-23T20:00:00Z');

  // Verify marker must have been cleared
  assert.equal(readVerifyMarker(r.root, 'WP-001'), null);

  // Gemini cannot submit immediately without fresh verify
  const subAttempt = await cli(r.root, ['submit', 'WP-001', '--agent', 'gemini'], '2026-10-23T20:01:00Z');
  assert.equal(subAttempt.status, 1);
  assert.match(subAttempt.stderr, /run "baton verify WP-001" successfully before requesting review|no passing verify marker/i);

  // After gemini runs verify, submit succeeds
  const v = await cli(r.root, ['verify', 'WP-001']);
  assert.equal(v.status, 0, v.stderr);
  const sub = await cli(r.root, ['submit', 'WP-001', '--agent', 'gemini']);
  assert.equal(sub.status, 0, sub.stderr);
});

test('BAT-032: reclaim with --reassign reassigns author with audit evidence', async () => {
  const r = repo();
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'], '2026-10-23T10:00:00Z');

  // Orchestrator reclaims and reassigns to gemini
  const re = await cli(r.root, ['reclaim', 'WP-001', '--agent', 'claude', '--reassign', 'gemini', '--json'], '2026-10-23T20:00:00Z');
  assert.equal(re.status, 0, re.stderr);
  const data = json(re);
  assert.equal(data.agent, 'gemini');
  assert.equal(data.recoveredFrom, 'codex');

  const events = readEvents(r.root);
  const beginEv = events.find((e) => e.packet === 'WP-001' && e.kind === 'begin' && e.by === 'gemini');
  assert.ok(beginEv);
  assert.equal(beginEv.data.recovery_mode, 'reassign');
  assert.equal(beginEv.data.recovered_from, 'codex');
  assert.match(beginEv.note, /reassigned to gemini/i);
});

test('BAT-032: handoff of in-progress packet clears verify marker and releases to BLOCKED', async () => {
  const r = repo();
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'], '2026-10-23T10:00:00Z');
  r.write('src/api/export.js', '// work\n');
  await cli(r.root, ['verify', 'WP-001']);

  // Handoff to gemini
  const ho = await cli(r.root, ['handoff', 'WP-001', '--by', 'codex', '--to', 'gemini', '--json']);
  assert.equal(ho.status, 0, ho.stderr);
  assert.equal(json(ho).released, true);
  assert.equal(json(ho).status, 'BLOCKED');

  // Verify marker is cleared
  assert.equal(readVerifyMarker(r.root, 'WP-001'), null);

  // Gemini must begin and verify before submitting
  await cli(r.root, ['begin', 'WP-001', '--agent', 'gemini']);
  const subWithoutVerify = await cli(r.root, ['submit', 'WP-001', '--agent', 'gemini']);
  assert.equal(subWithoutVerify.status, 1);
  assert.match(subWithoutVerify.stderr, /run "baton verify WP-001" successfully before requesting review|no passing verify marker/i);

  await cli(r.root, ['verify', 'WP-001']);
  const sub = await cli(r.root, ['submit', 'WP-001', '--agent', 'gemini']);
  assert.equal(sub.status, 0, sub.stderr);
});
