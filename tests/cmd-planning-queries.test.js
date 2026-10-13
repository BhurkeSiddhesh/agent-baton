import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../src/cli.js';
import { memoryStream } from '../src/lib/context.js';
import { begin, recordVerify, submit, verdict, postMessage, addFinding, heartbeat } from '../src/lib/engine.js';
import { fingerprint } from '../src/lib/util.js';
import { stateDir } from '../src/lib/store.js';
import { makeTempRepo, samplePlan } from './helpers.js';

const NOW = '2026-10-13T10:00:00Z';
process.env.BATON_NOW = NOW; // library calls made directly by the tests use the same frozen clock

async function baton(root, argv, env = {}) {
  const out = memoryStream(); const err = memoryStream();
  const keep = {};
  const vars = { BATON_NOW: NOW, ...env };
  for (const k of ['BATON_AGENT', 'BATON_NOW', 'BATON_ROOT']) { keep[k] = process.env[k]; delete process.env[k]; }
  const merged = { ...process.env, ...vars };
  Object.assign(process.env, vars);
  try {
    const code = await main(argv, { cwd: root, env: merged, stdout: out, stderr: err });
    return { code, out: out.text(), err: err.text() };
  } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const k of Object.keys(vars)) if (!(k in keep)) delete process.env[k];
  }
}

const withNow = async (iso, fn) => {
  const old = process.env.BATON_NOW;
  process.env.BATON_NOW = iso;
  try { return await fn(); } finally { if (old === undefined) delete process.env.BATON_NOW; else process.env.BATON_NOW = old; }
};

function ready(root, pid, by) {
  begin(root, pid, by);
  recordVerify(root, pid, { ok: true, mode: 'snapshot', commit: null, fingerprint: fingerprint(root), tests: { ran: true, ok: true, tail: 'pass' } });
  submit(root, pid, { by });
}

const ordering = () => samplePlan({
  gates: [],
  packets: [
    { id: 'A-1', title: 'one', track: 'api', agent: 'codex', reviewer: 'claude', owns: ['src/api/a1.js'], priority: 'P2', milestone: 'M1' },
    { id: 'A-2', title: 'two', track: 'api', agent: 'codex', reviewer: 'claude', owns: ['src/api/a2.js'], priority: 'P0', milestone: 'M1' },
    { id: 'A-3', title: 'three', track: 'api', agent: 'codex', reviewer: 'claude', owns: ['src/api/a3.js'], priority: 'P3', milestone: 'M1' },
    { id: 'A-4', title: 'extra', track: 'api', agent: 'codex', reviewer: 'claude', owns: ['src/api/a4.js'], priority: 'P0', stretch: true, milestone: 'M1' },
    { id: 'U-1', title: 'nobody yet', track: 'api', owns: ['src/api/u1.js'], priority: 'P1', milestone: 'M1' },
    { id: 'G-1', title: 'ui work', track: 'ui', agent: 'gemini', reviewer: 'codex', owns: ['src/ui/g1.js'], priority: 'P0', milestone: 'M1' },
  ],
});

test('next orders: reviews, rework, ready by priority, stretch, audit; then the horizon notice', async () => {
  const r = makeTempRepo({ config: true, plan: ordering() });
  try {
    const first = JSON.parse((await baton(r.root, ['next', '--agent', 'codex', '--json'])).out);
    assert.deepEqual(first.queue.map((e) => `${e.kind}:${e.packet}`), ['ready:A-2', 'ready:U-1', 'ready:A-1', 'ready:A-3', 'stretch:A-4']);
    assert.equal(first.next.packet, 'A-2');
    assert.equal(first.next.command, 'node .baton/runtime/bin/baton.js begin A-2 --agent codex');
    assert.equal(first.horizonExhausted, false);
    assert.equal(first.notice, null);

    const idle = await baton(r.root, ['next', '--agent', 'claude']);
    assert.equal(idle.code, 0, idle.err);
    assert.match(idle.out, /HORIZON EXHAUSTED/);
    assert.match(idle.out, /split "<goal>"/);

    ready(r.root, 'A-1', 'codex');
    const rev = JSON.parse((await baton(r.root, ['next', '--agent', 'claude', '--json'])).out);
    assert.deepEqual(rev.queue.map((e) => `${e.kind}:${e.packet}`), ['review:A-1']);
    assert.equal(rev.queue[0].command, 'node .baton/runtime/bin/baton.js review A-1');
    assert.equal(rev.horizonExhausted, true);
    const aud = JSON.parse((await baton(r.root, ['next', '--agent', 'gemini', '--json'])).out);
    assert.deepEqual(aud.queue.map((e) => `${e.kind}:${e.packet}`), ['ready:G-1', 'audit:A-1']);

    verdict(r.root, 'A-1', 'REJECTED', { by: 'claude', note: 'tests missing' });
    const rework = JSON.parse((await baton(r.root, ['next', '--agent', 'codex', '--json'])).out);
    assert.deepEqual(rework.queue.map((e) => `${e.kind}:${e.packet}`), ['rework:A-1', 'ready:A-2', 'ready:U-1', 'ready:A-3', 'stretch:A-4']);
    assert.match(rework.queue[0].why, /REJECTED by claude/);
    const human = await baton(r.root, ['next', '--agent', 'codex']);
    assert.match(human.out, /^next for codex\n/);
    assert.match(human.out, /1 +REWORK +A-1 +P2/);
    assert.match(human.out, /run: node \.baton\/runtime\/bin\/baton\.js begin A-1 --agent codex/);
    assert.doesNotMatch(human.out, /HORIZON/);
  } finally { r.cleanup(); }
});

test('next lists reviews first, accepted-with-fixes rework, stale reclaims and own blocked packets', async () => {
  const r = makeTempRepo({ config: true, plan: ordering() });
  try {
    ready(r.root, 'A-1', 'codex');
    verdict(r.root, 'A-1', 'ACCEPTED_WITH_FIXES', { by: 'claude', note: 'nits' });
    addFinding(r.root, { packet: 'A-1', by: 'claude', severity: 'MINOR', text: 'rename' });
    begin(r.root, 'G-1', 'gemini');
    const codex = JSON.parse((await baton(r.root, ['next', '--agent', 'codex', '--json'])).out);
    assert.equal(codex.queue[0].kind, 'rework');
    assert.match(codex.queue[0].why, /ACCEPTED_WITH_FIXES by claude, 1 open finding/);
    const later = await withNow('2026-10-14T10:00:00Z', async () => JSON.parse((await baton(r.root, ['next', '--agent', 'codex', '--json'], { BATON_NOW: '2026-10-14T10:00:00Z' })).out));
    assert.deepEqual(later.sections.stale.map((e) => e.packet), ['G-1']);
    assert.match(later.sections.stale[0].command, /reclaim G-1 --agent codex/);
    const human = await baton(r.root, ['next', '--agent', 'codex'], { BATON_NOW: '2026-10-14T10:00:00Z' });
    assert.match(human.out, /Stale leases you can reclaim:/);
    assert.equal((await baton(r.root, ['next'])).code, 2);
    assert.equal((await baton(r.root, ['next', '--agent', 'ghost'])).code, 1);
  } finally { r.cleanup(); }
});

test('status shows packets, flags and findings; filters by track and agent; --json', async () => {
  const r = makeTempRepo({ config: true, plan: true });
  try {
    begin(r.root, 'WP-001', 'codex');
    const human = await baton(r.root, ['status']);
    assert.equal(human.code, 0, human.err);
    const lines = human.out.split('\n');
    assert.match(lines[0], /Goal: Ship the sample/);
    assert.match(lines[1], /Packets: 4 +PLANNED 3 {2}IN_PROGRESS 1/);
    const header = lines.find((l) => l.startsWith('ID'));
    const row = lines.find((l) => l.startsWith('WP-001'));
    assert.equal(header.indexOf('STATUS'), row.indexOf('IN_PROGRESS'), 'columns align');
    assert.match(row, /lease 8h left/);
    assert.match(human.out, /Closed gates: G1 \(human\)/);
    assert.doesNotMatch(lines.find((l) => l.startsWith('WP-002')), /AT_RISK/, 'flags only apply to active packets');

    const ui = JSON.parse((await baton(r.root, ['status', '--track', 'ui', '--json'])).out);
    assert.deepEqual(ui.packets.map((p) => p.id), ['WP-003']);
    const claude = JSON.parse((await baton(r.root, ['status', '--agent', 'gemini', '--json'])).out);
    assert.deepEqual(claude.packets.map((p) => p.id), ['WP-003']);
    const rev = JSON.parse((await baton(r.root, ['status', '-a', 'claude', '--json'])).out);
    assert.deepEqual(rev.packets.map((p) => p.id), ['WP-001', 'WP-002', 'WP-004']);

    const stale = JSON.parse((await baton(r.root, ['status', '--json'], { BATON_NOW: '2026-10-14T10:00:00Z' })).out);
    assert.ok(stale.packets.find((p) => p.id === 'WP-001').flags.includes('STALE'));
    assert.match((await baton(r.root, ['status'], { BATON_NOW: '2026-10-14T10:00:00Z' })).out, /WP-001.*STALE/);

    addFinding(r.root, { packet: 'WP-001', by: 'claude', severity: 'MAJOR', text: 'bug' });
    const f = JSON.parse((await baton(r.root, ['status', '--json'])).out).packets.find((p) => p.id === 'WP-001');
    assert.equal(f.openFindings.MAJOR, 1);
    assert.match((await baton(r.root, ['status'])).out, /findings 1M/);
  } finally { r.cleanup(); }
});

test('scores tabulates the ledger per agent, including agents with no activity', async () => {
  const r = makeTempRepo({ config: true, plan: true });
  try {
    ready(r.root, 'WP-001', 'codex');
    verdict(r.root, 'WP-001', 'ACCEPTED', { by: 'claude', score: 8 });
    const j = JSON.parse((await baton(r.root, ['scores', '--json'])).out);
    assert.equal(j.agents.codex.accepted, 1);
    assert.equal(j.agents.codex.firstPassRate, 1);
    assert.equal(j.agents.claude.reviewsGiven, 1);
    assert.equal(j.agents.claude.meanScoreGiven, 8);
    assert.ok('gemini' in j.agents);
    const t = await baton(r.root, ['scores']);
    const lines = t.out.trimEnd().split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^AGENT +START +READY +ACC/);
    assert.match(lines.find((l) => l.startsWith('codex')), /100%/);
    assert.match(lines.find((l) => l.startsWith('claude')), /1\(8\)/);
  } finally { r.cleanup(); }
});

test('release reports milestone progress, overdue milestones and closed gates', async () => {
  const r = makeTempRepo({ config: true, plan: true });
  try {
    ready(r.root, 'WP-001', 'codex');
    verdict(r.root, 'WP-001', 'ACCEPTED', { by: 'claude' });
    const t = await baton(r.root, ['release']);
    assert.equal(t.code, 0, t.err);
    assert.match(t.out, /M1 {2}Alpha {2}due 2026-11-01 \(19d left\)/);
    assert.match(t.out, /\[###-------\] {2}25%  1\/4 done, 0 in review, 0 in progress, 0 blocked, 3 not started, gated: WP-004/);
    assert.match(t.out, /Overall: .* 25% {2}\(1\/4 accepted/);
    assert.match(t.out, /Closed gates:\n {2}G1 {2}Prod key provisioned {2}owner=human/);
    assert.doesNotMatch(t.out, /OVERDUE/);
    const late = await baton(r.root, ['release'], { BATON_NOW: '2026-12-01T00:00:00Z' });
    assert.match(late.out, /OVERDUE/);
    const j = JSON.parse((await baton(r.root, ['release', '--json'])).out);
    assert.equal(j.overall.percent, 25);
    assert.equal(j.milestones[0].done, 1);
  } finally { r.cleanup(); }
});

test('gate list shows effects; open and close respect ownership; refusals', async () => {
  const r = makeTempRepo({ config: true, plan: true });
  try {
    const l = await baton(r.root, ['gate', 'list']);
    assert.match(l.out, /G1 +closed +human +Prod key provisioned +blocks WP-004/);
    assert.equal(JSON.parse((await baton(r.root, ['gate', '--json'])).out).gates[0].open, false);
    assert.equal((await baton(r.root, ['gate', 'open', 'G1'])).code, 2, 'needs --by');
    const denied = await baton(r.root, ['gate', 'open', 'G1', '--by', 'codex']);
    assert.equal(denied.code, 1);
    assert.match(denied.err, /belongs to human/);
    assert.equal((await baton(r.root, ['gate', 'open', 'G9', '--by', 'human'])).code, 1);
    const ok = await baton(r.root, ['gate', 'open', 'G1', '--by', 'human', '--note', 'key issued']);
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /gate G1 opened by human/);
    assert.match((await baton(r.root, ['gate', 'list'])).out, /G1 +open/);
    const codex = JSON.parse((await baton(r.root, ['next', '--agent', 'codex', '--json'])).out);
    assert.ok(codex.queue.some((e) => e.packet === 'WP-004'), 'opening the gate releases the packet');
    assert.match((await baton(r.root, ['gate', 'close', 'G1', '--by', 'human'])).out, /closed/);
    assert.equal((await baton(r.root, ['gate', 'explode'])).code, 2);
  } finally { r.cleanup(); }
});

test('digest reports changes since the last digest and what needs attention', async () => {
  const r = makeTempRepo({ config: true, plan: true });
  try {
    ready(r.root, 'WP-001', 'codex');
    postMessage(r.root, { from: 'codex', type: 'REQUEST', text: 'need src/shared/x.js', packet: 'WP-001' });
    const first = await baton(r.root, ['digest']);
    assert.equal(first.code, 0, first.err);
    assert.match(first.out, /full history/);
    assert.match(first.out, /started \(1\)/);
    assert.match(first.out, /WP-001 started by codex/);
    assert.match(first.out, /ready for review \(1\)/);
    assert.match(first.out, /REQUEST codex->all \[WP-001\]: need src\/shared\/x\.js/);
    assert.match(first.out, /WP-001 waits for review by claude/);
    assert.match(first.out, /gate G1 \(human\) is closed and holds WP-004/);
    assert.match(first.out, /gemini has 1 ready packet\(s\); keep the horizon at least 3 deep/);

    const second = await baton(r.root, ['digest']);
    assert.match(second.out, /since last digest/);
    assert.match(second.out, /Changes: none/);

    verdict(r.root, 'WP-001', 'ACCEPTED', { by: 'claude', score: 7 });
    const peek = JSON.parse((await baton(r.root, ['digest', '--no-mark', '--json'])).out);
    assert.deepEqual(peek.changes.map((c) => c.group), ['verdicts']);
    assert.match(peek.changes[0].text, /WP-001 ACCEPTED by claude score 7/);
    const again = JSON.parse((await baton(r.root, ['digest', '--json'])).out);
    assert.equal(again.changes.length, 1, '--no-mark left the marker alone');
    assert.equal(JSON.parse((await baton(r.root, ['digest', '--json'])).out).changes.length, 0);

    const all = JSON.parse((await baton(r.root, ['digest', '--since', 'all', '--json'])).out);
    assert.ok(all.changes.length >= 4);
    const after = JSON.parse((await baton(r.root, ['digest', '--since', '2026-10-13T10:00:00Z', '--json'])).out);
    assert.equal(after.changes.length, 0, 'strictly after the timestamp');
    const before = JSON.parse((await baton(r.root, ['digest', '--since', '2026-10-13T09:59:59Z', '--json'])).out);
    assert.equal(before.changes.length, all.changes.length);
    assert.equal((await baton(r.root, ['digest', '--since', 'yesterday-ish'])).code, 1);
    assert.ok(fs.existsSync(path.join(stateDir(r.root), 'digest.json')));
  } finally { r.cleanup(); }
});

test('digest flags stale leases and escalations', async () => {
  const r = makeTempRepo({ config: true, plan: true });
  try {
    begin(r.root, 'WP-001', 'codex');
    heartbeat(r.root, 'WP-001', 'codex');
    const d = JSON.parse((await baton(r.root, ['digest', '--no-mark', '--json'], { BATON_NOW: '2026-10-14T10:00:00Z' })).out);
    assert.ok(d.attention.some((a) => a.type === 'stale' && a.packet === 'WP-001'));
  } finally { r.cleanup(); }
});

test('check passes on a healthy repo and fails on plan, ownership and ledger problems', async () => {
  const r = makeTempRepo({ config: true, plan: true });
  try {
    ready(r.root, 'WP-001', 'codex');
    const ok = await baton(r.root, ['check']);
    assert.equal(ok.code, 0, ok.out + ok.err);
    assert.match(ok.out, /check ok: 4 packet\(s\)/);
    const j = JSON.parse((await baton(r.root, ['check', '--json'])).out);
    assert.equal(j.ok, true);

    const stale = await baton(r.root, ['check'], { BATON_NOW: '2026-10-20T10:00:00Z' });
    assert.equal(stale.code, 0);

    const eventsDir = path.join(stateDir(r.root), 'events');
    const file = fs.readdirSync(eventsDir).sort()[0];
    const ev = JSON.parse(fs.readFileSync(path.join(eventsDir, file), 'utf8'));
    ev.note = 'rewritten history';
    fs.writeFileSync(path.join(eventsDir, file), JSON.stringify(ev));
    const bad = await baton(r.root, ['check']);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /error +\[ledger\]/);
    assert.match(bad.out, /check FAILED/);
    const jb = JSON.parse((await baton(r.root, ['check', '--json'])).out);
    assert.equal(jb.ok, false);
    assert.ok(jb.errors.every((e) => e.area && e.message));
  } finally { r.cleanup(); }
});

test('check reports overlapping ownership, protected track paths and missing setup', async () => {
  const p = samplePlan();
  p.packets[2].owns = ['src/api/export.js'];
  p.packets[2].deps = [];
  p.tracks[1].owns = ['src/ui/', 'secrets/'];
  const r = makeTempRepo({ config: true, plan: p });
  try {
    const bad = JSON.parse((await baton(r.root, ['check', '--json'])).out);
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.area === 'ownership' && /cross-track overlap/.test(e.message)));
    assert.ok(bad.errors.some((e) => e.area === 'protected' && /secrets/.test(e.message)));
  } finally { r.cleanup(); }
  const empty = makeTempRepo({});
  try {
    const none = await baton(empty.root, ['check', '--json']);
    assert.equal(none.code, 1);
    const doc = JSON.parse(none.out);
    assert.equal(doc.errors[0].area, 'config');
    assert.match(doc.errors[0].message, /not a baton project/);
  } finally { empty.cleanup(); }
});

test('check warns about stale leases without failing', async () => {
  const r = makeTempRepo({ config: true, plan: true });
  try {
    begin(r.root, 'WP-001', 'codex');
    const out = await baton(r.root, ['check'], { BATON_NOW: '2026-10-14T10:00:00Z' });
    assert.equal(out.code, 0);
    assert.match(out.out, /warning \[lease\] WP-001: lease expired/);
  } finally { r.cleanup(); }
});

test('render writes STATUS, BUS, SCOREBOARD and PLAN views deterministically', async () => {
  const r = makeTempRepo({ config: true, plan: true });
  try {
    ready(r.root, 'WP-001', 'codex');
    verdict(r.root, 'WP-001', 'ACCEPTED', { by: 'claude', score: 9 });
    const res = await baton(r.root, ['render']);
    assert.equal(res.code, 0, res.err);
    assert.match(res.out, /wrote 4 views to \.baton\/views: STATUS\.md, BUS\.md, SCOREBOARD\.md, PLAN\.md/);
    const dir = path.join(r.root, '.baton', 'views');
    const status = fs.readFileSync(path.join(dir, 'STATUS.md'), 'utf8');
    assert.match(status, /^# Status: sample/);
    assert.match(status, /\| WP-001 \| P0 \| ACCEPTED \| codex \| claude \| api \| Exporter \|/);
    assert.match(status, /\*\*Overall:\*\* 25%/);
    const bus = fs.readFileSync(path.join(dir, 'BUS.md'), 'utf8');
    assert.match(bus, /\| CLAIM \| WP-001 \| WP-001 Exporter\. Owns: src\/api\/export\.js/);
    assert.match(bus, /VERDICT/);
    assert.match(fs.readFileSync(path.join(dir, 'SCOREBOARD.md'), 'utf8'), /\| claude \| 0 \| 0 \| 0 \| 0 \| 0 \| 0 \| - \| 1 \| 9 \|/);
    const planMd = fs.readFileSync(path.join(dir, 'PLAN.md'), 'utf8');
    assert.match(planMd, /### WP-001 Exporter/);
    assert.match(planMd, /- \[x\] tests green/);
    const snapshot = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
    await baton(r.root, ['render']);
    assert.deepEqual(fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')), snapshot);

    const custom = await baton(r.root, ['render', '--out', 'out/views', '--json']);
    const doc = JSON.parse(custom.out);
    assert.equal(doc.files.length, 4);
    assert.ok(fs.existsSync(path.join(r.root, 'out', 'views', 'PLAN.md')));
  } finally { r.cleanup(); }
});

test('every query command prints exactly one JSON document with --json', async () => {
  const r = makeTempRepo({ config: true, plan: true });
  try {
    for (const argv of [['plan', 'show'], ['plan', 'validate'], ['plan', 'graph'], ['status'], ['next', '--agent', 'codex'], ['scores'], ['release'], ['digest', '--no-mark'], ['check'], ['gate', 'list'], ['render', '--out', 'v']]) {
      const res = await baton(r.root, [...argv, '--json']);
      assert.doesNotThrow(() => JSON.parse(res.out), `${argv.join(' ')} -> ${res.out.slice(0, 80)}`);
      assert.equal(res.out.trimEnd().split('\n').filter((l) => /^\S/.test(l) && !/^[{}\[\]]/.test(l)).length, 0, `${argv.join(' ')} printed extra text`);
    }
  } finally { r.cleanup(); }
});
