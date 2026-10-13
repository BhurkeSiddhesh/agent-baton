import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectRuntime } from '../src/install/vendor.js';

const source = fileURLToPath(new URL('..', import.meta.url));

test('MIT notice is preserved in vendored runtime alongside source code', () => {
  const license = fs.readFileSync(new URL('../LICENSE', import.meta.url));
  const files = collectRuntime();
  const copy = files.find((x) => x.rel === '.baton/runtime/LICENSE');
  assert.ok(copy, 'installed runtime must include MIT notice');
  assert.deepEqual(copy.data, license);
  assert.ok(files.some((x) => x.rel === '.baton/runtime/src/cli.js'));
});

test('package and license inventory retain explicit licensing commitments', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.license, 'MIT');
  assert.deepEqual(pkg.dependencies || {}, {});
  assert.ok(pkg.files.includes('LICENSE'));
  const doc = fs.readFileSync(new URL('../docs/LICENSING.md', import.meta.url), 'utf8');
  assert.match(doc, /\.baton\/runtime\/LICENSE/);
  assert.match(doc, /Release checklist/);
  assert.match(fs.readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'), /^MIT License/);
});
