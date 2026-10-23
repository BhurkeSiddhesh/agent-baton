import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BatonError } from './errors.js';
import { commonDir } from './git.js';
import { withLock } from './lock.js';
import { utcnow, stamp, sha256, canonicalJson, ensureDir, writeFileAtomic, readJson } from './util.js';
import { LEDGER_VERSION, EVENT_KINDS, EVENT_ID_RE, validateEventSchema } from './event-schema.js';

export { LEDGER_VERSION, EVENT_KINDS, EVENT_ID_RE, validateEventSchema } from './event-schema.js';

/**
 * Local shared store: `<git common dir>/baton` inside git (shared by all worktrees), else `<root>/.baton/state`.
 * Created on demand.
 */
export function stateDir(root) {
  const common = commonDir(root);
  return ensureDir(common ? path.join(common, 'baton') : path.join(root, '.baton', 'state'));
}

/** Subdirectory of the state dir (e.g. "verified", "snapshots"), created on demand. */
export function stateSub(root, name) {
  return ensureDir(path.join(stateDir(root), name));
}

export function ledgerDir(root) { return path.join(root, '.baton', 'ledger'); }
export function eventsDir(root) { return path.join(stateDir(root), 'events'); }

function mirrorEnabled(root) {
  try {
    const cfg = readJson(path.join(root, '.baton', 'config.json'), null);
    return cfg?.ledger?.mirror !== false;
  } catch {
    return true;
  }
}

function listIds(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

// Per-process parse cache keyed by file path; an entry is valid while mtime, ctime and size are unchanged.
const parseCache = new Map();

function readEventCached(file) {
  let st;
  try { st = fs.statSync(file); } catch { parseCache.delete(file); return null; }
  const hit = parseCache.get(file);
  if (hit && hit.m === st.mtimeMs && hit.c === st.ctimeMs && hit.s === st.size) return hit.ev;
  const { ev } = readEventFile(file);
  if (ev) parseCache.set(file, { m: st.mtimeMs, c: st.ctimeMs, s: st.size, ev });
  else parseCache.delete(file);
  return ev || null;
}

function readEventFile(file) {
  try {
    return { ev: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) };
  } catch (e) {
    return { error: e.message };
  }
}

/** sha256 of the canonical JSON of the event without its `sha` field. */
export function eventSha(ev) {
  const { sha, ...rest } = ev;
  return sha256(canonicalJson(rest));
}

const cmp = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * All events: union of the local store and the tracked mirror, de-duplicated by id (local wins),
 * sorted by (ts, id). Unparsable files are skipped (verifyLedger reports them).
 */
export function readEvents(root) {
  const byId = new Map();
  for (const dir of [eventsDir(root), ledgerDir(root)]) {
    for (const id of listIds(dir)) {
      if (byId.has(id)) continue;
      const ev = readEventCached(path.join(dir, `${id}.json`));
      if (ev && ev.id === id && validateEventSchema(ev).length === 0 && eventSha(ev) === ev.sha) byId.set(id, ev);
    }
  }
  return [...byId.values()].sort(cmp);
}

/**
 * Append one event (under the state lock): fills id, ts, hv and sha, writes the local file and, when
 * config.ledger.mirror is not false, the tracked mirror. Refuses to write into a ledger written by a newer baton.
 * @param {string} root
 * @param {{packet?: string|null, kind: string, to?: string|null, by?: string|null, note?: string, data?: object}} partial
 * @returns {object} the stored event
 */
export function appendEvent(root, partial) {
  if (!EVENT_KINDS.includes(partial.kind)) throw new BatonError(`unknown event kind "${partial.kind}"`, { code: 'BAD_EVENT' });
  return withLock(stateDir(root), () => {
    // O(1) in the ledger size: the newest id comes from file names alone, and only the newest file of each
    // store is parsed to check the format version.
    const dirs = [eventsDir(root), ledgerDir(root)];
    let last = '';
    for (const dir of dirs) {
      const ids = listIds(dir).filter((i) => EVENT_ID_RE.test(i)).sort();
      const top = ids[ids.length - 1];
      if (top && top > last) last = top;
      if (top) {
        const e = readEventCached(path.join(dir, `${top}.json`));
        if (e && (e.hv || 0) > LEDGER_VERSION) {
          throw new BatonError(`the ledger was written by a newer baton (event format v${e.hv}; this is v${LEDGER_VERSION})`, {
            code: 'LEDGER_NEWER', hint: 'run "baton upgrade" to refresh the vendored runtime',
          });
        }
      }
    }
    // The clock must never run backwards on one ledger: (ts, id) order has to equal append order, so a clock
    // behind the newest event (BATON_NOW, an NTP step, a merged mirror from a faster clock) is clamped to it.
    let now = utcnow();
    if (last) {
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(last);
      const lastTime = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
      if (lastTime.getTime() > now.getTime()) now = lastTime;
    }
    const ts = stamp(now);
    const prefix = ts.replace(/[-:]/g, '');
    // ids must sort in append order even inside one second (and under a frozen BATON_NOW)
    let suffix = crypto.randomBytes(3).toString('hex');
    if (last.startsWith(prefix)) suffix = ((parseInt(last.slice(-6), 16) + 1) % 0x1000000).toString(16).padStart(6, '0');
    const ev = {
      id: `${prefix}-${suffix}`,
      ts,
      packet: partial.packet ?? null,
      kind: partial.kind,
      to: partial.to ?? null,
      by: partial.by ?? null,
      note: partial.note ?? '',
      data: partial.data ?? {},
      hv: LEDGER_VERSION,
    };
    ev.sha = eventSha(ev);
    const schemaProblems = validateEventSchema(ev, { allowLegacy: false });
    if (schemaProblems.length) throw new BatonError(`invalid ${ev.kind} event: ${schemaProblems.join('; ')}`, { code: 'BAD_EVENT_SCHEMA' });
    const text = JSON.stringify(ev, null, 2) + '\n';
    writeFileAtomic(path.join(eventsDir(root), `${ev.id}.json`), text);
    if (mirrorEnabled(root)) writeFileAtomic(path.join(ledgerDir(root), `${ev.id}.json`), text);
    return ev;
  });
}

/**
 * Integrity check of both stores. Returns problems: {id, where: 'local'|'mirror'|'both', severity: 'error'|'warn',
 * problem: string, acked: boolean}. `acked` is true when an `ack` event names the id.
 */
export function verifyLedger(root) {
  const problems = [];
  const valid = new Map(); // id -> {local?, mirror?}
  const stores = [['local', eventsDir(root)], ['mirror', ledgerDir(root)]];
  const add = (id, where, severity, problem) => problems.push({ id, where, severity, problem, acked: false });
  for (const [where, dir] of stores) {
    for (const id of listIds(dir)) {
      const { ev, error } = readEventFile(path.join(dir, `${id}.json`));
      if (error) { add(id, where, 'error', `unreadable JSON (${error})`); continue; }
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) { add(id, where, 'error', 'event must be a JSON object'); continue; }
      if (ev.id !== id) { add(id, where, 'error', `file name does not match event id ${ev.id}`); continue; }
      if (!EVENT_ID_RE.test(id)) add(id, where, 'warn', 'event id has an unexpected format');
      if (!ev.sha) { add(id, where, 'error', 'event has no sha'); continue; }
      if (eventSha(ev) !== ev.sha) { add(id, where, 'error', 'sha mismatch: the event was edited after it was written'); continue; }
      const schemaProblems = validateEventSchema(ev);
      if (schemaProblems.length) { add(id, where, 'error', `invalid event schema: ${schemaProblems.join('; ')}`); continue; }
      const slot = valid.get(id) || {};
      slot[where] = ev;
      valid.set(id, slot);
    }
  }
  const mirror = mirrorEnabled(root);
  for (const [id, slot] of valid) {
    if (slot.local && slot.mirror && slot.local.sha !== slot.mirror.sha) add(id, 'both', 'error', 'local and mirror copies differ');
    else if (slot.local && !slot.mirror && mirror) add(id, 'mirror', 'warn', 'missing from the tracked mirror (run "baton ledger export")');
  }
  const acked = new Set();
  for (const slot of valid.values()) {
    const ev = slot.local || slot.mirror;
    if (ev.kind === 'ack' && ev.data?.event) acked.add(ev.data.event);
  }
  for (const p of problems) p.acked = acked.has(p.id);
  return problems.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function copyValid(fromDir, toDir) {
  const copied = [];
  const skipped = [];
  const have = new Set(listIds(toDir));
  for (const id of listIds(fromDir)) {
    if (have.has(id)) continue;
    const file = path.join(fromDir, `${id}.json`);
    const { ev, error } = readEventFile(file);
    const schemaProblems = ev ? validateEventSchema(ev) : [];
    if (error || !ev || typeof ev !== 'object' || Array.isArray(ev) || ev.id !== id || !ev.sha || eventSha(ev) !== ev.sha || schemaProblems.length) {
      skipped.push({ id, reason: error ? 'unreadable' : schemaProblems.length ? `invalid schema: ${schemaProblems.join('; ')}` : 'failed sha check' }); continue;
    }
    writeFileAtomic(path.join(toDir, `${id}.json`), fs.readFileSync(file, 'utf8'));
    copied.push(id);
  }
  return { copied, skipped };
}

/** Copy valid events from the tracked mirror (or `fromDir`) into the local store. */
export function importLedger(root, fromDir = ledgerDir(root)) {
  return withLock(stateDir(root), () => {
    const { copied, skipped } = copyValid(fromDir, eventsDir(root));
    return { imported: copied, skipped };
  });
}

/** Copy valid local events missing from the tracked mirror into `.baton/ledger/`. */
export function exportLedger(root) {
  return withLock(stateDir(root), () => {
    const { copied, skipped } = copyValid(eventsDir(root), ledgerDir(root));
    return { exported: copied, skipped };
  });
}
