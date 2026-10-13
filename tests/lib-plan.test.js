import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPlan, savePlan, validatePlan, nextPacketId, topoOrder, hasCycle, findCycle, transitiveDeps, normalizePlan, planHash, packetsOverlap } from '../src/lib/plan.js';
import { makeTempRepo, sampleConfig, samplePlan } from './helpers.js';

const cfg = sampleConfig();
const pk = (id, over = {}) => ({ id, title: id, track: 'api', agent: 'codex', reviewer: 'claude', owns: [`src/api/${id}.js`], ...over });
const plan = (packets, over = {}) => ({ version: 1, goal: '', tracks: samplePlan().tracks, gates: samplePlan().gates, milestones: samplePlan().milestones, packets, ...over });
const errs = (p, c = cfg, o) => validatePlan(p, c, o).errors;
const warns = (p, c = cfg, o) => validatePlan(p, c, o).warnings;

test('sample plan is valid', () => {
  assert.deepEqual(validatePlan(samplePlan(), cfg), { errors: [], warnings: [] });
});

test('validatePlan rules, table driven (error substrings)', () => {
  const rows = [
    ['duplicate id', plan([pk('A'), pk('A', { owns: ['src/api/z.js'] })]), /duplicate packet id A/],
    ['bad id', plan([pk('-bad')]), /packet id invalid/],
    ['unknown agent', plan([pk('A', { agent: 'zed' })]), /agent "zed" is not in the roster/],
    ['unknown reviewer', plan([pk('A', { reviewer: 'zed' })]), /reviewer "zed"/],
    ['reviewer equals author', plan([pk('A', { reviewer: 'codex' })]), /reviewer equals author/],
    ['owns nothing', plan([pk('A', { owns: [] })]), /owns nothing/],
    ['absolute owns', plan([pk('A', { owns: ['/etc/passwd'] })]), /repo-relative/],
    ['drive owns', plan([pk('A', { owns: ['C:/x.js'] })]), /repo-relative/],
    ['dotdot owns', plan([pk('A', { owns: ['src/../x.js'] })]), /"\.\."/],
    ['backslash owns', plan([pk('A', { owns: ['src\\x.js'] })]), /forward slashes/],
    ['protected owns', plan([pk('A', { owns: ['.env'] })]), /protected path \.env/],
    ['protected dir owns', plan([pk('A', { owns: ['secrets/'] })]), /protected/],
    ['unknown dep', plan([pk('A', { deps: ['Q'] })]), /unknown dependency Q/],
    ['unknown needs_done', plan([pk('A', { needs_done: ['Q'] })]), /unknown dependency Q/],
    ['self dep', plan([pk('A', { deps: ['A'] })]), /depends on itself/],
    ['unknown gate', plan([pk('A', { gate: 'G9' })]), /unknown gate G9/],
    ['unknown milestone', plan([pk('A', { milestone: 'M9' })]), /unknown milestone/],
    ['unknown track', plan([pk('A', { track: 'zzz' })]), /unknown track zzz/],
    ['bad priority', plan([pk('A', { priority: 'P9' })]), /priority/],
    ['bad gate_mode', plan([pk('A', { gate_mode: 'sometimes' })]), /gate_mode/],
    ['cycle', plan([pk('A', { deps: ['B'] }), pk('B', { deps: ['A'] })]), /dependency cycle: A -> B -> A|dependency cycle: B -> A -> B/],
    ['cross-track overlap', plan([pk('A', { owns: ['src/shared/'] }), pk('B', { track: 'ui', agent: 'gemini', reviewer: 'codex', owns: ['src/shared/x.js'] })]), /cross-track overlap/],
    ['track owner unknown', plan([], { tracks: [{ id: 'api', owner: 'zed', owns: ['src/api/'] }] }), /owner "zed"/],
    ['track overlap', plan([], { tracks: [{ id: 'a', owner: 'codex', owns: ['src/'] }, { id: 'b', owner: 'gemini', owns: ['src/ui/'] }] }), /tracks a and b have overlapping/],
    ['bad version', { ...plan([]), version: 2 }, /version/],
  ];
  for (const [name, p, re] of rows) assert.ok(errs(p).some((e) => re.test(e)), `${name}: ${JSON.stringify(errs(p))}`);
});

test('validatePlan warnings: same-track overlap, unassigned, outside track, wrong track owner', () => {
  assert.ok(warns(plan([pk('A', { owns: ['src/api/'] }), pk('B', { owns: ['src/api/x.js'] })])).some((w) => /same-track overlap/.test(w)));
  assert.deepEqual(errs(plan([pk('A', { owns: ['src/api/'] }), pk('B', { owns: ['src/api/x.js'] })])), []);
  assert.ok(warns(plan([pk('A', { agent: null })])).some((w) => /no agent assigned/.test(w)));
  assert.ok(warns(plan([pk('A', { reviewer: null })])).some((w) => /no reviewer assigned/.test(w)));
  assert.ok(warns(plan([pk('A', { owns: ['lib/x.js'] })])).some((w) => /outside track api/.test(w)));
  assert.ok(warns(plan([pk('A', { agent: 'gemini', reviewer: 'claude' })])).some((w) => /not the owner of track/.test(w)));
});

test('overlap between packets is fine when sequenced by dependency (direct or transitive) or when one is done', () => {
  const a = pk('A', { owns: ['src/api/'] });
  assert.deepEqual(errs(plan([a, pk('B', { track: 'ui', agent: 'gemini', reviewer: 'codex', owns: ['src/api/x.js'], deps: ['A'] })])), []);
  const chain = plan([a, pk('B', { owns: ['src/api/b.js'], deps: ['A'] }), pk('C', { track: 'ui', agent: 'gemini', reviewer: 'codex', owns: ['src/api/c.js'], needs_done: ['B'] })]);
  assert.deepEqual(errs(chain), []);
  const clash = plan([a, pk('B', { track: 'ui', agent: 'gemini', reviewer: 'codex', owns: ['src/api/x.js'] })]);
  assert.equal(errs(clash).length, 1);
  assert.deepEqual(errs(clash, cfg, { done: ['A'] }), []);
});

test('requireDifferentReviewer=false allows self review', () => {
  assert.deepEqual(errs(plan([pk('A', { reviewer: 'codex' })]), { ...cfg, requireDifferentReviewer: false }), []);
});

test('config.protected.globs extend the protected list', () => {
  const c = { ...cfg, protected: { globs: ['*.secret'] } };
  assert.ok(errs(plan([pk('A', { owns: ['src/api/a.secret'] })]), c).some((e) => /protected/.test(e)));
});

test('graph helpers', () => {
  const p = normalizePlan(plan([pk('C', { deps: ['B'] }), pk('B', { deps: ['A'] }), pk('A'), pk('D', { needs_done: ['C'] })]));
  assert.deepEqual(topoOrder(p), ['A', 'B', 'C', 'D']);
  assert.equal(hasCycle(p), false);
  assert.deepEqual([...transitiveDeps(p, 'D')].sort(), ['A', 'B', 'C']);
  assert.deepEqual([...transitiveDeps(p, 'A')], []);
  const cyc = normalizePlan(plan([pk('A', { deps: ['B'] }), pk('B', { deps: ['C'] }), pk('C', { deps: ['A'] })]));
  assert.equal(hasCycle(cyc), true);
  assert.equal(findCycle(cyc).length, 4);
  assert.throws(() => topoOrder(cyc), /cycle/);
});

test('nextPacketId', () => {
  assert.equal(nextPacketId({ packets: [] }), 'WP-001');
  assert.equal(nextPacketId({ packets: [{ id: 'WP-009' }, { id: 'WP-002' }, { id: 'X-1' }] }), 'WP-010');
  assert.equal(nextPacketId({ packets: [{ id: 'T-1' }] }, 'T'), 'T-002');
  assert.equal(nextPacketId({ packets: [{ id: 'WP-999' }] }), 'WP-1000');
});

test('packetsOverlap returns the clashing pattern pairs', () => {
  assert.deepEqual(packetsOverlap({ owns: ['a/', 'b.js'] }, { owns: ['a/x.js', 'c.js'] }), [['a/', 'a/x.js']]);
});

test('savePlan/loadPlan: stable key order, trailing newline, defaults, round trip', () => {
  const repo = makeTempRepo({ config: true });
  try {
    savePlan(repo.root, { packets: [{ owns: ['x'], title: 't', id: 'WP-001', zzz: 1 }], goal: 'g', version: 1 });
    const text = fs.readFileSync(path.join(repo.root, '.baton', 'plan.json'), 'utf8');
    assert.ok(text.endsWith('}\n'));
    assert.ok(text.indexOf('"goal"') < text.indexOf('"packets"'));
    const first = text.slice(text.indexOf('"packets"'));
    assert.ok(first.indexOf('"id"') < first.indexOf('"title"') && first.indexOf('"title"') < first.indexOf('"owns"') && first.indexOf('"owns"') < first.indexOf('"zzz"'));
    const loaded = loadPlan(repo.root);
    assert.equal(loaded.packets[0].priority, 'P2');
    assert.equal(loaded.packets[0].gate_mode, 'start');
    assert.equal(loaded.packets[0].stretch, false);
    assert.deepEqual(loaded.packets[0].deps, []);
  } finally { repo.cleanup(); }
});

test('savePlan is idempotent after the first normalisation, planHash is stable', () => {
  const repo = makeTempRepo({ config: true });
  try {
    savePlan(repo.root, samplePlan());
    const a = fs.readFileSync(path.join(repo.root, '.baton', 'plan.json'), 'utf8');
    savePlan(repo.root, loadPlan(repo.root));
    assert.equal(fs.readFileSync(path.join(repo.root, '.baton', 'plan.json'), 'utf8'), a);
    assert.equal(planHash(loadPlan(repo.root)), planHash(samplePlan()));
  } finally { repo.cleanup(); }
});

test('loadPlan errors', () => {
  const repo = makeTempRepo({ config: true });
  try {
    assert.throws(() => loadPlan(repo.root), (e) => e.code === 'NO_PLAN');
    repo.write('.baton/plan.json', '[1]');
    assert.throws(() => loadPlan(repo.root), (e) => e.code === 'BAD_PLAN');
    repo.write('.baton/plan.json', '{nope');
    assert.throws(() => loadPlan(repo.root), (e) => e.code === 'BAD_JSON');
  } finally { repo.cleanup(); }
});
