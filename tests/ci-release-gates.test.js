import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REQUIRED_CI_JOBS, evaluateRequiredResults } from '../.github/scripts/assert-required-ci.mjs';
import { validateReleaseTag } from '../.github/scripts/assert-release-tag.mjs';
import { checksumPackEntry } from '../.github/scripts/write-package-checksum.mjs';

test('tag/version validation accepts exact release tags and rejects mismatches', () => {
  for (const v of ['0.1.0', '1.2.3', '2.0.0-alpha.3', '2.3.4+build.1']) {
    assert.equal(validateReleaseTag('v' + v, v), true);
  }
  for (const bad of ['v0.0.9', 'v0.1.0-evil', 'v0.1.0; echo injected', 'V0.1.0', '', 'v01.1.0']) {
    assert.equal(validateReleaseTag(bad, '0.1.0'), false, bad);
  }
  const cli = fileURLToPath(new URL('../.github/scripts/assert-release-tag.mjs', import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(spawnSync(process.execPath, [cli, 'v' + pkg.version], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [cli, 'v999.999.999'], { encoding: 'utf8' }).status, 1);
});

test('release candidate checksum binds exact name/version and bytes', () => {
  const entry = { name: 'agent-baton', version: '0.1.0', filename: 'agent-baton-0.1.0.tgz' };
  const bytes = Buffer.from('synthetic archive bytes');
  const sum = checksumPackEntry(entry, 'agent-baton', '0.1.0', bytes);
  assert.match(sum, /^[a-f0-9]{64}  agent-baton-0\.1\.0\.tgz\n$/);
  assert.notEqual(sum, checksumPackEntry(entry, 'agent-baton', '0.1.0', Buffer.from('other bytes')));
  for (const wrong of [{ ...entry, version: '0.2.0' }, { ...entry, filename: '../pwned.tgz' }]) {
    assert.throws(() => checksumPackEntry(wrong, 'agent-baton', '0.1.0', bytes));
  }
});

test('tag candidate job depends on release gate and fails closed for all bad statuses', () => {
  const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const release = ci.split(/^  release_ready:\s*$/m)[1]?.split(/^  release_candidate:\s*$/m)[0];
  const candidate = ci.split(/^  release_candidate:\s*$/m)[1]?.split(/^  branch_ready:\s*$/m)[0];
  assert.ok(release && candidate, 'missing tagged release gates');
  assert.match(release, /if: always\(\) && startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.match(release, /needs: \[test, unit, integration, security, package, smoke, docs\]/);
  assert.match(release, /assert-required-ci\.mjs/);
  assert.match(release, /assert-release-tag\.mjs/);
  assert.match(candidate, /needs: \[release_ready\]/);
  assert.match(candidate, /needs\.release_ready\.result == 'success'/);
  assert.match(candidate, /write-package-checksum\.mjs/);
  assert.match(candidate, /validate-package\.mjs/);
  assert.match(candidate, /upload-artifact@v4/);
  assert.doesNotMatch(candidate, /gh release create|npm publish/);
  const good = REQUIRED_CI_JOBS.map(() => 'success');
  assert.equal(evaluateRequiredResults(good).ok, true);
  for (const bad of ['failure', 'cancelled', 'skipped', 'pending', '']) {
    for (let i = 0; i < good.length; i++) {
      const statuses = [...good]; statuses[i] = bad;
      assert.equal(evaluateRequiredResults(statuses).ok, false, REQUIRED_CI_JOBS[i] + ':' + bad);
    }
  }
});
