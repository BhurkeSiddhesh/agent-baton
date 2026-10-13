import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeTempRepo } from './helpers.js';
import { baton } from './install-fixture.test.js';
import { loadManifest } from '../src/install/manifest.js';
import { findRoot } from '../src/lib/config.js';

const CC = ['--agents', 'claude,codex', '--yes', '--test-cmd', 'node -e 0'];

function withRepo(opts, fn) {
  const repo = makeTempRepo(opts);
  return Promise.resolve(fn(repo)).finally(() => repo.cleanup());
}

test('UTF-16 and Latin-1 instruction files are left byte-for-byte untouched with a notice', () => withRepo({ git: true }, async (repo) => {
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# My rules\r\nbe nice\r\n', 'utf16le')]);
  const latin1 = Buffer.from('caf\xe9 rules\n', 'latin1');
  fs.writeFileSync(path.join(repo.root, 'AGENTS.md'), utf16);
  fs.writeFileSync(path.join(repo.root, 'CLAUDE.md'), latin1);
  const r = await baton(repo.root, ['init', ...CC]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(fs.readFileSync(path.join(repo.root, 'AGENTS.md')), utf16);
  assert.deepEqual(fs.readFileSync(path.join(repo.root, 'CLAUDE.md')), latin1);
  assert.match(r.out, /not UTF-8/);
  const un = await baton(repo.root, ['uninstall', '--yes']);
  assert.equal(un.code, 0, un.err);
  assert.deepEqual(fs.readFileSync(path.join(repo.root, 'AGENTS.md')), utf16);
}));

test('a UTF-8 BOM on a managed file is preserved', () => withRepo({ git: true }, async (repo) => {
  fs.writeFileSync(path.join(repo.root, 'AGENTS.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('# rules\n')]));
  const r = await baton(repo.root, ['init', ...CC]);
  assert.equal(r.code, 0, r.err);
  const buf = fs.readFileSync(path.join(repo.root, 'AGENTS.md'));
  assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.ok(buf.toString('utf8').includes('# rules'));
}));

test('hardlinked instruction files stay one file', () => withRepo({ git: true }, async (repo) => {
  fs.writeFileSync(path.join(repo.root, 'AGENTS.md'), '# shared\n');
  try { fs.linkSync(path.join(repo.root, 'AGENTS.md'), path.join(repo.root, 'CLAUDE.md')); } catch { return; }
  const r = await baton(repo.root, ['init', ...CC]);
  assert.equal(r.code, 0, r.err);
  assert.equal(fs.statSync(path.join(repo.root, 'AGENTS.md')).nlink, 2);
  assert.equal(fs.readFileSync(path.join(repo.root, 'AGENTS.md'), 'utf8'), fs.readFileSync(path.join(repo.root, 'CLAUDE.md'), 'utf8'));
}));

test('a symlinked CLAUDE.md stays a symlink and the file carries the block once', () => withRepo({ git: true }, async (repo) => {
  fs.writeFileSync(path.join(repo.root, 'AGENTS.md'), '# shared\n');
  try { fs.symlinkSync('AGENTS.md', path.join(repo.root, 'CLAUDE.md')); } catch { return; } // EPERM without developer mode
  const r = await baton(repo.root, ['init', ...CC]);
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.lstatSync(path.join(repo.root, 'CLAUDE.md')).isSymbolicLink());
  const text = fs.readFileSync(path.join(repo.root, 'AGENTS.md'), 'utf8');
  assert.equal(text.split('baton:begin').length - 1, 1, 'one managed block');
}));

test('a directory junction that leaves the repository is refused before anything is written', () => withRepo({ git: true }, async (repo) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-outside-'));
  try {
    try { fs.symlinkSync(outside, path.join(repo.root, '.claude'), 'junction'); } catch { return; }
    const r = await baton(repo.root, ['init', ...CC]);
    assert.notEqual(r.code, 0);
    assert.match(r.err, /outside the repository/);
    assert.deepEqual(fs.readdirSync(outside), []);
    assert.ok(!fs.existsSync(path.join(repo.root, '.baton', 'manifest.json')), 'nothing was written');
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
}));

test('package.json: only scripts.baton is added; numbers and layout are untouched', () => withRepo({ git: true }, async (repo) => {
  const src = '{"name":"x","version":"1.0.0","scripts":{"test":"echo hi"},"big":12345678901234567890,"n":1.0}';
  fs.writeFileSync(path.join(repo.root, 'package.json'), src);
  const r = await baton(repo.root, ['init', ...CC]);
  assert.equal(r.code, 0, r.err);
  const out = fs.readFileSync(path.join(repo.root, 'package.json'), 'utf8');
  assert.ok(out.includes('"big":12345678901234567890,"n":1.0}'), out);
  assert.equal(JSON.parse(out).scripts.test, 'echo hi');
  assert.ok(JSON.parse(out).scripts.baton);
}));

test('an unsafe manifest entry is ignored with a notice; upgrade and uninstall still work', () => withRepo({ git: true }, async (repo) => {
  assert.equal((await baton(repo.root, ['init', ...CC])).code, 0);
  const mp = path.join(repo.root, '.baton', 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.files['../escape.txt'] = { mode: 'file', group: 'adapter:x', sha256: '0' };
  fs.writeFileSync(mp, JSON.stringify(m));
  assert.deepEqual(Object.keys(loadManifest(repo.root).files).filter((k) => k.includes('..')), []);
  const up = await baton(repo.root, ['upgrade']);
  assert.equal(up.code, 0, up.err);
  assert.match(up.out, /unsafe entry/);
  const un = await baton(repo.root, ['uninstall', '--yes']);
  assert.equal(un.code, 0, un.err);
}));

test('a nested git repository is its own project, not its parent baton project', () => withRepo({ git: true }, async (repo) => {
  assert.equal((await baton(repo.root, ['init', ...CC])).code, 0);
  const inner = path.join(repo.root, 'inner');
  fs.mkdirSync(inner);
  repo.git('init', '-q', inner);
  assert.equal(path.resolve(findRoot(inner, {})), path.resolve(inner));
  const r = await baton(inner, ['init', ...CC]);
  assert.equal(r.code, 0, r.err);
  assert.ok(fs.existsSync(path.join(inner, '.baton', 'config.json')), 'installed in the inner repo');
  assert.ok(fs.existsSync(path.join(inner, 'AGENTS.md')));
  // a plain subdirectory of the outer project still resolves to it
  const deep = path.join(repo.root, 'sub', 'deep');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(path.resolve(findRoot(deep, {})), path.resolve(repo.root));
}));

test('init and doctor warn when fewer than two agents can review', () => withRepo({ git: true }, async (repo) => {
  const r = await baton(repo.root, ['init', '--agents', 'claude', '--yes', '--test-cmd', 'node -e 0']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /fewer than two agents can review/);
  const d = await baton(repo.root, ['doctor']);
  assert.match(d.out, /can review/);
}));

test('--cwd is accepted after the command name too', () => withRepo({ git: true }, async (repo) => {
  assert.equal((await baton(repo.root, ['init', ...CC])).code, 0);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-cwd-'));
  try {
    const a = await baton(other, ['status', '--cwd', repo.root, '--json']);
    const b = await baton(other, ['--cwd', repo.root, 'status', '--json']);
    assert.equal(a.code, 0, a.err);
    assert.equal(a.out, b.out);
  } finally { fs.rmSync(other, { recursive: true, force: true }); }
}));
