import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRepo, samplePlan, sampleConfig } from './helpers.js';
import { main } from '../src/cli.js';
import { memoryStream } from '../src/lib/context.js';
import { stateDir } from '../src/lib/store.js';
import { buildBrief } from '../src/commands/dispatch.js';

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

// ---------------------------------------------------------------- bus

test('bus post / list / tail with filters and JSON', async () => {
  const r = repo();
  const p1 = await cli(r.root, ['bus', 'post', '--from', 'codex', '--type', 'request', '--text', 'need src/ui/button.js', '--packet', 'WP-001'], '2026-10-13T10:00:00Z');
  assert.equal(p1.status, 0, p1.stderr);
  await cli(r.root, ['bus', 'post', '--from', 'gemini', '--to', 'codex', '--type', 'QUESTION', '--text', 'which schema?'], '2026-10-13T11:00:00Z');
  await cli(r.root, ['bus', 'post', '--from', 'claude', '--type', 'NOTICE', '--text', 'plan updated'], '2026-10-13T12:00:00Z');
  const all = json(await cli(r.root, ['bus', 'list', '--json']));
  assert.equal(all.count, 3);
  assert.deepEqual(all.messages.map((m) => m.type), ['REQUEST', 'QUESTION', 'NOTICE']);
  assert.equal(all.messages[0].packet, 'WP-001');
  assert.equal(all.messages[1].to, 'codex');
  assert.equal(json(await cli(r.root, ['bus', 'list', '--json', '--type', 'question'])).count, 1);
  assert.equal(json(await cli(r.root, ['bus', 'list', '--json', '--since', '2026-10-13T11:00:00Z'])).count, 2);
  assert.equal(json(await cli(r.root, ['bus', 'list', '--json', '--packet', 'WP-001'])).count, 1);
  const tail = json(await cli(r.root, ['bus', 'tail', '--limit', '2', '--json']));
  assert.deepEqual(tail.messages.map((m) => m.type), ['QUESTION', 'NOTICE']);
  const text = await cli(r.root, ['bus', 'tail', '--limit', '1']);
  assert.match(text.stdout, /\[NOTICE\] claude -> all: plan updated/);
});

test('bus post validation: type, text, sender, recipient, usage', async () => {
  const r = repo();
  const bad = await cli(r.root, ['bus', 'post', '--from', 'codex', '--type', 'CLAIM', '--text', 'x']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /NOTICE\|REQUEST\|QUESTION\|BLOCKER/);
  assert.equal((await cli(r.root, ['bus', 'post', '--from', 'codex', '--type', 'NOTICE'])).status, 1); // no text
  assert.equal((await cli(r.root, ['bus', 'post', '--from', 'ghost', '--type', 'NOTICE', '--text', 'x'])).status, 1);
  assert.equal((await cli(r.root, ['bus', 'post', '--from', 'codex', '--to', 'ghost', '--type', 'NOTICE', '--text', 'x'])).status, 1);
  assert.equal((await cli(r.root, ['bus', 'post', '--type', 'NOTICE', '--text', 'x'])).status, 2); // no sender
  assert.equal((await cli(r.root, ['bus', 'list', '--since', 'yesterday'])).status, 2);
  assert.equal((await cli(r.root, ['bus'])).status, 2);
  assert.equal((await cli(r.root, ['bus', 'list'])).stdout.trim(), 'no messages');
});

// ---------------------------------------------------------------- findings

test('finding add/list/resolve rules and listing filters', async () => {
  const r = repo();
  assert.equal((await cli(r.root, ['begin', 'WP-001', '--agent', 'codex'])).status, 0);
  const add = (extra) => cli(r.root, ['finding', 'add', '--packet', 'WP-001', '--text', 'bug', ...extra]);
  assert.equal((await add(['--by', 'codex', '--severity', 'MINOR'])).status, 1); // the author cannot file against itself
  assert.equal((await add(['--by', 'claude', '--severity', 'HUGE'])).status, 2);
  assert.equal((await cli(r.root, ['finding', 'add', '--by', 'claude', '--severity', 'MINOR', '--text', 'x'])).status, 2); // no packet
  assert.equal((await add(['--by', 'claude', '--severity', 'minor', '--file', 'a.js', '--line', '7'])).status, 0);
  assert.equal((await add(['--by', 'claude', '--severity', 'BLOCKER'])).status, 0);
  const list = json(await cli(r.root, ['finding', 'list', '--json']));
  assert.deepEqual(list.findings.map((f) => [f.fid, f.severity, f.against]), [['AUD-001', 'MINOR', 'codex'], ['AUD-002', 'BLOCKER', 'codex']]);
  assert.equal(list.findings[0].line, 7);
  assert.equal((await cli(r.root, ['finding', 'resolve', 'AUD-001', '--by', 'codex', '--resolution', 'bogus'])).status, 2);
  assert.equal((await cli(r.root, ['finding', 'resolve', 'AUD-001', '--by', 'codex'])).status, 1); // no resolution
  assert.equal((await cli(r.root, ['finding', 'resolve', 'AUD-404', '--by', 'codex', '--resolution', 'fixed'])).status, 1);
  const res = await cli(r.root, ['finding', 'resolve', 'AUD-001', '--by', 'codex', '--resolution', 'fixed']);
  assert.match(res.stdout, /resolved/);
  assert.match(res.stdout, /must confirm/);
  assert.equal(json(await cli(r.root, ['finding', 'list', '--open', '--json'])).count, 2);
  await cli(r.root, ['finding', 'resolve', 'AUD-001', '--by', 'claude', '--confirm']);
  assert.equal(json(await cli(r.root, ['finding', 'list', '--open', '--json'])).count, 1);
  // The filer can close their own finding as invalid.
  assert.equal((await cli(r.root, ['finding', 'resolve', 'AUD-002', '--by', 'claude', '--resolution', 'invalid'])).status, 0);
  assert.equal(json(await cli(r.root, ['finding', 'list', '--open', '--json'])).count, 0);
  assert.equal(json(await cli(r.root, ['finding', 'list', '--packet', 'WP-003', '--json'])).count, 0);
  assert.equal((await cli(r.root, ['finding'])).status, 2);
  const notices = json(await cli(r.root, ['bus', 'list', '--type', 'NOTICE', '--json'])).messages;
  assert.ok(notices.some((m) => /AUD-001 MINOR filed against WP-001/.test(m.text) && m.to === 'codex'));
});

// ---------------------------------------------------------------- ledger

test('ledger verify passes on a healthy ledger, export and import are idempotent', async () => {
  const r = repo({ git: false });
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex']);
  const ok = await cli(r.root, ['ledger', 'verify', '--json']);
  assert.equal(ok.status, 0, ok.stdout);
  assert.deepEqual(json(ok), { ok: true, problems: [] });
  const ex = json(await cli(r.root, ['ledger', 'export', '--json']));
  assert.ok(Array.isArray(ex.exported));
  const im = json(await cli(r.root, ['ledger', 'import', '--json']));
  assert.deepEqual(im.skipped, []);
  assert.equal((await cli(r.root, ['ledger'])).status, 2);
});

test('ledger verify detects an edited event and honours acknowledgements', async () => {
  const r = repo({ git: false });
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex']);
  const dir = path.join(stateDir(r.root), 'events');
  const file = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()[0];
  const ev = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  ev.note = 'rewritten history';
  fs.writeFileSync(path.join(dir, file), JSON.stringify(ev));
  const bad = await cli(r.root, ['ledger', 'verify', '--json']);
  assert.equal(bad.status, 1);
  const out = json(bad);
  assert.equal(out.ok, false);
  assert.ok(out.problems.some((p) => p.id === ev.id && p.severity === 'error'));
  assert.match((await cli(r.root, ['ledger', 'verify'])).stdout, /unacknowledged error/);
});

test('ledger import takes valid events from a mirror directory and skips tampered ones', async () => {
  const src = repo({ git: false });
  await cli(src.root, ['begin', 'WP-001', '--agent', 'codex']);
  const mirror = path.join(src.root, '.baton', 'ledger');
  const files = fs.readdirSync(mirror).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 2);
  const bad = JSON.parse(fs.readFileSync(path.join(mirror, files[0]), 'utf8'));
  bad.note = 'tampered';
  fs.writeFileSync(path.join(mirror, files[0]), JSON.stringify(bad));
  // A fresh clone: same config and plan, empty local store, mirror copied over.
  const dst = repo({ git: false });
  fs.mkdirSync(path.join(dst.root, 'incoming'));
  for (const f of files) fs.copyFileSync(path.join(mirror, f), path.join(dst.root, 'incoming', f));
  const r = json(await cli(dst.root, ['ledger', 'import', '--from', 'incoming', '--json']));
  assert.equal(r.skipped.length, 1);
  assert.equal(r.imported.length, files.length - 1);
});

// ---------------------------------------------------------------- dispatch (dry run only)

test('dispatch --dry-run prints the gh command and a complete brief, and changes nothing', async () => {
  const plan = samplePlan();
  plan.packets[0].description = 'Export invoices as CSV.';
  plan.packets[0].reads = ['docs/DATA_CONTRACT.md'];
  const r = repo({ plan });
  const count = () => { try { return fs.readdirSync(path.join(stateDir(r.root), 'events')).length; } catch { return 0; } };
  const eventsBefore = count();
  const d = await cli(r.root, ['dispatch', 'WP-001', '--dry-run']);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /^gh issue create --title "\[baton\] WP-001: Exporter" --body-file - --label baton/);
  for (const needle of ['Export invoices as CSV.', '`src/api/export.js`', '`tests/api/export.test.js`', 'docs/DATA_CONTRACT.md', '- [ ] tests green',
    'baton/WP-001', 'begin WP-001 --agent codex', 'verify WP-001', 'submit WP-001', 'reviewer: claude']) {
    assert.ok(d.stdout.includes(needle), `brief mentions ${needle}`);
  }
  assert.equal(count(), eventsBefore, 'a dry run writes nothing');
});

test('dispatch targets: mentions, assignee, repo flag, JSON', async () => {
  const plan = samplePlan();
  plan.packets[2].agent = 'copilot';
  const config = sampleConfig();
  config.agents.push({ id: 'copilot', name: 'Copilot', kind: 'copilot', roles: ['worker', 'reviewer'], strengths: [] });
  const r = repo({ plan, config });
  assert.equal((await cli(r.root, ['reassign', 'WP-001', '--reviewer', 'gemini', '--by', 'claude'])).status, 0);
  assert.equal((await cli(r.root, ['handoff', 'WP-001', '--to', 'claude', '--by', 'claude'])).status, 0);
  const claude = json(await cli(r.root, ['dispatch', 'WP-001', '--to', 'claude', '--repo', 'me/proj', '--dry-run', '--json']));
  assert.equal(claude.dryRun, true);
  assert.deepEqual(claude.command.slice(0, 3), ['gh', 'issue', 'create']);
  assert.ok(claude.command.includes('--repo') && claude.command.includes('me/proj'));
  assert.ok(claude.body.startsWith('@claude please take this packet.'));
  assert.ok(!claude.command.includes('--assignee'));
  const copilot = json(await cli(r.root, ['dispatch', 'WP-003', '--to', 'copilot', '--dry-run', '--json']));
  assert.ok(copilot.command.join(' ').includes('--assignee @copilot'));
  assert.ok(copilot.body.includes('BATON_AGENT=copilot'));
  const codex = json(await cli(r.root, ['dispatch', 'WP-002', '--to', 'codex', '--dry-run', '--json']));
  assert.ok(codex.body.startsWith('@codex'));
  const any = json(await cli(r.root, ['dispatch', 'WP-001', '--dry-run', '--json']));
  assert.ok(any.body.startsWith('# WP-001'));
});

test('dispatch refuses unknown packets and targets, and packets with nothing left to do', async () => {
  const r = repo();
  assert.equal((await cli(r.root, ['dispatch', 'WP-999', '--dry-run'])).status, 1);
  assert.equal((await cli(r.root, ['dispatch', 'WP-001', '--to', 'robot', '--dry-run'])).status, 2);
  assert.equal((await cli(r.root, ['dispatch', '--dry-run'])).status, 2);
  await cli(r.root, ['begin', 'WP-001', '--agent', 'codex']);
  r.write('src/api/export.js', 'x\n');
  await cli(r.root, ['verify', 'WP-001']);
  await cli(r.root, ['submit', 'WP-001', '--agent', 'codex']);
  const done = await cli(r.root, ['dispatch', 'WP-001', '--dry-run']);
  assert.equal(done.status, 1);
  assert.match(done.stderr, /nothing left to dispatch/);
});

test('buildBrief falls back sensibly for unassigned packets', () => {
  const packet = { id: 'WP-9', title: 'T', owns: ['a.js'], reads: [], done_checks: [], priority: 'P1', milestone: null, track: null, description: '' };
  const brief = buildBrief(packet, { agent: null, reviewer: null }, { runtime: { command: 'baton' }, branches: {} }, 'any');
  assert.ok(brief.includes('BATON_AGENT=<your-agent-id>'));
  assert.ok(brief.includes('The change is complete and the tests pass'));
  assert.ok(brief.includes('baton/WP-9'));
});

test('dispatch refuses a provider that differs from assigned author (including dry-run)', async () => {
  const r = repo();
  const wrong = await cli(r.root, ['dispatch', 'WP-001', '--to', 'claude', '--dry-run']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /assigned to codex \(provider codex\), not claude/);
  const correct = await cli(r.root, ['dispatch', 'WP-001', '--to', 'codex', '--dry-run', '--json']);
  assert.equal(correct.status, 0, correct.stderr);
  assert.equal(json(correct).to, 'codex');
  assert.match(json(correct).body, /BATON_AGENT=codex/);
});

test('dispatch respects provider kinds when a roster id differs from its CLI adapter', async () => {
  const plan = samplePlan();
  plan.packets[0].agent = 'claude-a';
  plan.packets[0].reviewer = 'gemini';
  const cfg = sampleConfig();
  cfg.agents.push({ id: 'claude-a', name: 'Claude A', kind: 'claude', roles: ['worker', 'reviewer'], strengths: [] });
  const r = repo({ plan, config: cfg });
  const response = await cli(r.root, ['dispatch', 'WP-001', '--to', 'claude', '--dry-run', '--json']);
  assert.equal(response.status, 0, response.stderr);
  const brief = json(response).body;
  assert.match(brief, /^@claude please take/);
  assert.match(brief, /BATON_AGENT=claude-a/);
  assert.match(brief, /begin WP-001 --agent claude-a/);
  const wrong = await cli(r.root, ['dispatch', 'WP-001', '--to', 'codex', '--dry-run']);
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /provider claude/);
});
