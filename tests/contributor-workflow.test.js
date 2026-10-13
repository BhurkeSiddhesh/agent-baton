import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('PR template requires issue tracking, reproducible evidence, compatibility and safety review', () => {
  const template = read('.github/PULL_REQUEST_TEMPLATE.md');
  for (const keyword of ['Closes #', 'Acceptance criteria', 'CI', 'Compatibility', 'Security', 'Rollback', 'Review']) {
    assert.ok(template.includes(keyword), 'Missing PR policy: ' + keyword);
  }
});

test('issue forms collect reproducible work and direct sensitive reports privately', () => {
  const task = read('.github/ISSUE_TEMPLATE/implementation_task.yml');
  for (const field of ['id: objective', 'id: priority', 'id: phase', 'id: scope', 'id: acceptance', 'id: dependencies', 'id: risks']) {
    assert.ok(task.includes(field), 'Missing engineering task field: ' + field);
  }
  assert.match(task, /description: ['"]Use navigable #123 references, or state None['"]/);
  const config = read('.github/ISSUE_TEMPLATE/config.yml');
  assert.match(config, /security\/advisories\/new/);
  assert.match(config, /blank_issues_enabled: false/);
  const bug = read('.github/ISSUE_TEMPLATE/bug_report.yml');
  assert.match(bug, /Steps to reproduce/);
  const feature = read('.github/ISSUE_TEMPLATE/feature_request.yml');
  assert.match(feature, /Proposal/);
});
