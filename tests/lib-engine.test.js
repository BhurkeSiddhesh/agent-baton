import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  STATUSES, TRANSITIONS, load, derive, flags, transition, begin, heartbeat, reclaim, block, submit, verdict, carry, reassignReviewer, handoff,
  setGate, recordVerify, readyPackets, nextFor, blockingDeps, addFinding, resolveFinding, findingsOf, postMessage, scores, progress, auditEvents,
  acknowledge, readVerifyMarker, confirmClaim,
} from '../src/lib/engine.js';
import { appendEvent, readEvents, orderEvents, eventsDir, eventSha, LEDGER_VERSION } from '../src/lib/store.js';
import { fingerprint } from '../src/lib/util.js';
import { headCommit } from '../src/lib/git.js';
import { makeTempRepo, sampleConfig, samplePlan } from './helpers.js';

const T0 = '2026-10-13T09:00:00Z';

function setup({ git = false, plan = samplePlan(), config = sampleConfig(), files = {} } = {}) {
  process.env.BATON_NOW = T0;
  const repo = makeTempRepo({ git, config, plan, files: { 'src/api/export.js': '// v0\n', ...files } });
  return repo;
}
function done(repo) { delete process.env.BATON_NOW; delete process.env.BATON_AGENT; repo.cleanup(); }
const status = (root, pid) => load(root).state.packets[pid].status;
const code = (fn) => { try { fn(); } catch (e) { return e.code || e.message; } return null; };

/** Snapshot-mode verify marker that matches the current tree. */
function markVerified(root, pid, ok = true) {
  return recordVerify(root, pid, { packet: pid, ok, mode: 'snapshot', commit: null, fingerprint: fingerprint(root), tests: { ran: true, ok, tail: '3 passed' } });
}
/** Full happy path to READY_FOR_REVIEW for a packet. */
function toReady(repo, pid, agent) {
  begin(repo.root, pid, agent);
  repo.write(`work-${pid}.txt`, 'done');
  markVerified(repo.root, pid);
  return submit(repo.root, pid, { by: agent });
}

test('TRANSITIONS table matches the spec exactly', () => {
  const want = {
    PLANNED: ['BLOCKED', 'IN_PROGRESS'], CARRIED_OVER: ['BLOCKED', 'IN_PROGRESS'], IN_PROGRESS: ['BLOCKED', 'READY_FOR_REVIEW'], BLOCKED: ['IN_PROGRESS'],
    READY_FOR_REVIEW: ['ACCEPTED', 'ACCEPTED_WITH_FIXES', 'IN_PROGRESS', 'REJECTED'], ACCEPTED_WITH_FIXES: ['ACCEPTED', 'IN_PROGRESS'],
    REJECTED: ['CARRIED_OVER', 'IN_PROGRESS'], ACCEPTED: [],
  };
  assert.deepEqual(STATUSES.slice().sort(), Object.keys(want).sort());
  for (const [from, tos] of Object.entries(want)) assert.deepEqual([...TRANSITIONS[from]].sort(), tos, from);
});

test('transition(): every (from,to) pair obeys the table', () => {
  const repo = setup();
  try {
    // Seed a status by appending a raw event (appendEvent does no rule checking).
    let n = 0;
    for (const from of STATUSES) {
      const pid = 'WP-004'; // gated; irrelevant here because we only look at BAD_TRANSITION
      const seedRepo = setup();
      try {
        for (const to of STATUSES) {
          n++;
          appendEvent(seedRepo.root, { packet: pid, kind: 'status', to: from, by: 'codex' }); // raw seed, no rule checks
          const c = code(() => transition(seedRepo.root, pid, to, { by: 'claude', kind: to === 'IN_PROGRESS' ? 'begin' : 'status' }));
          if (TRANSITIONS[from].has(to)) assert.notEqual(c, 'BAD_TRANSITION', `${from} -> ${to} should pass the table`);
          else assert.equal(c, 'BAD_TRANSITION', `${from} -> ${to} should be refused`);
        }
      } finally { seedRepo.cleanup(); }
    }
    assert.equal(n, 64);
  } finally { done(repo); }
});

test('IN_PROGRESS is reachable only through begin', () => {
  const repo = setup();
  try {
    assert.equal(code(() => transition(repo.root, 'WP-001', 'IN_PROGRESS', { by: 'codex' })), 'BEGIN_ONLY');
    assert.equal(status(repo.root, 'WP-001'), 'PLANNED');
  } finally { done(repo); }
});

test('begin: lease, snapshot, claim message, contributor, base', () => {
  const repo = setup({ git: true });
  try {
    const r = begin(repo.root, 'WP-001', 'codex');
    assert.equal(r.leaseUntil, '2026-10-13T17:00:00Z');
    assert.equal(r.base, headCommit(repo.root));
    const { state, events } = load(repo.root);
    const s = state.packets['WP-001'];
    assert.deepEqual([s.status, s.by, s.contributors, s.leaseUntil], ['IN_PROGRESS', 'codex', ['codex'], '2026-10-13T17:00:00Z']);
    assert.ok(events.some((e) => e.kind === 'message' && e.data.type === 'CLAIM' && e.packet === 'WP-001'));
    assert.ok(fs.existsSync(path.join(repo.root, '.git', 'baton', 'snapshots', 'WP-001.json')));
    assert.equal(code(() => begin(repo.root, 'WP-001', 'codex')), 'ALREADY_STARTED');
  } finally { done(repo); }
});

test('begin refusals: pull, reviewer, same-track dep, gate, unknown, non-worker', () => {
  const repo = setup();
  try {
    assert.equal(code(() => begin(repo.root, 'WP-001', 'gemini')), 'NOT_YOURS');
    assert.equal(code(() => begin(repo.root, 'WP-001', 'claude', { pull: true })), 'REVIEWER_CONFLICT');
    assert.equal(code(() => begin(repo.root, 'WP-002', 'codex')), 'DEPS_UNMET');
    assert.equal(code(() => begin(repo.root, 'WP-004', 'codex')), 'GATE_CLOSED');
    assert.equal(code(() => begin(repo.root, 'WP-999', 'codex')), 'UNKNOWN_PACKET');
    assert.equal(code(() => begin(repo.root, 'WP-001', 'nobody')), 'UNKNOWN_AGENT');
    const r = begin(repo.root, 'WP-001', 'gemini', { pull: true });
    assert.equal(r.pulledEarly, true);
    const ev = readEvents(repo.root).find((e) => e.kind === 'begin');
    assert.equal(ev.note, 'pulled early');
  } finally { done(repo); }
});

test('BATON_AGENT identity is enforced', () => {
  const repo = setup();
  try {
    process.env.BATON_AGENT = 'gemini';
    assert.equal(code(() => begin(repo.root, 'WP-001', 'codex')), 'IDENTITY');
    process.env.BATON_AGENT = 'codex';
    assert.ok(begin(repo.root, 'WP-001', 'codex'));
  } finally { done(repo); }
});

test('cross-track dependencies never block starting, but raise AT_RISK; same-track ones block until reviewable', () => {
  const repo = setup();
  try {
    let { plan, state } = load(repo.root);
    assert.deepEqual(blockingDeps(plan.packets[2], plan, state), []);
    assert.deepEqual(blockingDeps(plan.packets[1], plan, state), ['WP-001']);
    begin(repo.root, 'WP-003', 'gemini');
    ({ plan, state } = load(repo.root));
    assert.deepEqual(flags('WP-003', plan, state), ['AT_RISK:WP-001=PLANNED']);
    toReady(repo, 'WP-001', 'codex');
    ({ plan, state } = load(repo.root));
    assert.deepEqual(blockingDeps(plan.packets[1], plan, state), []);
    assert.deepEqual(flags('WP-003', plan, state), []);
  } finally { done(repo); }
});

test('needs_done blocks until ACCEPTED even across tracks', () => {
  const plan = samplePlan();
  plan.packets[2].needs_done = ['WP-001'];
  const repo = setup({ plan });
  try {
    assert.equal(code(() => begin(repo.root, 'WP-003', 'gemini')), 'DEPS_UNMET');
    toReady(repo, 'WP-001', 'codex');
    assert.equal(code(() => begin(repo.root, 'WP-003', 'gemini')), 'DEPS_UNMET');
    verdict(repo.root, 'WP-001', 'ACCEPTED', { by: 'claude' });
    assert.ok(begin(repo.root, 'WP-003', 'gemini'));
  } finally { done(repo); }
});

test('AT_RISK:<dep>-changed when a dependency is reworked to a new commit', () => {
  const repo = setup();
  try {
    begin(repo.root, 'WP-001', 'codex');
    repo.write('work-WP-001.txt', 'v1');
    recordVerify(repo.root, 'WP-001', { ok: true, mode: 'snapshot', commit: 'c1', fingerprint: fingerprint(repo.root), tests: { tail: 'ok' } });
    submit(repo.root, 'WP-001', { by: 'codex' });
    begin(repo.root, 'WP-003', 'gemini');
    let { plan, state } = load(repo.root);
    assert.deepEqual(flags('WP-003', plan, state), []);
    // WP-001 is reopened and re-submitted at a different commit
    begin(repo.root, 'WP-001', 'codex');
    repo.write('work-WP-001.txt', 'v2');
    recordVerify(repo.root, 'WP-001', { ok: true, mode: 'snapshot', commit: 'c2', fingerprint: fingerprint(repo.root), tests: { tail: 'ok' } });
    submit(repo.root, 'WP-001', { by: 'codex' });
    ({ plan, state } = load(repo.root));
    assert.deepEqual(flags('WP-003', plan, state), ['AT_RISK:WP-001-changed']);
  } finally { done(repo); }
});

test('file ownership clash with an in-progress packet refuses begin', () => {
  const plan = samplePlan();
  plan.packets.push({ id: 'WP-005', title: 'Overlap', track: 'api', agent: 'codex', reviewer: 'claude', owns: ['src/api/'], priority: 'P3' });
  const repo = setup({ plan });
  try {
    begin(repo.root, 'WP-001', 'codex');
    assert.equal(code(() => begin(repo.root, 'WP-005', 'codex')), 'OWNERSHIP_CLASH');
    assert.ok(!readyPackets(load(repo.root).plan, load(repo.root).state).some((p) => p.id === 'WP-005'));
  } finally { done(repo); }
});

test('submit requires a passing, current verify marker (snapshot mode)', () => {
  const repo = setup();
  try {
    begin(repo.root, 'WP-001', 'codex');
    assert.equal(code(() => submit(repo.root, 'WP-001', { by: 'codex' })), 'NOT_VERIFIED');
    markVerified(repo.root, 'WP-001', false);
    assert.equal(code(() => submit(repo.root, 'WP-001', { by: 'codex' })), 'NOT_VERIFIED');
    markVerified(repo.root, 'WP-001', true);
    repo.write('src/api/export.js', '// changed after verify\n');
    assert.equal(code(() => submit(repo.root, 'WP-001', { by: 'codex' })), 'STALE_VERIFY');
    markVerified(repo.root, 'WP-001', true);
    const ev = submit(repo.root, 'WP-001', { by: 'codex' });
    assert.equal(ev.kind, 'ready');
    assert.equal(ev.data.tests, '3 passed');
    assert.equal(status(repo.root, 'WP-001'), 'READY_FOR_REVIEW');
    assert.ok(readEvents(repo.root).some((e) => e.kind === 'message' && e.data.type === 'SIGNOFF'));
  } finally { done(repo); }
});

test('submit in git-branch mode: clean tree and HEAD == verified commit', () => {
  const repo = setup({ git: true });
  try {
    begin(repo.root, 'WP-001', 'codex');
    repo.write('src/api/export.js', '// v1\n');
    const c1 = repo.commitAll('work');
    const marker = (commit) => ({ ok: true, mode: 'git-branch', commit, fingerprint: 'x', tests: { tail: 'ok' } });
    recordVerify(repo.root, 'WP-001', marker(c1));
    repo.write('src/api/export.js', '// dirty\n');
    assert.equal(code(() => submit(repo.root, 'WP-001', { by: 'codex' })), 'DIRTY_TREE');
    repo.commitAll('more');
    assert.equal(code(() => submit(repo.root, 'WP-001', { by: 'codex' })), 'STALE_VERIFY');
    recordVerify(repo.root, 'WP-001', marker(headCommit(repo.root)));
    const ev = submit(repo.root, 'WP-001', { by: 'codex' });
    assert.equal(ev.data.commit, headCommit(repo.root));
  } finally { done(repo); }
});

test('verify writes the marker and a verify event; reopening discards the marker', () => {
  const repo = setup();
  try {
    toReady(repo, 'WP-001', 'codex');
    assert.equal(readVerifyMarker(repo.root, 'WP-001').ok, true);
    assert.ok(readEvents(repo.root).some((e) => e.kind === 'verify' && e.data.ok === true));
    begin(repo.root, 'WP-001', 'codex'); // author reopens
    assert.equal(readVerifyMarker(repo.root, 'WP-001'), null);
    assert.equal(status(repo.root, 'WP-001'), 'IN_PROGRESS');
  } finally { done(repo); }
});

test('rework entry skips dep/gate checks and is limited to contributors', () => {
  const plan = samplePlan();
  plan.packets[0].gate = 'G1';
  plan.packets[0].gate_mode = 'live_only';
  const repo = setup({ plan });
  try {
    toReady(repo, 'WP-001', 'codex');
    assert.equal(code(() => begin(repo.root, 'WP-001', 'gemini', { pull: true })), 'NOT_CONTRIBUTOR');
    const r = begin(repo.root, 'WP-001', 'codex');
    assert.equal(r.rework, true);
    assert.equal(readEvents(repo.root).filter((e) => e.kind === 'begin').pop().note, 'rework');
  } finally { done(repo); }
});

test('verdict rules: only the reviewer, never a contributor, needs reviewer assigned', () => {
  const repo = setup();
  try {
    toReady(repo, 'WP-001', 'codex');
    assert.equal(code(() => verdict(repo.root, 'WP-001', 'ACCEPTED', { by: 'codex' })), 'NOT_REVIEWER');
    assert.equal(code(() => verdict(repo.root, 'WP-001', 'ACCEPTED', { by: 'gemini' })), 'NOT_REVIEWER');
    assert.equal(code(() => verdict(repo.root, 'WP-001', 'ACCEPTED', { by: 'claude', score: 11 })), 'BAD_SCORE');
    // reassigning the reviewer to a contributor is refused, so independence holds
    assert.equal(code(() => reassignReviewer(repo.root, 'WP-001', 'codex', { by: 'claude' })), 'REVIEWER_CONFLICT');
    // a reviewer who becomes a contributor (pulls and begins another time) cannot verdict
    reassignReviewer(repo.root, 'WP-001', 'gemini', { by: 'claude' });
    assert.equal(code(() => verdict(repo.root, 'WP-001', 'ACCEPTED', { by: 'claude' })), 'NOT_REVIEWER');
    verdict(repo.root, 'WP-001', 'ACCEPTED', { by: 'gemini', score: 8 });
    assert.equal(status(repo.root, 'WP-001'), 'ACCEPTED');
    assert.equal(load(repo.root).state.packets['WP-001'].verdict.score, 8);
    assert.equal(code(() => begin(repo.root, 'WP-001', 'codex')), 'ALREADY_DONE');
  } finally { done(repo); }
});

test('reassignReviewer: orchestrator only, reviewer role required', () => {
  const repo = setup();
  try {
    assert.equal(code(() => reassignReviewer(repo.root, 'WP-001', 'gemini', { by: 'codex' })), 'NOT_ORCHESTRATOR');
    const cfg = sampleConfig();
    cfg.agents[2].roles = ['worker'];
    fs.writeFileSync(path.join(repo.root, '.baton', 'config.json'), JSON.stringify(cfg));
    assert.equal(code(() => reassignReviewer(repo.root, 'WP-001', 'gemini', { by: 'claude' })), 'NOT_REVIEWER');
    assert.equal(code(() => reassignReviewer(repo.root, 'WP-001', 'codex', { by: 'claude' })), 'REVIEWER_CONFLICT');
  } finally { done(repo); }
});

test('ACCEPTED is blocked by open BLOCKER/MAJOR findings until the filer confirms; MINOR never blocks', () => {
  const repo = setup();
  try {
    toReady(repo, 'WP-001', 'codex');
    const { fid } = addFinding(repo.root, { packet: 'WP-001', by: 'claude', severity: 'MAJOR', text: 'null deref', file: 'src/api/export.js', line: 3, evidence: 'npm test fails', fix: 'guard it' });
    addFinding(repo.root, { packet: 'WP-001', by: 'claude', severity: 'MINOR', text: 'naming' });
    assert.equal(fid, 'AUD-001');
    assert.equal(code(() => verdict(repo.root, 'WP-001', 'ACCEPTED', { by: 'claude' })), 'OPEN_FINDINGS');
    assert.equal(code(() => resolveFinding(repo.root, fid, { by: 'codex', resolution: 'fixed', confirm: true })), 'NOT_FILER');
    assert.equal(code(() => resolveFinding(repo.root, fid, { by: 'claude', confirm: true })), 'NOT_RESOLVED');
    resolveFinding(repo.root, fid, { by: 'codex', resolution: 'fixed' });
    assert.equal(findingsOf(readEvents(repo.root))[0].status, 'resolved');
    assert.equal(code(() => verdict(repo.root, 'WP-001', 'ACCEPTED', { by: 'claude' })), 'OPEN_FINDINGS');
    resolveFinding(repo.root, fid, { by: 'claude', confirm: true });
    assert.equal(findingsOf(readEvents(repo.root))[0].status, 'closed');
    verdict(repo.root, 'WP-001', 'ACCEPTED', { by: 'claude' });
    assert.equal(status(repo.root, 'WP-001'), 'ACCEPTED');
  } finally { done(repo); }
});

test('findings: invalid by the filer closes; authors cannot file; roles enforced; ids increment', () => {
  const repo = setup();
  try {
    toReady(repo, 'WP-001', 'codex');
    assert.equal(code(() => addFinding(repo.root, { packet: 'WP-001', by: 'codex', severity: 'MAJOR', text: 'x' })), 'REVIEWER_CONFLICT');
    const cfg = sampleConfig();
    cfg.agents[2].roles = ['worker'];
    fs.writeFileSync(path.join(repo.root, '.baton', 'config.json'), JSON.stringify(cfg));
    assert.equal(code(() => addFinding(repo.root, { packet: 'WP-001', by: 'gemini', severity: 'MAJOR', text: 'x' })), 'NOT_AUDITOR');
    assert.equal(code(() => addFinding(repo.root, { packet: 'WP-001', by: 'claude', severity: 'HUGE', text: 'x' })), 'BAD_SEVERITY');
    const a = addFinding(repo.root, { packet: 'WP-001', by: 'claude', severity: 'BLOCKER', text: 'one' });
    const b = addFinding(repo.root, { packet: 'WP-001', by: 'claude', severity: 'BLOCKER', text: 'two' });
    assert.deepEqual([a.fid, b.fid], ['AUD-001', 'AUD-002']);
    resolveFinding(repo.root, a.fid, { by: 'claude', resolution: 'invalid' });
    assert.equal(findingsOf(readEvents(repo.root), 'WP-001')[0].status, 'closed');
    assert.equal(code(() => resolveFinding(repo.root, a.fid, { by: 'codex', resolution: 'fixed' })), 'ALREADY_DONE');
    assert.equal(code(() => resolveFinding(repo.root, b.fid, { by: 'codex', resolution: 'maybe' })), 'BAD_RESOLUTION');
    // "invalid" claimed by the fixer is only a resolution, not a closure
    resolveFinding(repo.root, b.fid, { by: 'codex', resolution: 'invalid' });
    assert.equal(findingsOf(readEvents(repo.root)).find((f) => f.fid === b.fid).status, 'resolved');
  } finally { done(repo); }
});

test('REJECTED needs a note or a finding; ESCALATE after two rejections; carry is orchestrator-only', () => {
  const repo = setup();
  try {
    toReady(repo, 'WP-001', 'codex');
    assert.equal(code(() => verdict(repo.root, 'WP-001', 'REJECTED', { by: 'claude' })), 'REJECT_NEEDS_REASON');
    verdict(repo.root, 'WP-001', 'REJECTED', { by: 'claude', note: 'does not run' });
    assert.equal(code(() => carry(repo.root, 'WP-001', { by: 'codex' })), 'NOT_ORCHESTRATOR');
    let { plan, state } = load(repo.root);
    assert.deepEqual(flags('WP-001', plan, state, { config: sampleConfig() }), []);
    begin(repo.root, 'WP-001', 'codex');
    markVerified(repo.root, 'WP-001');
    submit(repo.root, 'WP-001', { by: 'codex' });
    addFinding(repo.root, { packet: 'WP-001', by: 'claude', severity: 'MINOR', text: 'x' });
    verdict(repo.root, 'WP-001', 'REJECTED', { by: 'claude' }); // a finding is enough
    ({ plan, state } = load(repo.root));
    assert.equal(state.packets['WP-001'].rejections, 2);
    assert.ok(flags('WP-001', plan, state, { config: sampleConfig() }).includes('ESCALATE'));
    carry(repo.root, 'WP-001', { by: 'claude' });
    assert.equal(status(repo.root, 'WP-001'), 'CARRIED_OVER');
    assert.ok(nextFor('codex', plan, load(repo.root).state).reworkOwed.includes('WP-001'));
    assert.ok(begin(repo.root, 'WP-001', 'codex'));
  } finally { done(repo); }
});

test('ACCEPTED_WITH_FIXES -> rework -> ACCEPTED; counts as reopen', () => {
  const repo = setup();
  try {
    toReady(repo, 'WP-001', 'codex');
    verdict(repo.root, 'WP-001', 'ACCEPTED_WITH_FIXES', { by: 'claude', note: 'rename x' });
    begin(repo.root, 'WP-001', 'codex');
    repo.write('work-WP-001.txt', 'fixed');
    markVerified(repo.root, 'WP-001');
    submit(repo.root, 'WP-001', { by: 'codex' });
    verdict(repo.root, 'WP-001', 'ACCEPTED', { by: 'claude' });
    assert.equal(status(repo.root, 'WP-001'), 'ACCEPTED');
    const s = scores(load(repo.root).plan, readEvents(repo.root)).agents;
    assert.equal(s.codex.reopensAfterFixes, 1);
    assert.equal(s.codex.acceptedWithFixes, 1);
    assert.equal(s.codex.accepted, 1);
    assert.equal(s.codex.firstPassRate, 0);
  } finally { done(repo); }
});

test('stale lease: STALE flag, heartbeat refreshes, reclaim only when stale', () => {
  const repo = setup();
  try {
    begin(repo.root, 'WP-001', 'codex');
    assert.equal(code(() => reclaim(repo.root, 'WP-001', 'gemini')), 'NOT_STALE');
    process.env.BATON_NOW = '2026-10-13T16:59:00Z';
    assert.deepEqual(flags('WP-001', load(repo.root).plan, load(repo.root).state), []);
    process.env.BATON_NOW = '2026-10-13T17:01:00Z';
    let { plan, state } = load(repo.root);
    assert.deepEqual(flags('WP-001', plan, state), ['STALE']);
    assert.deepEqual(nextFor('gemini', plan, state).staleReclaimable, ['WP-001']);
    // a stale lease is taken over with reclaim, never extended by someone else (and never by the reviewer)
    assert.equal(code(() => heartbeat(repo.root, 'WP-001', 'gemini')), 'HELD');
    assert.equal(code(() => heartbeat(repo.root, 'WP-001', 'claude')), 'HELD');
    assert.ok(!readEvents(repo.root).some((e) => e.kind === 'heartbeat'));
    process.env.BATON_NOW = '2026-10-14T05:00:00Z';
    assert.equal(code(() => reclaim(repo.root, 'WP-001', 'claude')), 'REVIEWER_CONFLICT');
    const r = reclaim(repo.root, 'WP-001', 'gemini');
    assert.equal(r.leaseUntil, '2026-10-14T13:00:00Z');
    ({ plan, state } = load(repo.root));
    assert.equal(state.packets['WP-001'].by, 'gemini');
    assert.deepEqual(flags('WP-001', plan, state), []);
    assert.equal(code(() => heartbeat(repo.root, 'WP-001', 'codex')), 'HELD');
    assert.ok(readEvents(repo.root).some((e) => e.kind === 'begin' && /reclaimed from/.test(e.note)));
  } finally { done(repo); }
});

test('NO_LEASE flag for a begin event without a lease; reclaim allowed', () => {
  const repo = setup();
  try {
    appendEvent(repo.root, { packet: 'WP-001', kind: 'begin', to: 'IN_PROGRESS', by: 'codex', data: {} });
    const { plan, state } = load(repo.root);
    assert.deepEqual(flags('WP-001', plan, state), ['NO_LEASE']);
    assert.ok(reclaim(repo.root, 'WP-001', 'gemini'));
  } finally { done(repo); }
});

test('block: needs reason, posts BLOCKER, BLOCKED -> begin re-runs checks', () => {
  const repo = setup();
  try {
    begin(repo.root, 'WP-001', 'codex');
    assert.equal(code(() => block(repo.root, 'WP-001', { by: 'codex', reason: '' })), 'NEEDS_REASON');
    assert.equal(code(() => block(repo.root, 'WP-001', { by: 'gemini', reason: 'x' })), 'HELD');
    block(repo.root, 'WP-001', { by: 'codex', reason: 'need API key', question: 'who has it?' });
    const { state, events } = load(repo.root);
    assert.equal(state.packets['WP-001'].status, 'BLOCKED');
    assert.equal(state.packets['WP-001'].blockedReason, 'need API key');
    assert.ok(events.some((e) => e.kind === 'message' && e.data.type === 'BLOCKER' && /who has it/.test(e.data.text)));
    assert.ok(begin(repo.root, 'WP-001', 'codex'));
  } finally { done(repo); }
});

test('handoff: releases an in-progress packet; new author must begin; reviewer cannot receive it', () => {
  const repo = setup();
  try {
    begin(repo.root, 'WP-001', 'codex');
    assert.equal(code(() => handoff(repo.root, 'WP-001', { to: 'claude', by: 'codex' })), 'REVIEWER_CONFLICT');
    assert.equal(code(() => handoff(repo.root, 'WP-001', { to: 'gemini', by: 'gemini' })), 'NOT_YOURS');
    handoff(repo.root, 'WP-001', { to: 'gemini', by: 'codex', note: 'context: see notes' });
    const s = load(repo.root).state.packets['WP-001'];
    assert.deepEqual([s.status, s.agent, s.by], ['BLOCKED', 'gemini', null]);
    begin(repo.root, 'WP-001', 'gemini');
    assert.equal(load(repo.root).state.packets['WP-001'].by, 'gemini');
    assert.ok(readEvents(repo.root).some((e) => e.kind === 'message' && e.data.type === 'HANDOFF'));
    toReady(repo, 'WP-003', 'gemini');
    assert.equal(code(() => handoff(repo.root, 'WP-003', { to: 'codex', by: 'claude' })), 'BAD_TRANSITION');
  } finally { done(repo); }
});

test('gates: owner only; readyPackets and flags react; live_only gates never block start', () => {
  const plan = samplePlan();
  plan.packets.push({ id: 'WP-005', title: 'Live only', track: 'ui', agent: 'gemini', reviewer: 'codex', owns: ['src/ui/live.js'], gate: 'G1', gate_mode: 'live_only' });
  const repo = setup({ plan });
  try {
    let { plan: p, state } = load(repo.root);
    assert.ok(readyPackets(p, state).some((x) => x.id === 'WP-005'));
    assert.ok(!readyPackets(p, state).some((x) => x.id === 'WP-004'));
    assert.ok(flags('WP-004', p, state).includes('GATE_CLOSED:G1'));
    assert.equal(code(() => setGate(repo.root, 'G1', true, { by: 'codex' })), 'NOT_GATE_OWNER');
    assert.equal(code(() => setGate(repo.root, 'G9', true, { by: 'human' })), 'UNKNOWN_GATE');
    setGate(repo.root, 'G1', true, { by: 'human' });
    ({ plan: p, state } = load(repo.root));
    assert.ok(readyPackets(p, state).some((x) => x.id === 'WP-004'));
    assert.deepEqual(flags('WP-004', p, state), []);
    setGate(repo.root, 'G1', false, { by: 'human' });
    assert.equal(code(() => begin(repo.root, 'WP-004', 'codex')), 'GATE_CLOSED');
    assert.ok(begin(repo.root, 'WP-005', 'gemini'));
  } finally { done(repo); }
});

test('nextFor ranks and partitions work', () => {
  const plan = samplePlan();
  plan.packets.push({ id: 'WP-006', title: 'Stretch', track: 'api', agent: 'codex', reviewer: 'claude', owns: ['docs/x.md'], stretch: true, priority: 'P0' });
  plan.packets.push({ id: 'WP-007', title: 'Unassigned', owns: ['docs/y.md'] });
  const repo = setup({ plan });
  try {
    let { plan: p, state } = load(repo.root);
    let n = nextFor('codex', p, state);
    assert.deepEqual(n.own, ['WP-001']);
    assert.deepEqual(n.stretch, ['WP-006']);
    assert.deepEqual(n.pull, ['WP-003']);
    assert.deepEqual(n.unassigned, ['WP-007']);
    assert.deepEqual(n.awaitingReview, []);
    toReady(repo, 'WP-001', 'codex');
    ({ plan: p, state } = load(repo.root));
    n = nextFor('claude', p, state);
    assert.deepEqual(n.awaitingReview, ['WP-001']);
    assert.deepEqual(n.audit, ['WP-001']);
    assert.deepEqual(nextFor('codex', p, state).audit, []);
    assert.deepEqual(nextFor('codex', p, state).own, ['WP-002']);
  } finally { done(repo); }
});

test('postMessage validates type, text and actors', () => {
  const repo = setup();
  try {
    assert.equal(code(() => postMessage(repo.root, { from: 'codex', type: 'SHOUT', text: 'x' })), 'BAD_MESSAGE');
    assert.equal(code(() => postMessage(repo.root, { from: 'codex', type: 'NOTICE', text: ' ' })), 'BAD_MESSAGE');
    assert.equal(code(() => postMessage(repo.root, { from: 'zed', type: 'NOTICE', text: 'x' })), 'UNKNOWN_AGENT');
    assert.equal(code(() => postMessage(repo.root, { from: 'codex', to: 'zed', type: 'NOTICE', text: 'x' })), 'UNKNOWN_AGENT');
    const ev = postMessage(repo.root, { from: 'codex', to: 'claude', type: 'REQUEST', text: 'need src/shared/a.js' });
    assert.deepEqual(ev.data, { type: 'REQUEST', to: 'claude', text: 'need src/shared/a.js' });
  } finally { done(repo); }
});

test('derive replays handoff, reviewer change, rejections and merged', () => {
  const plan = samplePlan();
  const mk = (kind, extra) => ({ id: `e${Math.random()}`, ts: T0, packet: 'WP-001', kind, by: 'x', note: '', data: {}, ...extra });
  const s = derive(plan, [
    mk('reviewer', { data: { reviewer: 'gemini' } }), mk('handoff', { data: { agent: 'gemini' } }),
    mk('verdict', { to: 'REJECTED', by: 'gemini' }), mk('merged', { data: { commit: 'abc' } }), mk('gate', { packet: null, by: 'human', data: { gate: 'G1', open: true } }),
    mk('begin', { packet: 'NOPE', to: 'IN_PROGRESS' }),
  ]);
  assert.deepEqual([s.packets['WP-001'].reviewer, s.packets['WP-001'].agent, s.packets['WP-001'].rejections, s.packets['WP-001'].merged, s.gates.G1.open],
    ['gemini', 'gemini', 1, 'abc', true]);
});

test('identical causal event sets derive identical packet state despite delivery order and clock skew', () => {
  const plan = samplePlan();
  const blocked = { id: '20260102T000000Z-000001', ts: '2026-01-02T00:00:00Z', packet: 'WP-001', kind: 'status', to: 'BLOCKED', by: 'codex', note: 'wait', data: {}, rev: 1, parents: [] };
  const begun = { id: '20260101T000000Z-000002', ts: '2026-01-01T00:00:00Z', packet: 'WP-001', kind: 'begin', to: 'IN_PROGRESS', by: 'codex', note: '', data: { lease_until: '2026-01-03T00:00:00Z' }, rev: 2, parents: [blocked.id] };
  const a = derive(plan, orderEvents([begun, blocked]));
  const b = derive(plan, orderEvents([blocked, begun]));
  assert.deepEqual(a, b);
  assert.equal(a.packets['WP-001'].status, 'IN_PROGRESS');
});

test('simultaneous conflicting begin claims preserve winning owner, flag conflict and block losing submit', () => {
  const plan = samplePlan();
  const win = { id: '20260101T000000Z-000001', ts: '2026-01-01T00:00:00Z', packet: 'WP-001', kind: 'begin', to: 'IN_PROGRESS', by: 'codex', note: '', data: { lease_until: '2026-01-03T00:00:00Z' }, rev: 1, parents: [] };
  const lose = { id: '20260101T000005Z-000002', ts: '2026-01-01T00:00:05Z', packet: 'WP-001', kind: 'begin', to: 'IN_PROGRESS', by: 'claude', note: '', data: { lease_until: '2026-01-03T00:00:00Z' }, rev: 1, parents: [] };
  const state = derive(plan, orderEvents([lose, win]));
  assert.equal(state.packets['WP-001'].by, 'codex');
  assert.equal(state.packets['WP-001'].claimConflicts.length, 1);
  assert.equal(state.packets['WP-001'].claimConflicts[0].claimant, 'claude');
  assert.ok(flags('WP-001', plan, state).includes('CLAIM_CONFLICT:claude'));

  const problems = auditEvents(plan, [win, lose]);
  assert.ok(problems.some((p) => /conflicting claim on WP-001 by claude; already held by codex/.test(p.problem)));
});

test('losing clone claimant cannot successfully submit its branch as packet owner', () => {
  const repo = setup();
  try {
    const base = { packet: 'WP-001', kind: 'begin', to: 'IN_PROGRESS', note: '', data: { lease_until: '2026-01-03T00:00:00Z' }, rev: 1, parents: [], hv: LEDGER_VERSION };
    const win = { ...base, id: '20260101T000000Z-000001', ts: '2026-01-01T00:00:00Z', by: 'codex' };
    win.sha = eventSha(win);
    const lose = { ...base, id: '20260101T000005Z-000002', ts: '2026-01-01T00:00:05Z', by: 'claude' };
    lose.sha = eventSha(lose);
    const dir = eventsDir(repo.root);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${win.id}.json`), JSON.stringify(win));
    fs.writeFileSync(path.join(dir, `${lose.id}.json`), JSON.stringify(lose));

    assert.throws(
      () => submit(repo.root, 'WP-001', { by: 'claude' }),
      (e) => e.code === 'HELD' && /claim was won by codex/.test(e.message),
    );
  } finally { done(repo); }
});

test('begin CAS expectedRev rejects stale revisions and confirmClaim exposes arbitration', () => {
  const repo = setup();
  try {
    assert.throws(() => begin(repo.root, 'WP-001', 'codex', { expectedRev: 5 }), (e) => e.code === 'STALE_REVISION');
    begin(repo.root, 'WP-001', 'codex', { expectedRev: 0 });
    const confirmed = confirmClaim(repo.root, 'WP-001', 'codex');
    assert.equal(confirmed.confirmed, true);
    assert.equal(confirmed.owner, 'codex');
    const foreign = confirmClaim(repo.root, 'WP-001', 'claude');
    assert.equal(foreign.confirmed, false);
    assert.equal(foreign.reason, 'claim lost to codex');
  } finally { done(repo); }
});

test('auditEvents flags illegal histories and honours acks', () => {
  const repo = setup();
  try {
    appendEvent(repo.root, { packet: 'WP-001', kind: 'status', to: 'ACCEPTED', by: 'claude' }); // PLANNED -> ACCEPTED
    appendEvent(repo.root, { packet: 'WP-002', kind: 'status', to: 'IN_PROGRESS', by: 'codex' }); // without begin
    appendEvent(repo.root, { packet: 'WP-003', kind: 'ready', to: 'READY_FOR_REVIEW', by: 'gemini', data: { commit: 'zzz' } }); // illegal + unverified
    appendEvent(repo.root, { packet: 'WP-004', kind: 'verdict', to: 'REJECTED', by: 'gemini' }); // not the reviewer
    appendEvent(repo.root, { packet: 'NOPE', kind: 'status', to: 'BLOCKED', by: 'codex' });
    const { plan, events, config } = load(repo.root);
    const problems = auditEvents(plan, events, config);
    const text = problems.map((p) => p.problem).join('\n');
    for (const re of [/illegal transition WP-001 PLANNED -> ACCEPTED/, /WP-002 entered IN_PROGRESS without "begin"/, /illegal transition WP-003/, /not verified/, /verdict on WP-004 by gemini/, /unknown packet NOPE/]) {
      assert.match(text, re);
    }
    assert.ok(problems.every((p) => p.acked === false));
    acknowledge(repo.root, problems[0].id, { by: 'claude', reason: 'seeded by a test' });
    const again = auditEvents(plan, readEvents(repo.root), config);
    assert.equal(again.find((p) => p.id === problems[0].id).acked, true);
    assert.equal(code(() => acknowledge(repo.root, 'nope', { by: 'claude', reason: 'x' })), 'UNKNOWN_EVENT');
    assert.equal(code(() => acknowledge(repo.root, problems[0].id, { by: 'claude', reason: ' ' })), 'NEEDS_REASON');
  } finally { done(repo); }
});

test('a clean lifecycle audits clean', () => {
  const repo = setup();
  try {
    toReady(repo, 'WP-001', 'codex');
    verdict(repo.root, 'WP-001', 'ACCEPTED', { by: 'claude', score: 9 });
    const { plan, events, config } = load(repo.root);
    assert.deepEqual(auditEvents(plan, events, config), []);
  } finally { done(repo); }
});

test('scores: per-agent counters are a pure function of the ledger', () => {
  const repo = setup();
  try {
    toReady(repo, 'WP-001', 'codex');
    verdict(repo.root, 'WP-001', 'ACCEPTED', { by: 'claude', score: 9 });
    toReady(repo, 'WP-003', 'gemini');
    addFinding(repo.root, { packet: 'WP-003', by: 'codex', severity: 'MAJOR', text: 'a' });
    addFinding(repo.root, { packet: 'WP-003', by: 'codex', severity: 'MINOR', text: 'b' });
    resolveFinding(repo.root, 'AUD-002', { by: 'codex', resolution: 'invalid' });
    verdict(repo.root, 'WP-003', 'REJECTED', { by: 'codex', score: 3 });
    const { plan, events } = load(repo.root);
    const a = scores(plan, events).agents;
    assert.deepEqual(scores(plan, events), scores(plan, events));
    assert.deepEqual([a.codex.started, a.codex.ready, a.codex.accepted, a.codex.rejected, a.codex.firstPassRate], [1, 1, 1, 0, 1]);
    assert.deepEqual([a.gemini.started, a.gemini.rejected, a.gemini.firstPassRate, a.gemini.findingsAgainstOpen, a.gemini.findingsAgainstClosed], [1, 1, 0, 1, 1]);
    assert.deepEqual([a.claude.reviewsGiven, a.claude.meanScoreGiven], [1, 9]);
    assert.deepEqual([a.codex.reviewsGiven, a.codex.meanScoreGiven, a.codex.findingsFiled, a.codex.findingsInvalid, a.codex.findingsConfirmed], [1, 3, 2, 1, 0]);
  } finally { done(repo); }
});

test('progress: milestones, overall percent, overdue, closed gates', () => {
  const repo = setup();
  try {
    toReady(repo, 'WP-001', 'codex');
    verdict(repo.root, 'WP-001', 'ACCEPTED', { by: 'claude' });
    begin(repo.root, 'WP-003', 'gemini');
    let { plan, state } = load(repo.root);
    let p = progress(plan, state);
    const m1 = p.milestones[0];
    assert.deepEqual([m1.id, m1.total, m1.done, m1.inProgress, m1.notStarted, m1.percent, m1.daysLeft, m1.overdue], ['M1', 4, 1, 1, 2, 25, 19, false]);
    assert.deepEqual(m1.gated, ['WP-004']);
    assert.deepEqual(p.overall, { done: 1, total: 4, percent: 25 });
    assert.deepEqual(p.closedGates.map((g) => g.id), ['G1']);
    process.env.BATON_NOW = '2026-12-01T00:00:00Z';
    p = progress(plan, state);
    assert.equal(p.milestones[0].overdue, true);
    assert.equal(p.milestones[0].daysLeft, -30);
  } finally { done(repo); }
});

test('progress excludes stretch packets and groups unscheduled work', () => {
  const plan = samplePlan();
  plan.packets.push({ id: 'WP-008', title: 'loose', owns: ['docs/z.md'] }, { id: 'WP-009', title: 'extra', owns: ['docs/q.md'], stretch: true });
  const repo = setup({ plan });
  try {
    const { plan: p, state } = load(repo.root);
    const out = progress(p, state);
    assert.equal(out.overall.total, 5);
    assert.deepEqual(out.milestones.map((m) => [m.id, m.total]), [['M1', 4], [null, 1]]);
  } finally { done(repo); }
});

test('heartbeat: a stale lease is never extended by another agent or the reviewer; submit needs the holder', () => {
  const repo = setup();
  try {
    begin(repo.root, 'WP-001', 'codex');
    process.env.BATON_NOW = '2026-10-14T05:00:00Z';
    assert.equal(code(() => heartbeat(repo.root, 'WP-001', 'claude')), 'HELD');
    assert.equal(code(() => heartbeat(repo.root, 'WP-001', 'gemini')), 'HELD');
    reclaim(repo.root, 'WP-001', 'gemini');
    repo.write('work-WP-001.txt', 'x');
    markVerified(repo.root, 'WP-001');
    assert.equal(code(() => submit(repo.root, 'WP-001', { by: 'codex' })), 'HELD', 'the previous holder cannot submit after a reclaim');
    submit(repo.root, 'WP-001', { by: 'gemini' });
    assert.equal(status(repo.root, 'WP-001'), 'READY_FOR_REVIEW');
  } finally { done(repo); }
});

test('reassignReviewer still works on ACCEPTED_WITH_FIXES but not on ACCEPTED', () => {
  const repo = setup();
  try {
    toReady(repo, 'WP-001', 'codex');
    verdict(repo.root, 'WP-001', 'ACCEPTED_WITH_FIXES', { by: 'claude', note: 'rename x' });
    reassignReviewer(repo.root, 'WP-001', 'gemini', { by: 'claude' });
    assert.equal(load(repo.root).state.packets['WP-001'].reviewer, 'gemini');
    begin(repo.root, 'WP-001', 'codex');
    repo.write('work-WP-001.txt', 'fixed');
    markVerified(repo.root, 'WP-001');
    submit(repo.root, 'WP-001', { by: 'codex' });
    verdict(repo.root, 'WP-001', 'ACCEPTED', { by: 'gemini' });
    assert.equal(code(() => reassignReviewer(repo.root, 'WP-001', 'claude', { by: 'claude' })), 'ALREADY_DONE');
  } finally { done(repo); }
});
