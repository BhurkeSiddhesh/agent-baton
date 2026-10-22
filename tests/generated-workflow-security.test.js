import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeTempRepo, runCli } from './helpers.js';

const pinned = {
  'actions/checkout': '11d5960a326750d5838078e36cf38b85af677262',
  'actions/setup-node': '49933ea5288caeca8642d1e84afbd3f7d6820020',
  'anthropics/claude-code-action': '6b6870e649b5ff408753befeaee5fc7989d4e6a9',
};

// Evaluate the actual job.if expression against synthetic GitHub events (no API calls).
function eventIsAllowed(expression, event_name, association, body) {
  const github = { event_name, event: { comment: { author_association: association, body } } };
  const contains = (haystack, needle) => haystack.includes(needle);
  const fromJSON = JSON.parse;
  return Function('github', 'contains', 'fromJSON', 'return (' + expression + ');')(github, contains, fromJSON);
}

test('generated Claude cloud workflow refuses untrusted and non-comment events', () => {
  const t = makeTempRepo({ git: true });
  try {
    const init = runCli(t.root, ['init', '--yes', '--agents', 'claude,codex', '--cloud']);
    assert.equal(init.status, 0, init.stderr + init.stdout);
    const workflow = fs.readFileSync(t.root + '/.github/workflows/baton-claude.yml', 'utf8');
    assert.doesNotMatch(workflow, /\$\[\[|\{\{cli\}\}/);
    assert.doesNotMatch(workflow, /^  issues:/m);
    assert.doesNotMatch(workflow, /pull_request_target|workflow_run|workflow_dispatch/);
    assert.match(workflow, /issue_comment:\s*\n\s*types: \[created\]/);
    assert.match(workflow, /pull_request_review_comment:\s*\n\s*types: \[created\]/);
    assert.match(workflow, /cancel-in-progress: false/);
    assert.match(workflow, /ANTHROPIC_API_KEY/);
    assert.match(workflow, /id-token: write/);
    const m = workflow.match(/^    if: \|\n([\s\S]*?)^    runs-on:/m);
    assert.ok(m, 'expected guarded job.if before runs-on');
    const expr = m[1].trim().split('\n').map(l => l.trim()).join(' ');
    assert.match(expr, /author_association/);
    for (const event of ['issue_comment', 'pull_request_review_comment']) {
      for (const role of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
        assert.equal(eventIsAllowed(expr, event, role, '@claude please help'), true, event + ' ' + role);
        assert.equal(eventIsAllowed(expr, event, role, 'no invocation'), false);
      }
      for (const role of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER']) {
        assert.equal(eventIsAllowed(expr, event, role, '@claude run now'), false, role);
      }
    }
    for (const event of ['issues', 'pull_request', 'pull_request_target', 'workflow_run']) {
      assert.equal(eventIsAllowed(expr, event, 'OWNER', '@claude'), false, event);
    }
  } finally { t.cleanup(); }
});

test('all generated cloud workflows pin third-party action commits and keep limited triggers', () => {
  const t = makeTempRepo({ git: true });
  try {
    const init = runCli(t.root, ['init', '--yes', '--agents', 'claude,codex', '--cloud']);
    assert.equal(init.status, 0, init.stderr + init.stdout);
    for (const name of ['baton-ci.yml', 'baton-claude.yml', 'baton-dispatch.yml']) {
      const yaml = fs.readFileSync(t.root + '/.github/workflows/' + name, 'utf8');
      for (const match of yaml.matchAll(/^\s*- uses: ([^@\s]+)@([^\s#]+)/gm)) {
        assert.equal(match[2], pinned[match[1]], name + ': unreviewed action ' + match[1]);
      }
      assert.doesNotMatch(yaml, /pull_request_target|^  workflow_run:/m);
    }
    const dispatch = fs.readFileSync(t.root + '/.github/workflows/baton-dispatch.yml', 'utf8');
    assert.match(dispatch, /permissions:\s*\n  issues: write/);
    assert.match(dispatch, /github\.event\.label\.name == 'baton'/);
    assert.match(dispatch, /cancel-in-progress: false/);
    const checks = fs.readFileSync(t.root + '/.github/workflows/baton-ci.yml', 'utf8');
    assert.match(checks, /permissions:\s*\n  contents: read/);
  } finally { t.cleanup(); }
});
