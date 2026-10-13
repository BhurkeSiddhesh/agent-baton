import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import {
  stamp, utcnow, toPosix, sha256, canonicalJson, readJson, writeJsonAtomic, writeFileAtomic, walk, fingerprint, slugify, list,
  decodeText, daysUntil, addHours,
} from '../src/lib/util.js';
import { BatonError, UsageError, exitCodeFor } from '../src/lib/errors.js';
import { withLock } from '../src/lib/lock.js';
import { isGit, gitOut, headCommit, isDirty, changedFiles, currentBranch, mainRef, listWorktrees, commonDir, repoRoot } from '../src/lib/git.js';
import { findRoot, defaultConfig, validateConfig, loadConfig, saveConfig } from '../src/lib/config.js';
import { packageRoot, packageVersion } from '../src/lib/paths.js';
import { makeTempRepo, sampleConfig, REPO } from './helpers.js';

function withNow(iso, fn) {
  const old = process.env.BATON_NOW;
  process.env.BATON_NOW = iso;
  try { return fn(); } finally { if (old === undefined) delete process.env.BATON_NOW; else process.env.BATON_NOW = old; }
}

test('errors and exit codes', () => {
  assert.equal(exitCodeFor(new BatonError('x')), 1);
  assert.equal(exitCodeFor(new UsageError('x')), 2);
  assert.equal(exitCodeFor(new Error('x')), 3);
  const e = new BatonError('m', { code: 'C', hint: 'h' });
  assert.deepEqual([e.code, e.hint, e instanceof Error], ['C', 'h', true]);
});

test('time: BATON_NOW override, stamp format, daysUntil', () => {
  withNow('2026-10-13T10:15:42.789Z', () => {
    assert.equal(stamp(), '2026-10-13T10:15:42Z');
    assert.equal(daysUntil('2026-10-20', utcnow()), 7);
    assert.equal(daysUntil('2026-10-01', utcnow()), -12);
    assert.equal(daysUntil('garbage', utcnow()), null);
    assert.equal(stamp(addHours(utcnow(), 8)), '2026-10-13T18:15:42Z');
  });
  withNow('not a date', () => assert.throws(() => utcnow(), BatonError));
});

test('canonicalJson sorts keys recursively and drops undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('helpers: toPosix, slugify, list, decodeText', () => {
  assert.equal(toPosix('a\\b\\c'), 'a/b/c');
  assert.equal(slugify('Hello, World! ünï'), 'hello-world-uni');
  assert.equal(slugify('!!!'), 'item');
  assert.deepEqual(list(['a, b', 'c', '']), ['a', 'b', 'c']);
  assert.deepEqual(list(undefined), []);
  assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])), 'hi');
  assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')])), 'hi');
});

test('readJson / writeJsonAtomic / writeFileAtomic', () => {
  const repo = makeTempRepo();
  try {
    const file = path.join(repo.root, 'deep', 'x.json');
    writeJsonAtomic(file, { a: 1 });
    assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "a": 1\n}\n');
    assert.deepEqual(readJson(file), { a: 1 });
    assert.equal(readJson(path.join(repo.root, 'nope.json'), 'fb'), 'fb');
    assert.throws(() => readJson(path.join(repo.root, 'nope.json')), BatonError);
    fs.writeFileSync(file, '﻿{"bom":true}');
    assert.deepEqual(readJson(file), { bom: true });
    fs.writeFileSync(file, '{oops');
    assert.throws(() => readJson(file, null), /invalid JSON/);
    writeFileAtomic(file, 'x');
    assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp')).length, 0);
  } finally { repo.cleanup(); }
});

test('walk skips dependency dirs and baton state; fingerprint reacts to content only', () => {
  const repo = makeTempRepo({ files: { 'a.js': '1', 'src/b.js': '2', 'node_modules/x/y.js': '3', '.git/config': '4', '.baton/state/lock': '5', '.baton/ledger/e.json': '6', '.baton/config.json': '{}' } });
  try {
    assert.deepEqual(walk(repo.root), ['.baton/config.json', 'a.js', 'src/b.js']);
    const f1 = fingerprint(repo.root);
    repo.write('.baton/ledger/new.json', 'ignored');
    assert.equal(fingerprint(repo.root), f1);
    repo.write('a.js', 'changed');
    assert.notEqual(fingerprint(repo.root), f1);
  } finally { repo.cleanup(); }
});

test('git helpers in a repo and outside one', () => {
  const repo = makeTempRepo({ git: true, files: { 'a.txt': 'one' } });
  const plain = makeTempRepo({ files: { 'a.txt': 'one' } });
  try {
    assert.equal(isGit(repo.root), true);
    assert.equal(isGit(plain.root), false);
    assert.equal(currentBranch(repo.root), 'main');
    assert.equal(mainRef(repo.root), 'main');
    assert.equal(mainRef(repo.root, 'nope'), 'main');
    assert.equal(headCommit(plain.root), null);
    assert.equal(gitOut(plain.root, ['rev-parse', 'HEAD']), null);
    assert.equal(path.resolve(commonDir(repo.root)), path.join(repo.root, '.git'));
    // Git can return a Windows 8.3 short path while mkdtemp reports the long path.
    // Compare the real filesystem paths rather than their differing spellings.
    assert.equal(toPosix(fs.realpathSync.native(repoRoot(repo.root))).toLowerCase(),
      toPosix(fs.realpathSync.native(repo.root)).toLowerCase());
    assert.equal(isDirty(repo.root), false);
    const base = headCommit(repo.root);
    repo.write('a.txt', 'two');
    repo.write('new dir/ünï.txt', 'x');
    assert.equal(isDirty(repo.root), true);
    assert.equal(isDirty(repo.root, { exclude: ['a.txt', 'new dir'] }), false);
    assert.deepEqual(changedFiles(repo.root, base), ['a.txt', 'new dir/ünï.txt']);
    repo.git('add', 'a.txt');
    repo.git('commit', '-q', '-m', 'c');
    assert.deepEqual(changedFiles(repo.root, base), ['a.txt', 'new dir/ünï.txt']);
    assert.deepEqual(changedFiles(repo.root, headCommit(repo.root)), ['new dir/ünï.txt']);
    assert.deepEqual(changedFiles(plain.root, null), []);
    assert.equal(listWorktrees(repo.root).length, 1);
    assert.equal(listWorktrees(repo.root)[0].branch, 'main');
  } finally { repo.cleanup(); plain.cleanup(); }
});

test('isDirty ignores excluded baton dirs even when untracked', () => {
  const repo = makeTempRepo({ git: true });
  try {
    repo.write('.baton/ledger/e.json', '{}');
    repo.write('.baton/views/STATUS.md', 'x');
    assert.equal(isDirty(repo.root, { exclude: ['.baton/ledger/', '.baton/state/', '.baton/views/'] }), false);
    assert.equal(isDirty(repo.root), true);
  } finally { repo.cleanup(); }
});

test('config: findRoot, defaults, validation, load/save', () => {
  const repo = makeTempRepo({ git: true, config: true });
  try {
    fs.mkdirSync(path.join(repo.root, 'a', 'b'), { recursive: true });
    assert.equal(findRoot(path.join(repo.root, 'a', 'b'), {}), repo.root);
    assert.equal(findRoot(repo.root, { BATON_ROOT: '/somewhere' }), path.resolve('/somewhere'));
    const bare = makeTempRepo({ git: true });
    try {
      fs.mkdirSync(path.join(bare.root, 'sub'));
      assert.equal(findRoot(path.join(bare.root, 'sub'), {}).toLowerCase(), bare.root.toLowerCase());
    } finally { bare.cleanup(); }
    const cfg = loadConfig(repo.root);
    assert.equal(cfg.orchestrator, 'claude');
    assert.equal(cfg.lease.hours, 8);
    saveConfig(repo.root, { ...cfg, lease: { hours: 2 } });
    assert.equal(loadConfig(repo.root).lease.hours, 2);
    const d = defaultConfig({ name: 'n' });
    assert.deepEqual(validateConfig(d), { errors: [], warnings: [] });
    const rows = [
      [{ ...d, version: 2 }, /version/], [{ ...d, orchestrator: 'zed' }, /orchestrator/], [{ ...d, agents: [] }, /agents/],
      [{ ...d, agents: [...d.agents, { id: 'claude', roles: ['worker'] }] }, /duplicate/], [{ ...d, agents: [{ id: 'Bad Id', roles: ['worker'] }] }, /agent id/],
      [{ ...d, agents: [{ id: 'human', roles: ['worker'] }] }, /reserved/], [{ ...d, agents: [{ id: 'x', roles: ['boss'] }] }, /unknown role/],
      [{ ...d, guard: { mode: 'loud' } }, /guard/], [{ ...d, lease: { hours: 0 } }, /lease/],
    ];
    for (const [c, re] of rows) assert.ok(validateConfig(c).errors.some((e) => re.test(e)), String(re));
    fs.writeFileSync(path.join(repo.root, '.baton', 'config.json'), '{"version":2}');
    assert.throws(() => loadConfig(repo.root), /invalid .baton\/config.json/);
    assert.equal(loadConfig(repo.root, { validate: false }).version, 2);
    const empty = makeTempRepo();
    try { assert.throws(() => loadConfig(empty.root), (e) => e.code === 'NOT_INIT'); } finally { empty.cleanup(); }
  } finally { repo.cleanup(); }
});

test('paths: packageRoot contains src/ and a version', () => {
  assert.equal(packageRoot(), REPO);
  assert.ok(fs.existsSync(path.join(packageRoot(), 'src', 'lib', 'paths.js')));
  assert.match(packageVersion(), /^\d+\.\d+\.\d+/);
});

test('packageRoot works in a vendored copy', () => {
  const repo = makeTempRepo();
  try {
    const dest = path.join(repo.root, '.baton', 'runtime');
    fs.cpSync(path.join(REPO, 'src'), path.join(dest, 'src'), { recursive: true });
    fs.cpSync(path.join(REPO, 'bin'), path.join(dest, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'package.json'), '{"type":"module","version":"9.9.9"}');
    const out = spawnSyncNode(['-e', `import(${JSON.stringify(pathToFileURL(path.join(dest, 'src/lib/paths.js')).href)}).then(m=>console.log(JSON.stringify([m.packageRoot(),m.packageVersion()])))`]);
    const [root, version] = JSON.parse(out);
    assert.equal(path.resolve(root), path.resolve(dest));
    assert.equal(version, '9.9.9');
    const v = spawnSyncNode([path.join(dest, 'bin', 'baton.js'), '--version']);
    assert.equal(v.trim(), '9.9.9');
  } finally { repo.cleanup(); }
});

import { spawnSync } from 'node:child_process';
function spawnSyncNode(args) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

// ---------------------------------------------------------------- lock

test('lock: runs, releases, is re-entrant, releases on throw', () => {
  const repo = makeTempRepo();
  try {
    const lockFile = path.join(repo.root, 'lock');
    assert.equal(withLock(repo.root, () => { assert.ok(fs.existsSync(lockFile)); return withLock(repo.root, () => 7); }), 7);
    assert.equal(fs.existsSync(lockFile), false);
    assert.throws(() => withLock(repo.root, () => { throw new Error('boom'); }), /boom/);
    assert.equal(fs.existsSync(lockFile), false);
    assert.equal(withLock(repo.root, () => 1), 1);
  } finally { repo.cleanup(); }
});

test('lock: async fn keeps the lock until it settles', async () => {
  const repo = makeTempRepo();
  try {
    const lockFile = path.join(repo.root, 'lock');
    const p = withLock(repo.root, async () => { await new Promise((r) => setTimeout(r, 20)); return 'ok'; });
    assert.ok(fs.existsSync(lockFile));
    assert.equal(await p, 'ok');
    assert.equal(fs.existsSync(lockFile), false);
  } finally { repo.cleanup(); }
});

test('lock: stale lock (dead pid, old) is broken; fresh foreign lock times out', () => {
  const repo = makeTempRepo();
  try {
    const lockFile = path.join(repo.root, 'lock');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 2 ** 22 + 12345, ts: 'x', token: 't' }));
    const old = new Date(Date.now() - 120000);
    fs.utimesSync(lockFile, old, old);
    assert.equal(withLock(repo.root, () => 'got', { quiet: true }), 'got');
    fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, ts: 'x', token: 't' }));
    assert.throws(() => withLock(repo.root, () => 1, { timeoutMs: 150 }), (e) => e.code === 'LOCK_TIMEOUT');
    fs.unlinkSync(lockFile);
  } finally { repo.cleanup(); }
});

test('lock: two processes never overlap and lose no updates', async () => {
  const repo = makeTempRepo();
  try {
    const counter = path.join(repo.root, 'counter.txt');
    fs.writeFileSync(counter, '0');
    const lockUrl = pathToFileURL(path.join(REPO, 'src', 'lib', 'lock.js')).href;
    const script = `
      import fs from 'node:fs';
      import { withLock } from ${JSON.stringify(lockUrl)};
      const [dir, counter, n] = process.argv.slice(1);
      for (let i = 0; i < Number(n); i++) {
        withLock(dir, () => {
          const v = Number(fs.readFileSync(counter, 'utf8'));
          const busy = Date.now() + 2; while (Date.now() < busy) { /* widen the race window */ }
          fs.writeFileSync(counter, String(v + 1));
        });
      }`;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, repo.root, counter, '25'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    });
    await Promise.all([run(), run()]);
    assert.equal(fs.readFileSync(counter, 'utf8'), '50');
    assert.equal(fs.existsSync(path.join(repo.root, 'lock')), false);
  } finally { repo.cleanup(); }
});

test('sampleConfig is a valid config', () => {
  assert.deepEqual(validateConfig(sampleConfig()).errors, []);
});
