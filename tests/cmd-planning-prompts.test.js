import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../src/cli.js';
import { memoryStream } from '../src/lib/context.js';
import { loadPlan } from '../src/lib/plan.js';
import { readEvents } from '../src/lib/store.js';
import { extractJsonObjects, extractProposal, resolveRunner } from '../src/commands/split.js';
import { makePainter, renderTable, clip, bar, treeSummary } from '../src/lib/views.js';
import { makeTempRepo, samplePlan } from './helpers.js';

const NOW = '2026-10-13T10:00:00Z';

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

/** Temp templates dir (BATON_TEMPLATES_DIR) with minimal prompts and one partial. */
function templates() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-tpl-'));
  fs.mkdirSync(path.join(dir, 'prompts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'partials'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'partials', 'rules.md'), 'RULES: {{rules}}\n');
  fs.writeFileSync(path.join(dir, 'prompts', 'split.md'), [
    'SPLIT for {{project.name}}: {{goal}}',
    '{{#each agents}}- {{this.id}} ({{this.strengths}})',
    '{{/each}}TREE:',
    '{{tree}}',
    'SCHEMA:{{schema}}',
    '{{> rules}}',
    'next id {{nextId}} via {{cli}}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(dir, 'prompts', 'worker.md'), 'You are {{agentName}} ({{agent}}), a {{roleTitle}} on {{project.name}}. Test: {{testCommand}}. Run {{cli}} next --agent {{agent}}.\n');
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const unassigned = () => samplePlan({
  tracks: [{ id: 'api', owner: 'codex', theme: 'API', owns: ['src/api/', 'tests/api/'] }, { id: 'ui', owner: 'gemini', theme: 'UI', owns: ['src/ui/'] }],
  packets: [
    { id: 'WP-001', title: 'Backend exporter', track: 'api', owns: ['src/api/export.js'], priority: 'P0' },
    { id: 'WP-002', title: 'Frontend button', track: 'ui', owns: ['src/ui/button.js'] },
    { id: 'WP-003', title: 'Write tests for exporter', description: 'backend tests', owns: ['tests/api/export.test.js'] },
    { id: 'WP-004', title: 'Docs', agent: 'codex', owns: ['docs/export.md'] },
  ],
});

test('assign fills authors (track owner, strengths) and reviewers (never the author, rotated); is deterministic', async () => {
  const r = makeTempRepo({ config: true, plan: unassigned() });
  try {
    const dry = await baton(r.root, ['assign', '--dry-run']);
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /nothing written/);
    assert.equal(loadPlan(r.root).packets[0].agent, null);
    const real = await baton(r.root, ['assign', '--json']);
    assert.equal(real.code, 0, real.err);
    const doc = JSON.parse(real.out);
    assert.equal(doc.changes.length, 4);
    const plan = loadPlan(r.root);
    const by = Object.fromEntries(plan.packets.map((p) => [p.id, p]));
    assert.equal(by['WP-001'].agent, 'codex');
    assert.equal(by['WP-002'].agent, 'gemini');
    assert.equal(by['WP-003'].agent, 'codex', 'strengths backend+tests');
    assert.equal(by['WP-004'].agent, 'codex', 'existing author kept');
    for (const p of plan.packets) { assert.ok(p.reviewer); assert.notEqual(p.reviewer, p.agent); }
    const load = {};
    for (const p of plan.packets) load[p.reviewer] = (load[p.reviewer] || 0) + 1;
    assert.ok(Math.max(...Object.values(load)) - Math.min(...['claude', 'codex', 'gemini'].map((a) => load[a] || 0)) <= 2, `reviews spread: ${JSON.stringify(load)}`);
    assert.ok(readEvents(r.root).some((e) => e.kind === 'plan' && e.note === 'assign'));
    const again = await baton(r.root, ['assign']);
    assert.match(again.out, /nothing to assign/);
    const r2 = makeTempRepo({ config: true, plan: unassigned() });
    try {
      await baton(r2.root, ['assign']);
      assert.deepEqual(loadPlan(r2.root).packets.map((p) => [p.agent, p.reviewer]), plan.packets.map((p) => [p.agent, p.reviewer]));
    } finally { r2.cleanup(); }
  } finally { r.cleanup(); }
});

test('assign repairs reviewer conflicts unless --only-unassigned, and refuses non-orchestrators', async () => {
  const plan = unassigned();
  plan.packets[0].agent = 'codex'; plan.packets[0].reviewer = 'codex';
  const r = makeTempRepo({ config: true, plan });
  try {
    const keep = await baton(r.root, ['assign', '--only-unassigned', '--dry-run', '--json']);
    const doc = JSON.parse(keep.out);
    assert.equal(doc.changes.find((c) => c.packet === 'WP-001'), undefined);
    const denied = await baton(r.root, ['assign', '--by', 'codex']);
    assert.equal(denied.code, 1);
    const fixed = await baton(r.root, ['assign', '--by', 'claude']);
    assert.equal(fixed.code, 0, fixed.err);
    assert.notEqual(loadPlan(r.root).packets[0].reviewer, 'codex');
    assert.equal((await baton(r.root, ['assign', 'extra'])).code, 2);
  } finally { r.cleanup(); }
});

test('assign skips started packets and warns when no reviewer is eligible', async () => {
  const cfg = JSON.parse(JSON.stringify({ version: 1, project: { name: 'solo' }, orchestrator: 'claude', agents: [{ id: 'claude', name: 'Claude', kind: 'claude', roles: ['orchestrator', 'worker', 'reviewer'], strengths: [] }], test: { command: 'true' } }));
  const r = makeTempRepo({ config: cfg, plan: { version: 1, goal: '', tracks: [], gates: [], milestones: [], packets: [{ id: 'A-1', title: 'only', owns: ['x.js'] }] } });
  try {
    const out = await baton(r.root, ['assign', '--json']);
    assert.equal(out.code, 0, out.err);
    const doc = JSON.parse(out.out);
    assert.equal(loadPlan(r.root).packets[0].agent, 'claude');
    assert.equal(loadPlan(r.root).packets[0].reviewer, null);
    assert.ok(doc.warnings.some((w) => /no eligible reviewer/.test(w)));
  } finally { r.cleanup(); }
});

test('extractJsonObjects finds fenced and bare objects, ignores braces in strings and prose', () => {
  const text = 'Here you go {not json}\n```json\n{"packets":[{"title":"a {b}"}]}\n```\ntrailing {"x":1} and {"packets":[]}';
  const all = extractJsonObjects(text);
  assert.equal(all[0].packets[0].title, 'a {b}');
  assert.ok(all.some((o) => o.x === 1));
  assert.deepEqual(extractProposal('noise {"x":1} {"goal":"g","packets":[{"title":"t"}]}').goal, 'g');
  assert.equal(extractProposal('nothing here'), null);
  assert.equal(extractProposal('{"tracks":[{"id":"a"}]}').tracks.length, 1);
});

test('split prints the prompt from the template, or writes it with --out', async () => {
  const r = makeTempRepo({ config: true, plan: true, files: { 'src/api/export.js': '//', 'src/ui/button.js': '//', 'README.md': '#' } });
  const t = templates();
  try {
    const env = { BATON_TEMPLATES_DIR: t.dir };
    const out = await baton(r.root, ['split', 'Ship', 'invoice', 'export'], env);
    assert.equal(out.code, 0, out.err);
    assert.match(out.out, /SPLIT for sample: Ship invoice export/);
    assert.match(out.out, /- claude \(architecture, review\)/);
    assert.match(out.out, /src\/ \(2 files\)/);
    assert.match(out.out, /"packets": \[ \{/);
    assert.match(out.out, /RULES: .*exact list of files/);
    assert.match(out.out, /next id WP-005 via node \.baton\/runtime\/bin\/baton\.js/);
    const file = path.join(r.root, 'prompt.md');
    const w = await baton(r.root, ['split', 'Goal', '--out', 'prompt.md'], env);
    assert.equal(w.code, 0);
    assert.match(w.out, /prompt written to prompt\.md/);
    assert.match(fs.readFileSync(file, 'utf8'), /SPLIT for sample: Goal/);
    assert.equal((await baton(r.root, ['split'], env)).code, 2);
    const missing = await baton(r.root, ['split', 'Goal'], { BATON_TEMPLATES_DIR: path.join(t.dir, 'nope') });
    assert.equal(missing.code, 1);
    assert.match(missing.err, /prompt template not found/);
  } finally { r.cleanup(); t.cleanup(); }
});

test('split --run --dry-run shows the command without executing; known runners map to their CLIs', async () => {
  const r = makeTempRepo({ config: true, plan: true });
  const t = templates();
  try {
    const env = { BATON_TEMPLATES_DIR: t.dir };
    const d = await baton(r.root, ['split', 'Goal', '--run', 'claude', '--dry-run'], env);
    assert.equal(d.code, 0, d.err);
    assert.match(d.out, /command: claude -p/);
    assert.match(d.out, /nothing was executed/);
    assert.equal(fs.existsSync(path.join(r.root, '.baton', 'proposals')), false);
    assert.match((await baton(r.root, ['split', 'G', '--run', 'codex', '--dry-run'], env)).out, /command: codex exec -/);
    assert.match((await baton(r.root, ['split', 'G', '--run', 'gemini', '--dry-run'], env)).out, /command: gemini -p/);
    const j = JSON.parse((await baton(r.root, ['split', 'G', '--run', 'my-cmd --x', '--dry-run', '--json'], env)).out);
    assert.equal(j.command, 'my-cmd --x');
  } finally { r.cleanup(); t.cleanup(); }
});

test('split --run feeds the prompt on stdin, saves a validated proposal and never applies it', async () => {
  const r = makeTempRepo({ config: true, plan: true });
  const t = templates();
  try {
    const agent = path.join(r.root, 'fake-agent.mjs');
    fs.writeFileSync(agent, [
      "let input = '';",
      "process.stdin.on('data', (c) => { input += c; });",
      "process.stdin.on('end', () => {",
      "  const ok = input.includes('SPLIT for sample: Build it');",
      "  const proposal = { goal: 'Build it', packets: [{ id: 'WP-001', title: 'Fake A', track: 'api', owns: ['src/api/fake.js'] }, { title: 'Fake B', track: 'api', owns: ['src/api/fake2.js'], deps: ['WP-001'] }] };",
      "  console.log('Sure! Here is the plan:');",
      "  console.log('```json\\n' + JSON.stringify(ok ? proposal : { oops: true }) + '\\n```');",
      '});',
    ].join('\n'));
    const before = fs.readFileSync(path.join(r.root, '.baton', 'plan.json'), 'utf8');
    const res = await baton(r.root, ['split', 'Build', 'it', '--run', `node "${agent}"`, '--allow-shell'], { BATON_TEMPLATES_DIR: t.dir });
    assert.equal(res.code, 0, res.err + res.out);
    assert.match(res.out, /proposal saved to \.baton\/proposals\/20261013T100000Z\.json: 2 packet\(s\)/);
    assert.match(res.out, /plan import \.baton\/proposals\/20261013T100000Z\.json/);
    const saved = JSON.parse(fs.readFileSync(path.join(r.root, '.baton', 'proposals', '20261013T100000Z.json'), 'utf8'));
    assert.equal(saved.packets.length, 2);
    assert.equal(fs.readFileSync(path.join(r.root, '.baton', 'plan.json'), 'utf8'), before, 'plan untouched');
    const again = await baton(r.root, ['split', 'Build it', '--run', `node "${agent}"`, '--allow-shell', '--json'], { BATON_TEMPLATES_DIR: t.dir });
    const doc = JSON.parse(again.out);
    assert.equal(doc.ok, true);
    assert.match(doc.proposal, /20261013T100000Z-2\.json$/);
    assert.match(doc.notes.join(' '), /renumbered: WP-001->WP-005/);
  } finally { r.cleanup(); t.cleanup(); }
});

test('split --run reports invalid proposals, missing JSON and failing agents', async () => {
  const r = makeTempRepo({ config: true, plan: true });
  const t = templates();
  try {
    const env = { BATON_TEMPLATES_DIR: t.dir };
    const bad = path.join(r.root, 'bad.mjs');
    fs.writeFileSync(bad, `console.log(JSON.stringify({ packets: [{ title: 'x', owns: ['/abs'] }] }));`);
    const invalid = await baton(r.root, ['split', 'G', '--run', `node "${bad}"`, '--allow-shell'], env);
    assert.equal(invalid.code, 1);
    assert.match(invalid.out, /error: .*absolute/);
    assert.ok(fs.readdirSync(path.join(r.root, '.baton', 'proposals')).length >= 1, 'invalid proposals are still kept for hand fixing');
    const none = path.join(r.root, 'none.mjs');
    fs.writeFileSync(none, `console.log('no json at all');`);
    const nojson = await baton(r.root, ['split', 'G', '--run', `node "${none}"`, '--allow-shell'], env);
    assert.equal(nojson.code, 1);
    assert.match(nojson.err, /no JSON object/);
    const fail = path.join(r.root, 'fail.mjs');
    fs.writeFileSync(fail, `console.error('boom'); process.exit(3);`);
    const failed = await baton(r.root, ['split', 'G', '--run', `node "${fail}"`, '--allow-shell'], env);
    assert.equal(failed.code, 1);
    assert.match(failed.err, /exited with 3: boom/);
    const missing = await baton(r.root, ['split', 'G', '--run', 'definitely-not-a-command-xyz', '--allow-shell'], env);
    assert.equal(missing.code, 1);
  } finally { r.cleanup(); t.cleanup(); }
});

test('prompt renders a role template with project variables; validates role and template', async () => {
  const r = makeTempRepo({ config: true, plan: true });
  const t = templates();
  try {
    const env = { BATON_TEMPLATES_DIR: t.dir };
    const out = await baton(r.root, ['prompt', 'worker', '--agent', 'codex'], env);
    assert.equal(out.code, 0, out.err);
    assert.equal(out.out.trim(), 'You are Codex (codex), a Worker on sample. Test: node -e "process.exit(0)". Run node .baton/runtime/bin/baton.js next --agent codex.');
    const j = JSON.parse((await baton(r.root, ['prompt', 'worker', '--agent', 'claude', '--json'], env)).out);
    assert.equal(j.agent, 'claude');
    assert.match(j.prompt, /Claude/);
    const anon = await baton(r.root, ['prompt', 'worker'], env);
    assert.match(anon.out, /a Worker on sample/);
    const split = await baton(r.root, ['prompt', 'split', 'My', 'goal'], env);
    assert.match(split.out, /SPLIT for sample: My goal/);
    assert.equal((await baton(r.root, ['prompt'], env)).code, 2);
    assert.equal((await baton(r.root, ['prompt', 'janitor'], env)).code, 2);
    assert.equal((await baton(r.root, ['prompt', 'worker', '--agent', 'nobody'], env)).code, 1);
    assert.equal((await baton(r.root, ['prompt', 'auditor'], env)).code, 1, 'template missing');
  } finally { r.cleanup(); t.cleanup(); }
});

test('views: painter honours TTY and NO_COLOR; tables align; helpers are tidy', () => {
  assert.equal(makePainter({}, false)('red', 'x'), 'x');
  assert.equal(makePainter({}, true)('red', 'x'), '\u001b[31mx\u001b[0m');
  assert.equal(makePainter({ NO_COLOR: '1' }, true)('red', 'x'), 'x');
  assert.equal(makePainter({ NO_COLOR: '' }, true)('red', 'x'), '\u001b[31mx\u001b[0m');
  const rows = [{ a: 'one', n: 5 }, { a: 'three-long', n: 123 }];
  const lines = renderTable(rows, [{ key: 'a', label: 'NAME' }, { key: 'n', label: 'N', right: true }]);
  assert.deepEqual(lines, ['NAME          N', 'one           5', 'three-long  123']);
  const colored = renderTable(rows, [{ key: 'a', label: 'NAME', paint: () => 'green' }], makePainter({}, true));
  assert.match(colored[1], /^\u001b\[32mone       \u001b\[0m$/, 'padding happens before colour');
  assert.equal(clip('abcdefgh', 5), 'abcd~');
  assert.equal(bar(50), '[#####-----]');
  const r = makeTempRepo({ files: { 'a.txt': '1', 'src/x/y.js': '1', 'src/x/z.js': '1', 'src/w.js': '1', '.baton/ledger/q.json': '{}' } });
  try {
    assert.equal(treeSummary(r.root), ['a.txt', 'src/ (3 files)', '  src/x/ (2)'].join('\n'));
  } finally { r.cleanup(); }
});

test('known runners never interpolate goals into shell commands; custom runners require explicit authorization', async () => {
  for (const key of ['claude', 'codex', 'gemini']) {
    const runner = resolveRunner(key);
    assert.equal(runner.shell, false);
    assert.equal(runner.custom, false);
    assert.match(runner.command, new RegExp('^' + key));
    assert.ok(!runner.args.some((x) => /evil-goal/.test(x)));
  }
  const custom = resolveRunner('node "evil-goal ; unexpected"');
  assert.equal(custom.shell, true);
  assert.equal(custom.custom, true);

  const r = makeTempRepo({ config: true, plan: true });
  const t = templates();
  try {
    const env = { BATON_TEMPLATES_DIR: t.dir };
    const denied = await baton(r.root, ['split', 'G', '--run', 'node -e "process.exit(0)"'], env);
    assert.equal(denied.code, 2);
    assert.match(denied.err, /--allow-shell/);
    assert.equal(fs.existsSync(path.join(r.root, '.baton', 'proposals')), false);

    const preview = JSON.parse((await baton(r.root, ['split', 'G', '--run', 'node -e "process.exit(0)"', '--dry-run', '--json'], env)).out);
    assert.equal(preview.requiresAllowShell, true);
    assert.equal(preview.shell, true);
    const safe = JSON.parse((await baton(r.root, ['split', 'G', '--run', 'codex', '--dry-run', '--json'], env)).out);
    assert.equal(safe.shell, false);
    assert.equal(safe.requiresAllowShell, false);
  } finally { r.cleanup(); t.cleanup(); }
});
