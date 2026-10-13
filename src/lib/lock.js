import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { BatonError } from './errors.js';
import { ensureDir, sleepSync } from './util.js';

const held = new Map(); // lock file -> re-entrancy depth (per process)

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function readHolder(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    let info = {};
    try { info = JSON.parse(raw); } catch { /* torn write */ }
    return { raw, pid: info.pid, host: info.host, parsed: !!info && typeof info.pid === 'number', mtime: fs.statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Run `fn` while holding an exclusive lock file `<dir>/lock`. Re-entrant within one process.
 * Stale locks (a dead pid on this host, a torn file older than 2 s, older than 60 s with a dead pid, or older than 5 min) are broken with a note on stderr.
 * If `fn` returns a promise the lock is released when it settles.
 * @template T
 * @param {string} dir
 * @param {() => T} fn
 * @param {{timeoutMs?: number, staleMs?: number, quiet?: boolean}} [opts]
 * @returns {T}
 */
export function withLock(dir, fn, { timeoutMs = 20000, staleMs = 5 * 60 * 1000, quiet = false } = {}) {
  const file = path.join(dir, 'lock');
  if (held.has(file)) {
    held.set(file, held.get(file) + 1);
    const leave = () => held.set(file, held.get(file) - 1);
    let r;
    try { r = fn(); } catch (e) { leave(); throw e; }
    if (r && typeof r.then === 'function') return r.finally(leave);
    leave();
    return r;
  }
  ensureDir(dir);
  const token = crypto.randomBytes(8).toString('hex');
  const body = JSON.stringify({ pid: process.pid, host: os.hostname(), ts: new Date().toISOString(), token });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, body); } finally { fs.closeSync(fd); }
      break;
    } catch (e) {
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      const h = readHolder(file);
      if (h) {
        const age = Date.now() - h.mtime;
        const sameHost = !h.host || h.host === os.hostname();
        // A provably dead holder on this host (or a torn/empty lock file) needs no long age gate; the 60 s and
        // 5 min rules stay as the fallback for pid reuse, other hosts and network filesystems.
        const deadHolder = sameHost && h.parsed && !pidAlive(h.pid);
        const torn = !h.parsed && age > 2000;
        if (age > staleMs || (age > 60000 && !pidAlive(h.pid)) || deadHolder || torn) {
          const again = readHolder(file);
          if (again && again.raw === h.raw) {
            try {
              fs.unlinkSync(file);
              if (!quiet) process.stderr.write(`baton: broke a stale lock (${path.basename(dir)}/lock, held by pid ${h.pid ?? '?'})\n`);
            } catch { /* someone else broke it */ }
            continue;
          }
        }
      }
      if (Date.now() > deadline) {
        throw new BatonError(`could not acquire the baton lock within ${timeoutMs} ms (another baton command is running or crashed)`, {
          code: 'LOCK_TIMEOUT', hint: `delete ${file} if no baton process is running`,
        });
      }
      sleepSync(15);
    }
  }
  held.set(file, 1);
  const release = () => {
    held.delete(file);
    for (let i = 0; i < 50; i++) {
      try {
        const h = readHolder(file);
        if (h && !h.raw.includes(token)) return; // not ours any more
        fs.unlinkSync(file);
        return;
      } catch (e) {
        if (e.code === 'ENOENT') return;
        sleepSync(10);
      }
    }
  };
  let result;
  try {
    result = fn();
  } catch (e) {
    release();
    throw e;
  }
  if (result && typeof result.then === 'function') return result.finally(release);
  release();
  return result;
}
