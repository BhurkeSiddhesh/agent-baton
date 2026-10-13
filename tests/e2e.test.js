// End-to-end: drives the real CLI (bin/baton.js) through a full packet lifecycle in a temp git repo,
// with init using the REAL templates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempRepo, runCli } from './helpers.js';

const TEST_CMD = 'node -e "process.exit(0)"';

function ok(root, args, env = {}) {
  const r = runCli(root, args, env);
  assert.equal(r.status, 0, `baton ${args.join(' ')} exited ${r.status}\n${r.stdout}\n${r.stderr}`);
  return r;
}
function json(root, args, env = {}) {
  return JSON.parse(ok(root, [...args, '--json'], env).stdout);
}
const statusOf = (root, id) => json(root, ['status']).packets.find((p) => p.id === id).status;

test('e2e: init -> plan -> assign -> begin -> verify fail/pass -> submit -> review -> finding -> fix -> accept -> scores/release -> check', () => {
  const t = makeTempRepo({
    git: true,
    files: { 'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: TEST_CMD } }, null, 2) + '\n' },
  });
  try {
    // init with the real templates
    ok(t.root, ['init', '--yes', '--agents', 'claude,codex', '--test-cmd', TEST_CMD]);
    assert.ok(t.exists('.baton/config.json'));
    assert.ok(t.exists('.baton/runtime/bin/baton.js'));
    assert.ok(t.exists('AGENTS.md'));
    assert.ok(t.exists('.claude/commands/baton-next.md'));

    // plan: two tracks, packets via proposal import (tracks cannot be added with plan add)
    const proposal = {
      goal: 'Ship invoice export',
      tracks: [
        { id: 'api', owner: 'codex', theme: 'API', owns: ['src/api/', 'tests/api/'] },
        { id: 'ui', owner: 'claude', theme: 'UI', owns: ['src/ui/', 'tests/ui/'] },
      ],
      packets: [
        { id: 'WP-001', title: 'Exporter', track: 'api', owns: ['src/api/export.js'], priority: 'P0', done_checks: ['exports csv'] },
        { id: 'WP-002', title: 'Button', track: 'ui', owns: ['src/ui/button.js'], priority: 'P1', done_checks: ['renders'] },
      ],
    };
    t.write('proposal.json', JSON.stringify(proposal));
    ok(t.root, ['plan', 'import', 'proposal.json', '--by', 'claude']);
    ok(t.root, ['plan', 'add', '--title', 'Docs', '--track', 'ui', '--owns', 'src/ui/docs.md', '--by', 'claude']);
    ok(t.root, ['plan', 'validate']);
    ok(t.root, ['assign', '--by', 'claude']);
    const plan = JSON.parse(t.read('.baton/plan.json'));
    assert.equal(plan.packets.length, 3);
    for (const p of plan.packets) assert.ok(p.agent && p.reviewer && p.agent !== p.reviewer, `${p.id} has a distinct author and reviewer`);
    const p1 = plan.packets.find((p) => p.id === 'WP-001');
    const author = p1.agent;
    const reviewer = p1.reviewer;

    fs.rmSync(path.join(t.root, 'proposal.json'));
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'baton init + plan');

    ok(t.root, ['check']);
    assert.ok(JSON.stringify(json(t.root, ['next', '--agent', author])).includes('WP-001'));

    // begin on a packet branch, then edit out of scope
    t.git('checkout', '-q', '-b', 'baton/WP-001');
    ok(t.root, ['begin', 'WP-001', '--agent', author]);
    t.write('src/api/export.js', 'export const csv = () => "a,b";\n');
    t.write('src/ui/sneaky.js', 'export {};\n');
    const bad = runCli(t.root, ['verify', 'WP-001', '--json'], { BATON_AGENT: author });
    assert.equal(bad.status, 1, bad.stdout + bad.stderr);
    const badDoc = JSON.parse(bad.stdout);
    assert.equal(badDoc.ok, false);
    assert.ok(bad.stdout.includes('src/ui/sneaky.js'), 'violation names the stray file');
    assert.notEqual(runCli(t.root, ['submit', 'WP-001', '--agent', author]).status, 0, 'submit without a passing verify is refused');

    // fix and verify
    fs.rmSync(path.join(t.root, 'src/ui/sneaky.js'));
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'WP-001 exporter');
    assert.equal(json(t.root, ['verify', 'WP-001'], { BATON_AGENT: author }).ok, true);
    ok(t.root, ['submit', 'WP-001', '--agent', author, '--note', 'done']);
    assert.equal(statusOf(t.root, 'WP-001'), 'READY_FOR_REVIEW');

    // review: the author cannot accept their own work
    assert.notEqual(runCli(t.root, ['accept', 'WP-001', '--by', author]).status, 0);
    ok(t.root, ['review', 'WP-001'], { BATON_AGENT: reviewer });

    // an open finding blocks acceptance
    ok(t.root, ['finding', 'add', '--packet', 'WP-001', '--by', reviewer, '--severity', 'MAJOR', '--text', 'no quoting of commas', '--file', 'src/api/export.js', '--line', '1', '--evidence', 'csv("a,b")', '--fix', 'quote fields']);
    assert.notEqual(runCli(t.root, ['accept', 'WP-001', '--by', reviewer]).status, 0, 'accept refused with an open MAJOR finding');
    ok(t.root, ['fix', 'WP-001', '--by', reviewer, '--note', 'quote the fields']);
    assert.equal(statusOf(t.root, 'WP-001'), 'ACCEPTED_WITH_FIXES');

    // author reworks and resolves; the filer confirms; then accept
    ok(t.root, ['begin', 'WP-001', '--agent', author]);
    t.write('src/api/export.js', 'export const csv = () => "\\"a,b\\"";\n');
    t.git('add', '-A');
    t.git('commit', '-q', '-m', 'WP-001 quote');
    const list = json(t.root, ['finding', 'list', '--packet', 'WP-001']);
    const first = (Array.isArray(list) ? list : list.findings)[0];
    const fid = first.fid;
    assert.ok(fid);
    ok(t.root, ['finding', 'resolve', fid, '--by', author, '--resolution', 'fixed']);
    ok(t.root, ['finding', 'resolve', fid, '--by', reviewer, '--confirm']);
    assert.equal(json(t.root, ['verify', 'WP-001'], { BATON_AGENT: author }).ok, true);
    ok(t.root, ['submit', 'WP-001', '--agent', author]);
    ok(t.root, ['accept', 'WP-001', '--by', reviewer, '--score', '9', '--note', 'good']);
    assert.equal(statusOf(t.root, 'WP-001'), 'ACCEPTED');

    assert.ok(JSON.stringify(json(t.root, ['scores'])).includes(author));
    assert.ok(JSON.stringify(json(t.root, ['release'])).length > 2);
    ok(t.root, ['check']);
    ok(t.root, ['ledger', 'verify']);
    ok(t.root, ['doctor']);
  } finally {
    t.cleanup();
  }
});
