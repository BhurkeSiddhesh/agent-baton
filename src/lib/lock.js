import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { BatonError } from './errors.js';
import { ensureDir, sleepSync } from './util.js';

const held = new Map(); // resolved lock file -> synchronous re-entrancy depth
const synchronous = new Set(); // true only while an owning callback is synchronously executing

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
    const stat = fs.statSync(file);
    return {
      raw, pid: info.pid, host: info.host, token: info.token,
      parsed: Number.isSafeInteger(info.pid) && info.pid > 0 && typeof info.token === 'string' && info.token.length > 0,
      mtime: stat.mtimeMs, ino: stat.ino, dev: stat.dev,
    };
  } catch {
    return null;
  }
}

/**
 * Run `fn` while holding an exclusive local lock file `<dir>/lock`.
 * Synchronous nested calls are re-entrant; concurrent calls during a pending async
 * callback fail closed (blocking the event loop would deadlock the owner).
 * Only provably dead local PIDs or torn files older than the tear grace are recovered.
 * A live PID and an unverified remote-host holder are NEVER broken based on age alone.
 * If `fn` returns a promise the lock remains until it settles.
 * @template T
 * @param {string} dir
 * @param {() => T} fn
 * @param {{timeoutMs?: number, staleMs?: number, quiet?: boolean}} [opts]
 * @returns {T}
 */
export function withLock(dir, fn, { timeoutMs = 20000, staleMs = 2000, quiet = false } = {}) {
  ensureDir(dir);
  const file = path.join(fs.realpathSync(dir), 'lock');
  if (held.has(file)) {
    if (!synchronous.has(file)) {
      throw new BatonError('cannot enter a baton lock while an asynchronous operation holds it in this process', { code: 'LOCK_BUSY' });
    }
    held.set(file, held.get(file) + 1);
    const leave = () => held.set(file, held.get(file) - 1);
    let r;
    try { r = fn(); } catch (e) { leave(); throw e; }
    if (r && typeof r.then === 'function') return r.finally(leave);
    leave();
    return r;
  }
  const token = crypto.randomBytes(16).toString('hex');
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
        // Age is NOT evidence that a live process has abandoned its lock. An
        // unknown remote host cannot be verified, so recovery there is manual.
        const deadHolder = sameHost && h.parsed && !pidAlive(h.pid);
        const torn = !h.parsed && age > Math.max(2000, staleMs);
        if (deadHolder || torn) {
          const again = readHolder(file);
          if (again && again.raw === h.raw && again.ino === h.ino && again.dev === h.dev) {
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
          code: 'LOCK_TIMEOUT', hint: `inspect the holder PID/host first; only remove ${file} after proving the process is stopped`,
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
        if (!h || h.token !== token) return; // never delete another owner's lock
        fs.unlinkSync(file);
        return;
      } catch (e) {
        if (e.code === 'ENOENT') return;
        sleepSync(10);
      }
    }
  };
  let result;
  synchronous.add(file);
  try {
    result = fn();
  } catch (e) {
    release();
    throw e;
  } finally {
    synchronous.delete(file);
  }
  if (result && typeof result.then === 'function') return result.finally(release);
  release();
  return result;
}
