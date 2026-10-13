import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTempRepo } from './helpers.js';
import { main } from '../src/cli.js';
import { memoryStream } from '../src/lib/context.js';
import { readEvents } from '../src/lib/store.js';

delete process.env.BATON_AGENT;
delete process.env.BATON_ROOT;
delete process.env.BATON_NOW;

const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });

async function cli(cwd, args) {
  const stdout = memoryStream();
  const stderr = memoryStream();
  const status = await main(args, { cwd, env: {}, stdout, stderr });
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}
const json = (r) => JSON.parse(r.stdout);
function repo(opts = {}) {
  const r = makeTempRepo({ git: true, config: true, plan: true, ...opts });
  cleanups.push(() => r.cleanup());
  return r;
}
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-wt-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return d;
};

/** On track/api: begin WP-001, commit the work, verify, submit. Returns the submitted commit. */
async function submitOnBranch(r, pid = 'WP-001', agent = 'codex', file = 'src/api/export.js') {
  r.git('checkout', '-q', '-b', 'track/api');
  assert.equal((await cli(r.root, ['begin', pid, '--agent', agent])).status, 0);
  r.write(file, 'export const x = 1;\n');
  const commit = r.commitAll('work');
  const v = await cli(r.root, ['verify', pid]);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  const s = await cli(r.root, ['submit', pid, '--agent', agent]);
  assert.equal(s.status, 0, s.stderr);
  return commit;
}

// ---------------------------------------------------------------- worktrees

test('worktrees lists the tracks without creating anything', async () => {
  const r = repo();
  const base = tmpDir();
  const out = json(await cli(r.root, ['worktrees', '--base-dir', base, '--json']));
  assert.equal(out.main, 'main');
  assert.deepEqual(out.worktrees.map((w) => [w.track, w.branch, w.exists]), [['api', 'track/api', false], ['ui', 'track/ui', false]]);
  assert.equal(fs.readdirSync(base).length, 0);
  const text = await cli(r.root, ['worktrees', '--base-dir', base]);
  assert.match(text.stdout, /missing/);
  assert.match(text.stdout, /--create/);
});

test('worktrees --create makes one branch and directory per track, idempotently, sharing one ledger', async () => {
  const r = repo();
  const base = tmpDir();
  const a = json(await cli(r.root, ['worktrees', '--create', '--base-dir', base, '--json']));
  assert.deepEqual(a.worktrees.map((w) => w.created), [true, true]);
  for (const t of ['api', 'ui']) assert.ok(fs.existsSync(path.join(base, t, 'README.md')), `${t} worktree checked out`);
  assert.match(r.git('branch', '--list', 'track/api'), /track\/api/);
  const again = json(await cli(r.root, ['worktrees', '--create', '--base-dir', base, '--json']));
  assert.deepEqual(again.worktrees.map((w) => [w.exists, w.created]), [[true, false], [true, false]]);
  // A claim made in one worktree is visible from the other immediately.
  const wtApi = path.join(base, 'api');
  const wtUi = path.join(base, 'ui');
  assert.equal((await cli(wtApi, ['begin', 'WP-001', '--agent', 'codex'])).status, 0);
  const seen = json(await cli(wtUi, ['bus', 'list', '--json']));
  assert.ok(seen.messages.some((m) => m.type === 'CLAIM' && m.packet === 'WP-001'));
  // Ownership clashes are detected across worktrees too.
  assert.equal((await cli(wtUi, ['begin', 'WP-001', '--agent', 'gemini', '--pull'])).status, 1);
});

test('worktrees reuses an existing branch and refuses outside git', async () => {
  const r = repo();
  r.git('branch', 'track/api');
  const base = tmpDir();
  const out = json(await cli(r.root, ['worktrees', '--create', '--base-dir', base, '--json']));
  assert.equal(out.worktrees[0].created, true);
  assert.equal(r.git('-C', path.join(base, 'api'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'track/api');
  const plain = makeTempRepo({ git: false, config: true, plan: true });
  cleanups.push(() => plain.cleanup());
  const bad = await cli(plain.root, ['worktrees']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /git repository/);
});

// ---------------------------------------------------------------- sync

test('sync rebases the track branch onto main', async () => {
  const r = repo();
  r.git('checkout', '-q', '-b', 'track/api');
  r.write('src/api/a.js', 'a\n');
  r.commitAll('branch work');
  r.git('checkout', '-q', 'main');
  r.write('docs/m.md', 'm\n');
  const mainTip = r.commitAll('main moves');
  r.git('checkout', '-q', 'track/api');
  const before = r.git('rev-parse', 'HEAD');
  const s = await cli(r.root, ['sync', '--json']);
  assert.equal(s.status, 0, s.stderr);
  const out = json(s);
  assert.equal(out.changed, true);
  assert.equal(out.before, before);
  assert.notEqual(out.after, before);
  assert.equal(r.git('merge-base', '--is-ancestor', mainTip, 'HEAD') ?? '', '');
  assert.ok(r.exists('docs/m.md') && r.exists('src/api/a.js'));
  const again = json(await cli(r.root, ['sync', '--json']));
  assert.equal(again.changed, false);
});

test('sync refuses on main, with a dirty tree, and in detached HEAD', async () => {
  const r = repo();
  const onMain = await cli(r.root, ['sync']);
  assert.equal(onMain.status, 1);
  assert.match(onMain.stderr, /track branches/);
  r.git('checkout', '-q', '-b', 'track/api');
  r.write('src/api/dirty.js', 'x\n');
  const dirty = await cli(r.root, ['sync']);
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /commit or stash/);
  r.commitAll('clean');
  r.git('checkout', '-q', '--detach');
  const det = await cli(r.root, ['sync']);
  assert.equal(det.status, 1);
  assert.match(det.stderr, /detached/);
});

test('sync aborts a conflicting rebase and leaves the branch untouched', async () => {
  const r = repo();
  r.git('checkout', '-q', '-b', 'track/api');
  r.write('shared.txt', 'branch version\n');
  r.commitAll('branch edit');
  r.git('checkout', '-q', 'main');
  r.write('shared.txt', 'main version\n');
  r.commitAll('main edit');
  r.git('checkout', '-q', 'track/api');
  const before = r.git('rev-parse', 'HEAD');
  const s = await cli(r.root, ['sync']);
  assert.equal(s.status, 1);
  assert.match(s.stderr, /conflicts and was aborted/);
  assert.equal(r.git('rev-parse', 'HEAD'), before);
  assert.ok(!fs.existsSync(path.join(r.root, '.git', 'rebase-merge')));
  assert.equal(r.read('shared.txt').replace(/\r/g, ''), 'branch version\n'); // autocrlf may rewrite line endings
});

// ---------------------------------------------------------------- merge

test('merge fast-forwards main to the accepted commit and records it', async () => {
  const r = repo();
  const commit = await submitOnBranch(r);
  assert.equal((await cli(r.root, ['accept', 'WP-001', '--by', 'claude'])).status, 0);
  const m = await cli(r.root, ['merge', 'WP-001', '--by', 'claude', '--json']);
  assert.equal(m.status, 0, m.stderr);
  assert.equal(json(m).moved, true);
  assert.equal(r.git('rev-parse', 'main'), commit);
  assert.ok(readEvents(r.root).some((e) => e.kind === 'merged' && e.packet === 'WP-001' && e.data.commit === commit));
  const again = await cli(r.root, ['merge', 'WP-001', '--by', 'claude']);
  assert.equal(again.status, 0);
  assert.match(again.stdout, /already merged/);
});

test('merge fast-forwards a checked-out main in its own worktree', async () => {
  const r = repo();
  const commit = await submitOnBranch(r);
  await cli(r.root, ['accept', 'WP-001', '--by', 'claude']);
  const main = tmpDir();
  fs.rmSync(main, { recursive: true });
  r.git('worktree', 'add', '-q', main, 'main');
  const m = await cli(r.root, ['merge', 'WP-001', '--by', 'claude', '--json']);
  assert.equal(m.status, 0, m.stderr);
  assert.equal(r.git('-C', main, 'rev-parse', 'HEAD'), commit);
  assert.ok(fs.existsSync(path.join(main, 'src', 'api', 'export.js')), 'the main worktree was updated, not just the ref');
});

test('merge refuses non-accepted packets, non-orchestrators, shared-tree work and unknown ids', async () => {
  const r = repo();
  const commit = await submitOnBranch(r);
  const early = await cli(r.root, ['merge', 'WP-001', '--by', 'claude']);
  assert.equal(early.status, 1);
  assert.match(early.stderr, /only ACCEPTED/);
  await cli(r.root, ['accept', 'WP-001', '--by', 'claude']);
  const nobody = await cli(r.root, ['merge', 'WP-001', '--by', 'codex']);
  assert.equal(nobody.status, 1);
  assert.match(nobody.stderr, /orchestrator/);
  assert.equal((await cli(r.root, ['merge', 'WP-999', '--by', 'claude'])).status, 1);
  assert.equal((await cli(r.root, ['merge', '--by', 'claude'])).status, 2);
  assert.equal(r.git('rev-parse', 'main'), r.git('rev-list', '--max-parents=0', 'HEAD'), 'main never moved');
  assert.notEqual(commit, r.git('rev-parse', 'main'));
});

test('merge refuses when main moved on (not a fast-forward) and leaves main alone', async () => {
  const r = repo();
  const commit = await submitOnBranch(r);
  await cli(r.root, ['accept', 'WP-001', '--by', 'claude']);
  r.git('checkout', '-q', 'main');
  r.write('docs/other.md', 'x\n');
  const mainTip = r.commitAll('main moves on');
  r.git('checkout', '-q', 'track/api');
  const m = await cli(r.root, ['merge', 'WP-001', '--by', 'claude']);
  assert.equal(m.status, 1);
  assert.match(m.stderr, /not a fast-forward/);
  assert.match(m.stderr, /replacement packet/);
  assert.equal(r.git('rev-parse', 'main'), mainTip);
  assert.notEqual(mainTip, commit);
});

test('merge of shared-tree work is already contained in main and only records the event', async () => {
  const r = repo();
  assert.equal((await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'])).status, 0);
  r.write('src/api/export.js', 'x\n');
  assert.equal((await cli(r.root, ['verify', 'WP-001'])).status, 0);
  assert.equal((await cli(r.root, ['submit', 'WP-001', '--agent', 'codex'])).status, 0);
  assert.equal((await cli(r.root, ['accept', 'WP-001', '--by', 'claude'])).status, 0);
  const m = await cli(r.root, ['merge', 'WP-001', '--by', 'claude']);
  // The shared tree is on main, so the verified HEAD is main's own tip: already contained, nothing to move.
  assert.equal(m.status, 0, m.stderr);
  assert.match(m.stdout, /already contained/);
});

test('merge refuses unreviewed ancestors when begin starts on a pre-existing feature branch', async () => {
  const r = repo();
  r.git('checkout', '-q', '-b', 'feature/unrelated');
  r.write('docs/unrelated.md', 'unreviewed ancestor\n');
  r.commitAll('unrelated work');
  r.git('checkout', '-q', '-b', 'baton/WP-001');
  assert.equal((await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'])).status, 0);
  r.write('src/api/export.js', 'export const x = 1;\n');
  r.commitAll('packet implementation');
  assert.equal((await cli(r.root, ['verify', 'WP-001'])).status, 0);
  assert.equal((await cli(r.root, ['submit', 'WP-001', '--agent', 'codex'])).status, 0);
  assert.equal((await cli(r.root, ['accept', 'WP-001', '--by', 'claude'])).status, 0);
  const mainBefore = r.git('rev-parse', 'main');
  const m = await cli(r.root, ['merge', 'WP-001', '--by', 'claude']);
  assert.equal(m.status, 1, m.stderr);
  assert.match(m.stderr, /unverified ancestor commits/);
  assert.equal(r.git('rev-parse', 'main'), mainBefore);
});

test('sync refuses rebasing an accepted packet and does not rewrite its commit', async () => {
  const r = repo();
  const commit = await submitOnBranch(r);
  assert.equal((await cli(r.root, ['accept', 'WP-001', '--by', 'claude'])).status, 0);
  r.git('checkout', '-q', 'main');
  r.write('docs/main-update.md', 'main moves\n');
  r.commitAll('move main');
  r.git('checkout', '-q', 'track/api');
  const before = r.git('rev-parse', 'HEAD');
  const reply = await cli(r.root, ['sync']);
  assert.equal(reply.status, 1, reply.stderr);
  assert.match(reply.stderr, /accepted packet/);
  assert.equal(r.git('rev-parse', 'HEAD'), before);
  assert.equal(before, commit);
});

test('publishing ledger to main persists reviewed and merged packet state in a fresh clone', async () => {
  const r = repo();
  await submitOnBranch(r);
  assert.equal((await cli(r.root, ['accept', 'WP-001', '--by', 'claude'])).status, 0);
  assert.equal((await cli(r.root, ['merge', 'WP-001', '--by', 'claude'])).status, 0);
  r.git('checkout', '-q', 'main');
  const exported = await cli(r.root, ['ledger', 'export']);
  assert.equal(exported.status, 0, exported.stderr);
  r.git('add', '.baton/ledger');
  r.git('commit', '-q', '-m', 'baton: publish reviewed lifecycle events');
  const fresh = path.join(tmpDir(), 'clone');
  r.git('clone', '-q', r.root, fresh);
  const review = await cli(fresh, ['review', 'WP-001', '--json']);
  assert.equal(review.status, 0, review.stderr);
  const s = json(review);
  assert.equal(s.status, 'ACCEPTED');
  assert.ok(readEvents(fresh).some((e) => e.kind === 'merged' && e.packet === 'WP-001'));
  assert.equal((await cli(fresh, ['ledger', 'verify'])).status, 0);
});

test('sync allows branch rebases when accepted ancestor has already been merged into main', async () => {
  const r = repo();
  await submitOnBranch(r);
  assert.equal((await cli(r.root, ['accept', 'WP-001', '--by', 'claude'])).status, 0);
  assert.equal((await cli(r.root, ['merge', 'WP-001', '--by', 'claude'])).status, 0);
  r.git('checkout', '-q', 'main');
  r.git('checkout', '-q', '-b', 'track/follow-up');
  r.write('docs/follow-up.md', 'branch work\n');
  r.commitAll('follow-up on integrated feature');
  r.git('checkout', '-q', 'main');
  r.write('docs/new-main.md', 'upstream work\n');
  const mainHead = r.commitAll('new upstream commit');
  r.git('checkout', '-q', 'track/follow-up');
  const result = await cli(r.root, ['sync']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(r.git('merge-base', '--is-ancestor', mainHead, 'HEAD') ?? '', '');
});
