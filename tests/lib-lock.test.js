import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { withLock } from '../src/lib/lock.js';

function scratch(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-lock-test-'));
  return Promise.resolve().then(() => fn(dir)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}
const lockFile = (dir) => path.join(dir, 'lock');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lockModule = pathToFileURL(new URL('../src/lib/lock.js', import.meta.url).pathname).href;

test('nested synchronous lock acquisition is reentrant and cleans up', async () => scratch(dir => {
  assert.equal(withLock(dir, () => 1 + withLock(dir, () => 2)), 3);
  assert.equal(fs.existsSync(lockFile(dir)), false);
}));

test('aged live PID and foreign-host locks are never broken on elapsed time alone', async () => scratch(dir => {
  const file = lockFile(dir);
  for (const host of [os.hostname(), 'unknown-remote-host-for-test']) {
    const body = { pid: process.pid, host, token: 'live-owner-test' };
    fs.writeFileSync(file, JSON.stringify(body));
    fs.utimesSync(file, new Date('2001-01-01'), new Date('2001-01-01'));
    const script = `import { withLock } from ${JSON.stringify(new URL('../src/lib/lock.js', import.meta.url).href)};
      try { withLock(process.argv[1], () => {}, { timeoutMs: 100, staleMs: 1, quiet: true }); process.exit(8); }
      catch (e) { if (e.code !== 'LOCK_TIMEOUT') throw e; }`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir], { encoding: 'utf8', timeout: 8000 });
    assert.equal(child.status, 0, host + ': ' + child.stderr);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, body.token);
    fs.unlinkSync(file);
  }
}));

test('owner release never deletes a replacement lock, including renamed lock on Windows', async () => scratch(dir => {
  const file = lockFile(dir);
  const moved = path.join(dir, 'previous-lock');
  withLock(dir, () => {
    fs.renameSync(file, moved);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'replacement-owner' }));
  });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).token, 'replacement-owner');
  assert.equal(fs.existsSync(moved), true);
}));

test('concurrent asynchronous calls do not enter another holder critical section', async () => scratch(async dir => {
  let finish;
  const pending = withLock(dir, () => new Promise(resolve => { finish = resolve; }));
  assert.throws(() => withLock(dir, () => 'unsafe'), e => e.code === 'LOCK_BUSY');
  finish();
  await pending;
  assert.equal(withLock(dir, () => 'allowed'), 'allowed');
}));

test('crashed owner is safely recovered, and corrupt partial writes require a grace interval', async () => scratch(dir => {
  const script = `import { withLock } from ${JSON.stringify(new URL('../src/lib/lock.js', import.meta.url).href)};
    withLock(process.argv[1], () => process.exit(31));`;
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', script, dir], { encoding: 'utf8', timeout: 8000 });
  assert.equal(crashed.status, 31, crashed.stderr);
  assert.ok(fs.existsSync(lockFile(dir)));
  assert.equal(withLock(dir, () => 'recovered', { timeoutMs: 2000, quiet: true }), 'recovered');
  fs.writeFileSync(lockFile(dir), '{partial');
  assert.throws(() => withLock(dir, () => 1, { timeoutMs: 60, quiet: true }), e => e.code === 'LOCK_TIMEOUT');
  fs.utimesSync(lockFile(dir), new Date('2001-01-01'), new Date('2001-01-01'));
  assert.equal(withLock(dir, () => 'repaired', { timeoutMs: 2000, quiet: true }), 'repaired');
}));

test('independent processes serialize critical-section writes under contention', async () => scratch(async dir => {
  const script = `import fs from 'node:fs';
    import path from 'node:path';
    import { withLock } from ${JSON.stringify(new URL('../src/lib/lock.js', import.meta.url).href)};
    const root = process.argv[1];
    for (let i=0;i<6;i++) withLock(root, () => {
      const active = path.join(root, 'active');
      const count = path.join(root, 'count');
      if (fs.existsSync(active)) throw new Error('overlapping writers');
      fs.writeFileSync(active, String(process.pid));
      const v = Number(fs.readFileSync(count, 'utf8'));
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4);
      fs.writeFileSync(count, String(v+1));
      fs.unlinkSync(active);
    }, { timeoutMs: 15000, quiet: true });`;
  fs.writeFileSync(path.join(dir, 'count'), '0');
  const run = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', script, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d; });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr + ' (exit ' + code + ')')));
  });
  await Promise.all(Array.from({ length: 6 }, run));
  assert.equal(fs.readFileSync(path.join(dir, 'count'), 'utf8'), '36');
  assert.equal(fs.existsSync(path.join(dir, 'active')), false);
}));

test('unwritable lock directories reject writes rather than bypassing synchronization', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('filesystem chmod write denial not portable on Windows/root');
  await scratch(dir => {
    fs.chmodSync(dir, 0o500);
    try { assert.throws(() => withLock(dir, () => 'unsafe', { timeoutMs: 70 }), e => e.code === 'LOCK_TIMEOUT' || e.code === 'EACCES'); }
    finally { fs.chmodSync(dir, 0o700); }
  });
});
