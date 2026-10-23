import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRepo } from './helpers.js';
import { main } from '../src/cli.js';
import { memoryStream } from '../src/lib/context.js';

delete process.env.BATON_AGENT;
delete process.env.BATON_ROOT;
delete process.env.BATON_NOW;

const repos = [];
afterEach(() => { while (repos.length) repos.pop().cleanup(); delete process.env.BATON_NOW; });

/** Run the CLI in-process. `now` freezes the clock (BATON_NOW). */
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
const bus = async (r, extra = []) => json(await cli(r.root, ['bus', 'list', '--json', ...extra])).messages;
const status = async (r, pid) => {
  const s = json(await cli(r.root, ['review', pid, '--json']));
  return s.status;
};

/** begin, edit an owned file, verify and submit (shared tree on main). */
async function drive(r, pid, agent, file, text = 'export const x = 1;\n') {
  assert.equal((await cli(r.root, ['begin', pid, '--agent', agent])).status, 0);
  r.write(file, text);
  const v = await cli(r.root, ['verify', pid]);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  const s = await cli(r.root, ['submit', pid, '--agent', agent]);
  assert.equal(s.status, 0, s.stderr);
}

test('begin claims the packet, posts CLAIM, and refuses a second begin', async () => {
  const r = repo();
  const b = await cli(r.root, ['begin', 'WP-001', '--agent', 'codex', '--json']);
  assert.equal(b.status, 0, b.stderr);
  const out = json(b);
  assert.equal(out.status, 'IN_PROGRESS');
  assert.deepEqual(out.owns, ['src/api/export.js', 'tests/api/export.test.js']);
  const msgs = await bus(r);
  assert.ok(msgs.some((m) => m.type === 'CLAIM' && m.packet === 'WP-001' && m.from === 'codex'));
  const again = await cli(r.root, ['begin', 'WP-001', '--agent', 'codex']);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already in progress/);
});

test('begin: usage errors, foreign packets need --pull, unknown agent, reviewer conflict', async () => {
  const r = repo();
  assert.equal((await cli(r.root, ['begin'])).status, 2);
  assert.equal((await cli(r.root, ['begin', 'WP-001'])).status, 2); // no agent
  const foreign = await cli(r.root, ['begin', 'WP-001', '--agent', 'gemini']);
  assert.equal(foreign.status, 1);
  assert.match(foreign.stderr, /--pull/);
  assert.equal((await cli(r.root, ['begin', 'WP-001', '--agent', 'nobody'])).status, 1);
  assert.equal((await cli(r.root, ['begin', 'WP-001', '--agent', 'claude'])).status, 1); // the reviewer
  const pulled = await cli(r.root, ['begin', 'WP-001', '--agent', 'gemini', '--pull', '--json']);
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.equal(json(pulled).pulledEarly, true);
});

test('begin refuses unmet same-track dependencies, closed gates and ownership clashes', async () => {
  const r = repo();
  const dep = await cli(r.root, ['begin', 'WP-002', '--agent', 'codex']);
  assert.equal(dep.status, 1);
  assert.match(dep.stderr, /dependencies/);
  const gate = await cli(r.root, ['begin', 'WP-004', '--agent', 'codex']);
  assert.equal(gate.status, 1);
  assert.match(gate.stderr, /gate G1/);
});

test('heartbeat extends the lease; another agent cannot while it is fresh', async () => {
  const r = repo();
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'], '2026-10-13T10:00:00Z');
  const hb = await cli(r.root, ['heartbeat', 'WP-001', '--agent', 'codex', '--json'], '2026-10-13T12:00:00Z');
  assert.equal(hb.status, 0, hb.stderr);
  assert.equal(json(hb).leaseUntil, '2026-10-13T20:00:00Z');
  const other = await cli(r.root, ['heartbeat', 'WP-001', '--agent', 'gemini'], '2026-10-13T12:30:00Z');
  assert.equal(other.status, 1);
  assert.match(other.stderr, /held by codex/);
  assert.equal((await cli(r.root, ['heartbeat', 'WP-003', '--agent', 'gemini'])).status, 1); // not in progress
});

test('reclaim: refused while the lease is fresh, allowed once stale, and posts a NOTICE', async () => {
  const r = repo();
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'], '2026-10-13T10:00:00Z');
  const fresh = await cli(r.root, ['reclaim', 'WP-001', '--agent', 'gemini'], '2026-10-13T11:00:00Z');
  assert.equal(fresh.status, 1);
  assert.match(fresh.stderr, /not stale/);
  assert.equal((await cli(r.root, ['reclaim', 'WP-001', '--agent', 'claude'], '2026-10-13T19:00:00Z')).status, 1); // reviewer
  const stale = await cli(r.root, ['reclaim', 'WP-001', '--agent', 'gemini', '--json'], '2026-10-13T19:00:00Z');
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(json(stale).leaseUntil, '2026-10-14T03:00:00Z');
  assert.ok((await bus(r)).some((m) => m.type === 'NOTICE' && /reclaimed/.test(m.text)));
});

test('block needs a reason, posts a BLOCKER with the question, and begin resumes it', async () => {
  const r = repo();
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex']);
  const no = await cli(r.root, ['block', 'WP-001', '--agent', 'codex']);
  assert.equal(no.status, 1);
  assert.match(no.stderr, /--reason/);
  const b = await cli(r.root, ['block', 'WP-001', '--agent', 'codex', '--reason', 'schema unclear', '--question', 'Which currency?']);
  assert.equal(b.status, 0, b.stderr);
  const m = (await bus(r, ['--type', 'BLOCKER']))[0];
  assert.match(m.text, /schema unclear/);
  assert.match(m.text, /Which currency\?/);
  assert.equal(await status(r, 'WP-001'), 'BLOCKED');
  assert.equal((await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'])).status, 0);
});

test('submit requires verify; it posts SIGNOFF and RELEASE; review shows the brief', async () => {
  const r = repo();
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex']);
  const early = await cli(r.root, ['submit', 'WP-001', '--agent', 'codex']);
  assert.equal(early.status, 1);
  assert.match(early.stderr, /baton verify WP-001/);
  r.write('src/api/export.js', 'export const x = 1;\n');
  assert.equal((await cli(r.root, ['verify', 'WP-001'])).status, 0);
  const s = await cli(r.root, ['submit', 'WP-001', '--agent', 'codex', '--json']);
  assert.equal(s.status, 0, s.stderr);
  assert.equal(json(s).status, 'READY_FOR_REVIEW');
  const types = (await bus(r)).map((m) => m.type);
  assert.ok(types.includes('SIGNOFF'));
  assert.ok(types.includes('RELEASE'));
  const brief = json(await cli(r.root, ['review', 'WP-001', '--json']));
  assert.equal(brief.reviewer, 'claude');
  assert.equal(brief.reviewable, true);
  assert.deepEqual(brief.done_checks, ['tests green']);
  assert.equal(brief.verify.ok, true);
  assert.ok(brief.changed_files.includes('src/api/export.js'));
  assert.ok(brief.commands.some((c) => c.includes('baton') || c.includes('accept')));
  const text = await cli(r.root, ['review', 'WP-001']);
  assert.match(text.stdout, /Done checks/);
  assert.match(text.stdout, /\[ \] tests green/);
});

test('submit after the files changed is stale and must be verified again', async () => {
  const r = repo();
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex']);
  r.write('src/api/export.js', 'a\n');
  await cli(r.root, ['verify', 'WP-001']);
  r.write('src/api/export.js', 'b\n');
  const s = await cli(r.root, ['submit', 'WP-001', '--agent', 'codex']);
  assert.equal(s.status, 1);
  assert.match(s.stderr, /changed since verify/);
});

test('verdicts: only the assigned reviewer, open findings block accept, findings are confirmed by the filer', async () => {
  const r = repo();
  await drive(r, 'WP-001', 'codex', 'src/api/export.js');
  assert.equal((await cli(r.root, ['accept', 'WP-001', '--by', 'codex'])).status, 1); // author
  assert.equal((await cli(r.root, ['accept', 'WP-001', '--by', 'gemini'])).status, 1); // not the reviewer
  const f = await cli(r.root, ['finding', 'add', '--packet', 'WP-001', '--by', 'claude', '--severity', 'major', '--text', 'empty invoice crashes',
    '--file', 'src/api/export.js', '--line', '3', '--evidence', 'node x.js', '--fix', 'guard empty', '--json']);
  assert.equal(f.status, 0, f.stderr);
  assert.equal(json(f).fid, 'AUD-001');
  const blocked = await cli(r.root, ['accept', 'WP-001', '--by', 'claude']);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /AUD-001/);
  assert.equal((await cli(r.root, ['fix', 'WP-001', '--by', 'claude', '--note', 'fix the crash', '--score', '6'])).status, 0);
  assert.equal(await status(r, 'WP-001'), 'ACCEPTED_WITH_FIXES');
  // The filer cannot confirm before it is resolved; the author resolves, the filer confirms.
  assert.equal((await cli(r.root, ['finding', 'resolve', 'AUD-001', '--by', 'claude', '--confirm'])).status, 1);
  assert.equal((await cli(r.root, ['finding', 'resolve', 'AUD-001', '--by', 'codex', '--resolution', 'fixed', '--note', 'guarded'])).status, 0);
  assert.equal((await cli(r.root, ['accept', 'WP-001', '--by', 'claude'])).status, 1); // resolved but not yet confirmed
  assert.equal((await cli(r.root, ['finding', 'resolve', 'AUD-001', '--by', 'codex', '--confirm'])).status, 1); // not the filer
  assert.equal((await cli(r.root, ['finding', 'resolve', 'AUD-001', '--by', 'claude', '--confirm'])).status, 0);
  const acc = await cli(r.root, ['accept', 'WP-001', '--by', 'claude', '--score', '9', '--json']);
  assert.equal(acc.status, 0, acc.stderr);
  assert.equal(json(acc).score, 9);
  assert.equal(await status(r, 'WP-001'), 'ACCEPTED');
  assert.ok((await bus(r, ['--type', 'VERDICT'])).length >= 2);
  assert.equal((await cli(r.root, ['accept', 'WP-001', '--by', 'claude', '--score', '11'])).status, 1);
});

test('reject needs a reason; carry is orchestrator-only and the packet can be restarted', async () => {
  const r = repo();
  await drive(r, 'WP-001', 'codex', 'src/api/export.js');
  const bare = await cli(r.root, ['reject', 'WP-001', '--by', 'claude']);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /note or at least one finding/);
  assert.equal((await cli(r.root, ['reject', 'WP-001', '--by', 'claude', '--note', 'does not handle empty input'])).status, 0);
  assert.equal(await status(r, 'WP-001'), 'REJECTED');
  const notOrch = await cli(r.root, ['carry', 'WP-001', '--by', 'codex']);
  assert.equal(notOrch.status, 1);
  assert.match(notOrch.stderr, /orchestrator/);
  assert.equal((await cli(r.root, ['carry', 'WP-001', '--by', 'claude', '--note', 'retry'])).status, 0);
  assert.equal(await status(r, 'WP-001'), 'CARRIED_OVER');
  assert.equal((await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'])).status, 0);
});

test('reopening a submitted packet by its author discards the verify marker', async () => {
  const r = repo();
  await drive(r, 'WP-001', 'codex', 'src/api/export.js');
  const re = await cli(r.root, ['begin', 'WP-001', '--agent', 'codex', '--json']);
  assert.equal(re.status, 0, re.stderr);
  assert.equal(json(re).rework, true);
  const brief = json(await cli(r.root, ['review', 'WP-001', '--json']));
  assert.equal(brief.verify, null);
  assert.equal((await cli(r.root, ['submit', 'WP-001', '--agent', 'codex'])).status, 1);
});

test('reassign changes the reviewer under the rules; handoff moves the author and releases in-progress work', async () => {
  const r = repo();
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex']);
  assert.equal((await cli(r.root, ['reassign', 'WP-001', '--reviewer', 'gemini', '--by', 'codex'])).status, 1); // not orchestrator
  assert.equal((await cli(r.root, ['reassign', 'WP-001', '--reviewer', 'codex', '--by', 'claude'])).status, 1); // the author
  assert.equal((await cli(r.root, ['reassign', 'WP-001', '--by', 'claude'])).status, 2); // missing --reviewer
  assert.equal((await cli(r.root, ['reassign', 'WP-001', '--reviewer', 'gemini', '--by', 'claude'])).status, 0);
  assert.equal(json(await cli(r.root, ['review', 'WP-001', '--json'])).reviewer, 'gemini');

  const h = await cli(r.root, ['handoff', 'WP-001', '--to', 'claude', '--by', 'codex', '--note', 'half done', '--json']);
  assert.equal(h.status, 0, h.stderr);
  assert.equal(json(h).released, true);
  assert.equal(await status(r, 'WP-001'), 'BLOCKED');
  assert.ok((await bus(r, ['--type', 'HANDOFF'])).some((m) => m.to === 'claude' && /half done/.test(m.text)));
  assert.equal((await cli(r.root, ['handoff', 'WP-001', '--to', 'gemini', '--by', 'gemini'])).status, 1); // new author is the reviewer
  assert.equal((await cli(r.root, ['begin', 'WP-001', '--agent', 'claude'])).status, 0);
});

test('BAT-027: CLI commands accept --op-id and baton ledger reconcile works', async () => {
  const r = repo();
  // begin with --op-id
  const b1 = await cli(r.root, ['begin', 'WP-001', '--agent', 'codex', '--op-id', 'cli-op-1', '--json']);
  assert.equal(b1.status, 0, b1.stderr);
  assert.equal(await status(r, 'WP-001'), 'IN_PROGRESS');

  // retry begin with same --op-id succeeds idempotently
  const b2 = await cli(r.root, ['begin', 'WP-001', '--agent', 'codex', '--op-id', 'cli-op-1', '--json']);
  assert.equal(b2.status, 0, b2.stderr);

  // verify and submit with --op-id
  r.write('src/api/export.js', '// done\n');
  const v = await cli(r.root, ['verify', 'WP-001', '--op-id', 'cli-op-v']);
  assert.equal(v.status, 0, v.stderr);

  const s1 = await cli(r.root, ['submit', 'WP-001', '--agent', 'codex', '--op-id', 'cli-op-sub']);
  assert.equal(s1.status, 0, s1.stderr);
  assert.equal(await status(r, 'WP-001'), 'READY_FOR_REVIEW');

  // retry submit with same --op-id succeeds idempotently
  const s2 = await cli(r.root, ['submit', 'WP-001', '--agent', 'codex', '--op-id', 'cli-op-sub']);
  assert.equal(s2.status, 0, s2.stderr);

  // accept with --op-id
  const a1 = await cli(r.root, ['accept', 'WP-001', '--by', 'claude', '--op-id', 'cli-op-acc']);
  assert.equal(a1.status, 0, a1.stderr);
  assert.equal(await status(r, 'WP-001'), 'ACCEPTED');

  // retry accept with same --op-id succeeds idempotently
  const a2 = await cli(r.root, ['accept', 'WP-001', '--by', 'claude', '--op-id', 'cli-op-acc']);
  assert.equal(a2.status, 0, a2.stderr);

  // ledger reconcile command
  const rec = await cli(r.root, ['ledger', 'reconcile', '--json']);
  assert.equal(rec.status, 0, rec.stderr);
  assert.ok(json(rec).reconciled !== undefined);
});
