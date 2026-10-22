import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateRequiredResults, REQUIRED_CI_JOBS } from '../.github/scripts/assert-required-ci.mjs';

test('branch protection aggregator rejects anything except all success', () => {
  const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const gate = ci.split(/^  branch_ready:\s*$/m)[1];
  assert.ok(gate, 'missing PR/main branch gate');
  assert.match(gate, /name: branch protection gate \(all required CI checks\)/);
  assert.match(gate, /if: always\(\) && !startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(gate, /needs: \[test, unit, integration, security, package, smoke, docs\]/);
  for (const job of ['test', 'unit', 'integration', 'security', 'package', 'smoke', 'docs']) {
    assert.ok(gate.includes('needs.' + job + '.result'), 'gate omitted ' + job);
  }
  assert.match(gate, /assert-required-ci\.mjs/);
  assert.match(gate, /uses: actions\/checkout@v4/, 'gate must check out the helper script');
});

test('branch/tag protection runbook discloses settings limitation and requires checks', () => {
  const runbook = fs.readFileSync(new URL('../docs/BRANCH_PROTECTION.md', import.meta.url), 'utf8');
  const release = fs.readFileSync(new URL('../docs/CI_RELEASE.md', import.meta.url), 'utf8');
  const contributing = fs.readFileSync(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8');
  assert.match(runbook, /Rulesets/);
  assert.match(runbook, /test coverage baseline \(node 20\)/);
  assert.match(runbook, /non-admin test contributor/);
  assert.match(runbook, /sole maintainer/);
  assert.match(runbook, /does not configure or verify/);
  assert.match(release, /BRANCH_PROTECTION\.md/);
  assert.match(contributing, /BRANCH_PROTECTION\.md/);
});

test('branch gate rejects simulated failure, cancellation, skip and missing jobs', () => {
  const statuses = REQUIRED_CI_JOBS.map(() => 'success');
  assert.equal(evaluateRequiredResults(statuses).ok, true);
  for (const state of ['failure', 'cancelled', 'skipped', 'pending', '']) {
    const incorrect = [...statuses];
    incorrect[3] = state;
    const result = evaluateRequiredResults(incorrect);
    assert.equal(result.ok, false, 'unexpectedly accepted ' + JSON.stringify(state));
    assert.match(result.failed.join(', '), /security=/);
  }
  assert.equal(evaluateRequiredResults(statuses.slice(1)).ok, false);
  const helper = fileURLToPath(new URL('../.github/scripts/assert-required-ci.mjs', import.meta.url));
  assert.equal(spawnSync(process.execPath, [helper, ...statuses], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [helper, ...statuses.slice(1)], { encoding: 'utf8' }).status, 1);
});
