import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function normalizeTargets(paths) {
  const sorted = [...new Set(paths.map((p) => path.resolve(p)))].sort((a, b) => a.length - b.length);
  return sorted.filter((p, i) => !sorted.slice(0, i).some((parent) => p.startsWith(parent + path.sep)));
}

/** Capture files/directories outside the repository so a destructive multi-file operation can be rolled back. */
export function captureTransaction(paths) {
  const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baton-transaction-'));
  let entries;
  try {
    entries = normalizeTargets(paths).map((target, index) => {
      const backup = path.join(backupRoot, String(index));
      let exists = false;
      try {
        fs.lstatSync(target);
        exists = true;
        fs.cpSync(target, backup, { recursive: true, force: true, verbatimSymlinks: true });
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      return { target, backup, exists };
    });
  } catch (err) {
    try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch { /* preserve original error */ }
    throw err;
  }
  let finished = false;
  return {
    rollback() {
      const failures = [];
      for (const e of [...entries].reverse()) {
        try {
          fs.rmSync(e.target, { recursive: true, force: true });
          if (e.exists) {
            fs.mkdirSync(path.dirname(e.target), { recursive: true });
            fs.cpSync(e.backup, e.target, { recursive: true, force: true, verbatimSymlinks: true });
          }
        } catch (err) { failures.push(`${e.target}: ${err.code || err.message}`); }
      }
      finished = true;
      try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch { /* best effort after restore */ }
      return failures;
    },
    commit() {
      if (finished) return;
      finished = true;
      try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch { /* operation committed; temp cleanup is best effort */ }
    },
  };
}
