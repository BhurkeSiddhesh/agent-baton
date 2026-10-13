import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTempRepo, runCli } from './helpers.js';
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

test('an incomplete repackaged runtime fails rather than silently omitting the notice', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-no-license-'));
  try {
    assert.throws(() => collectRuntime({ srcRoot: root, templates: root }), /missing required Baton license notice/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('non-vendored installs still carry the MIT notice for generated templates', () => {
  const repo = makeTempRepo({ git: true });
  try {
    const r = runCli(repo.root, ['init', '--yes', '--agents', 'claude,codex', '--no-vendor']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(repo.root, '.baton', 'LICENSE'), 'utf8'), fs.readFileSync(new URL('../LICENSE', import.meta.url), 'utf8'));
    assert.equal(fs.existsSync(path.join(repo.root, '.baton/runtime')), false);
  } finally { repo.cleanup(); }
});

test('linked runtime license cannot overwrite a host repository license', (t) => {
  const repo = makeTempRepo({ git: true, files: { LICENSE: 'Host-specific legal terms\\n' } });
  try {
    const runtime = path.join(repo.root, '.baton', 'runtime');
    fs.mkdirSync(runtime, { recursive: true });
    const link = path.join(runtime, 'LICENSE');
    try {
      fs.symlinkSync(path.join(repo.root, 'LICENSE'), link, 'file');
    } catch (e) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(e.code)) { t.skip('symlinks unavailable on this runner'); return; }
      throw e;
    }
    const r = runCli(repo.root, ['init', '--yes', '--agents', 'claude,codex', '--force']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /refusing aliased license target/);
    assert.equal(fs.readFileSync(path.join(repo.root, 'LICENSE'), 'utf8'), 'Host-specific legal terms\\n');
  } finally { repo.cleanup(); }
});
