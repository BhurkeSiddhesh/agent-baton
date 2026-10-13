import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../src/cli.js';
import { memoryStream } from '../src/lib/context.js';
import { readEvents } from '../src/lib/store.js';
import { loadPlan } from '../src/lib/plan.js';
import { begin, recordVerify, submit, verdict } from '../src/lib/engine.js';
import { fingerprint } from '../src/lib/util.js';
import { mergeProposal, normalizeProposal } from '../src/commands/plan.js';
import { makeTempRepo, cleanEnv, BIN, samplePlan } from './helpers.js';

const NOW = '2026-10-13T10:00:00Z';

/** Run the CLI in-process; BATON_* variables are set on process.env for the call (the library reads them there). */
async function baton(root, argv, env = {}) {
  const out = memoryStream(); const err = memoryStream();
  const keep = {};
  const vars = { BATON_NOW: NOW, ...env };
  for (const k of ['BATON_AGENT', 'BATON_NOW', 'BATON_ROOT']) { keep[k] = process.env[k]; delete process.env[k]; }
  Object.assign(process.env, vars);
  try {
    const code = await main(argv, { cwd: root, env: { ...process.env }, stdout: out, stderr: err });
    return { code, out: out.text(), err: err.text() };
  } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    for (const k of Object.keys(vars)) if (!(k in keep)) delete process.env[k];
  }
}

function repo(plan = true) {
  return makeTempRepo({ config: true, plan });
}

function finish(root, pid, author = 'codex', reviewer = 'claude') {
  begin(root, pid, author);
  recordVerify(root, pid, { ok: true, mode: 'snapshot', commit: null, fingerprint: fingerprint(root), tests: { ran: true, ok: true, tail: 'pass' } });
  submit(root, pid, { by: author });
  verdict(root, pid, 'ACCEPTED', { by: reviewer, score: 9 });
}

test('plan show prints goal, counts, packets and tracks; --json is one document', async () => {
  const r = repo();
  try {
    const t = await baton(r.root, ['plan', 'show']);
    assert.equal(t.code, 0);
    assert.match(t.out, /Goal: Ship the sample/);
    assert.match(t.out, /WP-001 +P0 +PLANNED +codex>claude +api +Exporter/);
    assert.match(t.out, /Tracks:/);
    assert.doesNotMatch(t.out, /\u001b\[/);
    const j = await baton(r.root, ['plan', 'show', '--json']);
    const doc = JSON.parse(j.out);
    assert.equal(doc.plan.packets.length, 4);
    assert.equal(doc.statuses['WP-001'], 'PLANNED');
    const one = await baton(r.root, ['plan', 'show', 'WP-002']);
    assert.match(one.out, /deps +WP-001/);
    const bad = await baton(r.root, ['plan', 'show', 'WP-999']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /unknown packet/);
  } finally { r.cleanup(); }
});

test('plan validate exits 0 for a valid plan and 1 with errors', async () => {
  const r = repo();
  try {
    const ok = await baton(r.root, ['plan', 'validate']);
    assert.equal(ok.code, 0);
    assert.match(ok.out, /plan valid/);
    const p = samplePlan();
    p.packets[1].reviewer = 'codex';
    r.write('.baton/plan.json', JSON.stringify(p));
    const bad = await baton(r.root, ['plan', 'validate', '--json']);
    assert.equal(bad.code, 1);
    const doc = JSON.parse(bad.out);
    assert.equal(doc.ok, false);
    assert.ok(doc.errors.some((e) => /reviewer equals author/.test(e)));
  } finally { r.cleanup(); }
});

test('plan add assigns the next id, validates, writes a plan event and keeps the file stable', async () => {
  const r = repo();
  try {
    const a = await baton(r.root, ['plan', 'add', '--title', 'Audit log', '--track', 'api', '--owns', 'src/api/audit.js,tests/api/audit.test.js', '--agent', 'codex', '--reviewer', 'gemini',
      '--priority', 'P1', '--milestone', 'M1', '--check', 'logs written', '--check', 'tests green', '--deps', 'WP-001', '--description', 'why', '--stretch']);
    assert.equal(a.code, 0, a.err);
    assert.match(a.out, /added WP-005/);
    const plan = loadPlan(r.root);
    const p = plan.packets.find((x) => x.id === 'WP-005');
    assert.deepEqual(p.owns, ['src/api/audit.js', 'tests/api/audit.test.js']);
    assert.deepEqual(p.done_checks, ['logs written', 'tests green']);
    assert.equal(p.stretch, true);
    assert.equal(p.priority, 'P1');
    assert.ok(readEvents(r.root).some((e) => e.kind === 'plan' && e.data.hash));
    const before = r.read('.baton/plan.json');
    const again = await baton(r.root, ['plan', 'validate']);
    assert.equal(again.code, 0);
    assert.equal(r.read('.baton/plan.json'), before);
    const explicit = await baton(r.root, ['plan', 'add', '--id', 'X-1', '--title', 'Misc', '--owns', 'src/misc/x.js']);
    assert.equal(explicit.code, 0, explicit.err);
    assert.match(explicit.out, /added X-1/);
    const dupe = await baton(r.root, ['plan', 'add', '--id', 'X-1', '--title', 'Misc', '--owns', 'src/other.js']);
    assert.equal(dupe.code, 1);
  } finally { r.cleanup(); }
});

test('plan add refuses missing title or owns, protected paths, overlaps and non-orchestrators', async () => {
  const r = repo();
  try {
    assert.equal((await baton(r.root, ['plan', 'add'])).code, 2);
    const noOwns = await baton(r.root, ['plan', 'add', '--title', 'X']);
    assert.equal(noOwns.code, 1);
    assert.match(noOwns.err, /owns nothing/);
    const prot = await baton(r.root, ['plan', 'add', '--title', 'X', '--owns', '.env']);
    assert.equal(prot.code, 1);
    assert.match(prot.err, /protected/);
    const clash = await baton(r.root, ['plan', 'add', '--title', 'X', '--owns', 'src/ui/button.js', '--track', 'api']);
    assert.equal(clash.code, 1);
    assert.match(clash.err, /cross-track overlap/);
    const worker = await baton(r.root, ['plan', 'add', '--title', 'X', '--owns', 'src/z.js', '--by', 'codex']);
    assert.equal(worker.code, 1);
    assert.match(worker.err, /only the orchestrator/);
    const viaEnv = await baton(r.root, ['plan', 'add', '--title', 'X', '--owns', 'src/z.js'], { BATON_AGENT: 'gemini' });
    assert.equal(viaEnv.code, 1);
    const orch = await baton(r.root, ['plan', 'add', '--title', 'X', '--owns', 'src/z.js', '--by', 'claude']);
    assert.equal(orch.code, 0, orch.err);
    assert.equal(loadPlan(r.root).packets.length, 5);
  } finally { r.cleanup(); }
});

test('plan edit changes only the given fields, clears with none, and protects started packets', async () => {
  const r = repo();
  try {
    const e = await baton(r.root, ['plan', 'edit', 'WP-003', '--reviewer', 'claude', '--priority', 'P0', '--deps', 'none', '--no-stretch']);
    assert.equal(e.code, 0, e.err);
    assert.match(e.out, /edited WP-003: reviewer, priority, deps/);
    const p = loadPlan(r.root).packets.find((x) => x.id === 'WP-003');
    assert.equal(p.reviewer, 'claude');
    assert.deepEqual(p.deps, []);
    assert.equal(p.title, 'Export button');
    assert.equal((await baton(r.root, ['plan', 'edit', 'WP-003'])).code, 2);
    const same = await baton(r.root, ['plan', 'edit', 'WP-003', '--reviewer', 'gemini']);
    assert.equal(same.code, 1);
    assert.match(same.err, /reviewer equals author/);
    assert.equal((await baton(r.root, ['plan', 'edit', 'WP-404', '--title', 'x'])).code, 1);
    assert.equal((await baton(r.root, ['plan', 'edit', 'WP-001', '--priority', 'P9'])).code, 2);
    begin(r.root, 'WP-001', 'codex');
    const locked = await baton(r.root, ['plan', 'edit', 'WP-001', '--owns', 'src/api/other.js']);
    assert.equal(locked.code, 1);
    assert.match(locked.err, /IN_PROGRESS/);
    const fine = await baton(r.root, ['plan', 'edit', 'WP-001', '--description', 'more detail']);
    assert.equal(fine.code, 0, fine.err);
  } finally { r.cleanup(); }
});

test('plan rm removes unstarted packets, protects dependents and history', async () => {
  const r = repo();
  try {
    const dep = await baton(r.root, ['plan', 'rm', 'WP-001']);
    assert.equal(dep.code, 1);
    assert.match(dep.err, /WP-002, WP-003 depend on WP-001/);
    const forced = await baton(r.root, ['plan', 'rm', 'WP-001', '--force']);
    assert.equal(forced.code, 0, forced.err);
    const plan = loadPlan(r.root);
    assert.equal(plan.packets.some((p) => p.id === 'WP-001'), false);
    assert.deepEqual(plan.packets.find((p) => p.id === 'WP-002').deps, []);
    begin(r.root, 'WP-002', 'codex');
    const started = await baton(r.root, ['plan', 'rm', 'WP-002']);
    assert.equal(started.code, 1);
    assert.match(started.err, /already has history/);
    assert.equal((await baton(r.root, ['plan', 'rm'])).code, 2);
  } finally { r.cleanup(); }
});

test('mergeProposal renumbers colliding and missing ids and rewrites references inside the proposal', () => {
  const plan = { ...samplePlan(), packets: samplePlan().packets };
  const proposal = { packets: [
    { id: 'WP-001', title: 'New A', owns: ['src/n/a.js'] },
    { title: 'New B', owns: ['src/n/b.js'], deps: ['WP-001'] },
    { id: 'NEW-1', title: 'New C', owns: ['src/n/c.js'], deps: ['WP-002', 'WP-004'] },
  ] };
  const m = mergeProposal(plan, proposal);
  assert.deepEqual(m.added, ['WP-005', 'WP-006', 'NEW-1']);
  assert.deepEqual(m.remap, { 'WP-001': 'WP-005' });
  const b = m.plan.packets.find((p) => p.title === 'New B');
  assert.deepEqual(b.deps, ['WP-005']);
  assert.equal(m.plan.packets.length, 7);
  assert.throws(() => mergeProposal(plan, { packets: [{ id: 'A' }, { id: 'A' }] }), /two packets with id A/);
  assert.throws(() => normalizeProposal({ nope: 1 }), /packets/);
  assert.deepEqual(normalizeProposal([{ title: 'x' }]).packets.length, 1);
});

test('plan import merges a proposal, supports --dry-run, JSON output and validation refusals', async () => {
  const r = repo();
  try {
    const file = path.join(r.root, 'prop.json');
    fs.writeFileSync(file, JSON.stringify({ packets: [
      { id: 'WP-001', title: 'Docs', track: 'api', owns: ['src/api/docs.js'], priority: 'P3' },
      { title: 'More docs', track: 'api', owns: ['src/api/docs2.js'], deps: ['WP-001'] },
    ] }));
    const dry = await baton(r.root, ['plan', 'import', file, '--dry-run']);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /would import 2 packet/);
    assert.match(dry.out, /renumbered: WP-001->WP-005/);
    assert.equal(loadPlan(r.root).packets.length, 4);
    const real = await baton(r.root, ['plan', 'import', file, '--json']);
    assert.equal(real.code, 0, real.err);
    const doc = JSON.parse(real.out);
    assert.deepEqual(doc.added, ['WP-005', 'WP-006']);
    assert.equal(doc.dryRun, false);
    const plan = loadPlan(r.root);
    assert.equal(plan.packets.length, 6);
    assert.deepEqual(plan.packets[5].deps, ['WP-005']);
    assert.ok(readEvents(r.root).some((e) => e.kind === 'plan' && /import/.test(e.note)));

    const badFile = path.join(r.root, 'bad.json');
    fs.writeFileSync(badFile, JSON.stringify({ packets: [{ title: 'Bad', owns: ['../escape.js'], agent: 'nobody' }] }));
    const bad = await baton(r.root, ['plan', 'import', badFile]);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /not in the roster/);
    const badDry = await baton(r.root, ['plan', 'import', badFile, '--dry-run']);
    assert.equal(badDry.code, 1);
    assert.match(badDry.out, /would be refused/);
    assert.equal((await baton(r.root, ['plan', 'import', path.join(r.root, 'missing.json')])).code, 1);
    fs.writeFileSync(badFile, '{not json');
    assert.equal((await baton(r.root, ['plan', 'import', badFile])).code, 1);
    assert.equal((await baton(r.root, ['plan', 'import', file, '--merge', '--replace'])).code, 2);
  } finally { r.cleanup(); }
});

test('plan import --replace swaps the packets but refuses to drop packets with history; stdin works', async () => {
  const r = repo();
  try {
    const fresh = { goal: 'New goal', packets: [{ id: 'WP-001', title: 'Exporter v2', track: 'api', agent: 'codex', reviewer: 'claude', owns: ['src/api/export.js'] }] };
    finish(r.root, 'WP-001');
    const f = path.join(r.root, 'fresh.json');
    fs.writeFileSync(f, JSON.stringify({ packets: [{ id: 'WP-009', title: 'only', owns: ['src/only.js'] }] }));
    const lost = await baton(r.root, ['plan', 'import', f, '--replace']);
    assert.equal(lost.code, 1);
    assert.match(lost.err, /already have history: WP-001/);
    const r2 = repo();
    try {
      const res = spawnSync(process.execPath, [BIN, 'plan', 'import', '-', '--replace', '--by', 'claude'], { cwd: r2.root, input: JSON.stringify(fresh), encoding: 'utf8', env: cleanEnv({ BATON_NOW: NOW }) });
      assert.equal(res.status, 0, res.stderr);
      const plan = loadPlan(r2.root);
      assert.equal(plan.packets.length, 1);
      assert.equal(plan.goal, 'New goal');
      assert.equal(plan.tracks.length, 2, 'tracks survive when the proposal has none');
    } finally { r2.cleanup(); }
  } finally { r.cleanup(); }
});

test('plan graph prints an ASCII tree (with status) or Mermaid', async () => {
  const r = repo(samplePlan({ packets: [...samplePlan().packets.slice(0, 3), { id: 'WP-004', title: 'Final', track: 'api', agent: 'codex', reviewer: 'claude', owns: ['src/api/final.js'], needs_done: ['WP-002', 'WP-003'] }] }));
  try {
    const t = await baton(r.root, ['plan', 'graph']);
    assert.equal(t.code, 0, t.err);
    const lines = t.out.trimEnd().split('\n');
    assert.equal(lines[0], 'WP-001 Exporter [PLANNED]');
    assert.ok(lines.some((l) => /^\|- WP-002 Export route \[PLANNED\]$/.test(l)));
    assert.ok(lines.some((l) => /\(needs accepted\) WP-004 Final/.test(l)));
    assert.ok(lines.some((l) => /WP-004 Final \[PLANNED\] \(see above\)/.test(l)));
    const m = await baton(r.root, ['plan', 'graph', '--mermaid']);
    assert.match(m.out, /^graph TD/);
    assert.match(m.out, /n_WP_001\["WP-001: Exporter<br\/>PLANNED"\]/);
    assert.match(m.out, /n_WP_002 ==> n_WP_004/);
    assert.match(m.out, /n_WP_001 --> n_WP_002/);
    const j = JSON.parse((await baton(r.root, ['plan', 'graph', '--json'])).out);
    assert.equal(j.edges.length, 4);
  } finally { r.cleanup(); }
});

test('plan needs a known subcommand', async () => {
  const r = repo();
  try {
    assert.equal((await baton(r.root, ['plan'])).code, 2);
    assert.equal((await baton(r.root, ['plan', 'frobnicate'])).code, 2);
  } finally { r.cleanup(); }
});
