import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCoverage } from '../.github/scripts/parse-coverage.mjs';

test('Node aggregate coverage is parsed into machine-readable metrics without fabricated thresholds', () => {
  const report = '# file | line % | branch % | funcs % | uncovered lines\n# src/lib/x.js | 92 | 82 | 95 | 4\n# all files | 85.36 | 72.25 | 91.00 |\n';
  assert.deepEqual(parseCoverage(report), {
    line: 85.36, branch: 72.25, function: 91, source: 'node --test --experimental-test-coverage', thresholdsEnforced: false,
  });
  const ttyReport = 'ℹ file | line % | branch % | funcs % | uncovered lines\nℹ src/lib/x.js | 92 | 82 | 95 | 4\nℹ all files | 85.36 | 72.25 | 91.00 |\n';
  assert.deepEqual(parseCoverage(ttyReport), {
    line: 85.36, branch: 72.25, function: 91, source: 'node --test --experimental-test-coverage', thresholdsEnforced: false,
  });
  const plainReport = 'all files | 85.36 | 72.25 | 91.00 |\n';
  assert.deepEqual(parseCoverage(plainReport), {
    line: 85.36, branch: 72.25, function: 91, source: 'node --test --experimental-test-coverage', thresholdsEnforced: false,
  });
  assert.equal(parseCoverage('not a Node report'), null);
  assert.equal(parseCoverage('# all files | 110 | 2 | 3 |'), null);
});

test('coverage policy runs the whole test suite on a supported runtime', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['test:coverage'], 'node --test --experimental-test-coverage');
  const workflow = fs.readFileSync(new URL('../.github/workflows/coverage.yml', import.meta.url), 'utf8');
  assert.match(workflow, /NODE_V8_COVERAGE/);
  assert.match(workflow, /upload-artifact@v4/);
  assert.match(fs.readFileSync(new URL('../docs/COVERAGE.md', import.meta.url), 'utf8'), /no arbitrary thresholds/i);
});
