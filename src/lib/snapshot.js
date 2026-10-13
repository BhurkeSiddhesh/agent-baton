import fs from 'node:fs';
import path from 'node:path';
import { BatonError } from './errors.js';
import { hashTree, readJson, writeJsonAtomic, ensureDir, assertInside } from './util.js';
import { stateDir } from './store.js';
import { ownedBy } from './glob.js';
import { sha256, canonicalJson } from './util.js';

/** Map of path -> sha1 for every file in the working tree (skips .git, dependency dirs, baton state/ledger/views). */
export function takeSnapshot(root) {
  return hashTree(root);
}

export function snapshotFile(root, pid) {
  const dir = path.join(stateDir(root), 'snapshots');
  return assertInside(dir, path.join(dir, `${pid}.json`));
}

/** Take and persist the snapshot for a packet (done by `begin`). Returns the file map. */
export function saveSnapshot(root, pid, agent) {
  const files = takeSnapshot(root);
  ensureDir(path.join(stateDir(root), 'snapshots'));
  writeJsonAtomic(snapshotFile(root, pid), { agent, files });
  return files;
}

export function hasSnapshot(root, pid) {
  return fs.existsSync(snapshotFile(root, pid));
}

/** Files added, removed or modified since the packet's begin snapshot (sorted). Throws when none was taken. */
export function diffSnapshot(root, pid) {
  if (!hasSnapshot(root, pid)) throw new BatonError(`no snapshot for ${pid}; run "baton begin ${pid}" first`, { code: 'NO_SNAPSHOT' });
  const before = readJson(snapshotFile(root, pid)).files || {};
  const after = takeSnapshot(root);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((f) => before[f] !== after[f]).sort();
}

/**
 * Fingerprint of only the files a packet owns (path + content hash). Binds a verify marker in the shared-tree
 * modes without letting another agent's edits, editor droppings or build output invalidate it.
 */
export function packetFingerprint(root, owns) {
  return sha256(canonicalJson(hashTree(root, { include: (rel) => ownedBy(rel, owns) })));
}
