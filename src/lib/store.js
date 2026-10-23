import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BatonError } from './errors.js';
import { commonDir } from './git.js';
import { withLock } from './lock.js';
import { utcnow, stamp, sha256, canonicalJson, ensureDir, writeFileAtomic, readJson } from './util.js';
import { LEDGER_VERSION, EVENT_KINDS, EVENT_ID_RE, validateEventSchema } from './event-schema.js';
import { verifyEventAttestation } from './attestation.js';

export { LEDGER_VERSION, EVENT_KINDS, EVENT_ID_RE, validateEventSchema } from './event-schema.js';
export { createEventAttestation, verifyEventAttestation, signEvent } from './attestation.js';

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

/** sha256 of the canonical JSON of the event without its `sha` and `sig` fields. */
export function eventSha(ev) {
  const { sha, sig, ...rest } = ev;
  return sha256(canonicalJson(rest));
}

const cmp = (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Revision stream used for causal ordering and sibling-conflict detection. */
export function eventStream(ev) {
  if (typeof ev.packet === 'string') return `packet:${ev.packet}`;
  if (ev.kind === 'gate' && typeof ev.data?.gate === 'string') return `gate:${ev.data.gate}`;
  return `global:${ev.kind}`;
}

/** Deterministic topological order. Parents always precede children despite clock skew. */
export function orderEvents(events) {
  const byId = new Map(events.map((ev) => [ev.id, ev]));
  const children = new Map(events.map((ev) => [ev.id, []]));
  const indegree = new Map(events.map((ev) => [ev.id, 0]));
  for (const ev of events) {
    for (const parent of ev.parents || []) {
      if (!byId.has(parent)) continue;
      children.get(parent).push(ev.id);
      indegree.set(ev.id, indegree.get(ev.id) + 1);
    }
  }
  const ready = events.filter((ev) => indegree.get(ev.id) === 0).sort(cmp);
  const ordered = [];
  while (ready.length) {
    const ev = ready.shift();
    ordered.push(ev);
    for (const child of children.get(ev.id)) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) { ready.push(byId.get(child)); ready.sort(cmp); }
    }
  }
  if (ordered.length < events.length) {
    const seen = new Set(ordered.map((ev) => ev.id));
    ordered.push(...events.filter((ev) => !seen.has(ev.id)).sort(cmp));
  }
  return ordered;
}

/** Causal/reference problems that must be reconciled before the set is authoritative. */
export function eventOrderingProblems(events) {
  const problems = [];
  const byId = new Map(events.map((ev) => [ev.id, ev]));
  const ids = new Set(byId.keys());
  const revisions = new Map();
  for (const ev of events) {
    for (const parent of ev.parents || []) if (!ids.has(parent)) problems.push({ id: ev.id, problem: `missing causal parent ${parent}` });
    if (ev.rev == null) continue;
    const key = `${eventStream(ev)}@${ev.rev}`;
    const prior = revisions.get(key);
    if (prior && prior !== ev.id) problems.push({ id: ev.id, problem: `concurrent revision conflict with ${prior} in ${eventStream(ev)} at rev ${ev.rev}` });
    else revisions.set(key, ev.id);
  }
  const indegree = new Map(events.map((ev) => [ev.id, 0]));
  const children = new Map(events.map((ev) => [ev.id, []]));
  for (const ev of events) for (const parent of ev.parents || []) if (byId.has(parent)) {
    indegree.set(ev.id, indegree.get(ev.id) + 1);
    children.get(parent).push(ev.id);
  }
  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length) {
    const id = ready.pop(); visited++;
    for (const child of children.get(id)) {
      indegree.set(child, indegree.get(child) - 1);
      if (indegree.get(child) === 0) ready.push(child);
    }
  }
  if (visited !== events.length) for (const [id, degree] of indegree) if (degree > 0) problems.push({ id, problem: 'causal parent cycle' });
  return problems;
}

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
  return orderEvents([...byId.values()]);
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
    const existing = readEvents(root);
    const orderingProblems = eventOrderingProblems(existing);
    if (orderingProblems.length) throw new BatonError(`ledger has unresolved causal conflicts: ${orderingProblems[0].problem}`, {
      code: 'LEDGER_CONFLICT', hint: 'run "baton ledger verify" and reconcile the diverged event set before writing', details: orderingProblems,
    });
    // The newest id comes from file names alone, and only the newest file of each store is parsed to check
    // the format version. Causal revision assignment above intentionally inspects accepted events.
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
    if (partial.op_id != null && String(partial.op_id).trim()) ev.op_id = String(partial.op_id).trim();
    const stream = eventStream(ev);
    const prior = existing.filter((item) => eventStream(item) === stream);
    const parent = prior[prior.length - 1];
    ev.rev = Math.max(prior.length, ...prior.map((item) => item.rev || 0)) + 1;
    ev.parents = parent ? [parent.id] : [];
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
  const accepted = [...valid.values()].map((slot) => slot.local || slot.mirror);
  for (const issue of eventOrderingProblems(accepted)) add(issue.id, 'both', 'error', issue.problem);
  const acked = new Set();
  for (const slot of valid.values()) {
    const ev = slot.local || slot.mirror;
    if (ev.kind === 'ack' && ev.data?.event) acked.add(ev.data.event);
  }
  for (const p of problems) p.acked = acked.has(p.id);
  return problems.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Asserts that the ledger has no unacknowledged integrity problems before performing
 * a sensitive operation (such as merging an accepted packet into main, or transitioning
 * to an accepted/ready state). Throws BatonError with code LEDGER_INTEGRITY_COMPROMISED
 * and a concrete remediation report if tampered or corrupt events are detected.
 *
 * @param {string} root
 * @param {{packet?: string, action?: string, config?: object}} [options]
 */
export function assertSensitiveReplay(root, { packet, action = 'sensitive operation', config } = {}) {
  const problems = verifyLedger(root);
  const unackedErrors = problems.filter((p) => p.severity === 'error' && !p.acked);
  if (unackedErrors.length > 0) {
    const report = unackedErrors.map((p) => `  - [${p.where}] ${p.id}: ${p.problem}`).join('\n');
    throw new BatonError(
      `ledger integrity check failed before ${action}${packet ? ` for ${packet}` : ''}: tampered, corrupted or conflicting events detected\n${report}`,
      {
        code: 'LEDGER_INTEGRITY_COMPROMISED',
        hint: 'run "baton ledger verify" to inspect anomalies; use "baton ledger export" or "baton ledger reconcile" to align state, or acknowledge verified historical anomalies with an ack event',
        details: unackedErrors,
      }
    );
  }

  // Optional cryptographic attestation check if enabled in config
  if (config?.security?.requireAttestation || config?.security?.requireSignatures) {
    const keys = config.security.keys || {};
    const events = readEvents(root);
    const targetEvents = packet ? events.filter((e) => e.packet === packet) : events;
    for (const ev of targetEvents) {
      if (['verdict', 'verify', 'merged'].includes(ev.kind)) {
        if (!ev.sig) {
          throw new BatonError(`event ${ev.id} (${ev.kind}) lacks required cryptographic attestation`, {
            code: 'ATTESTATION_MISSING',
            hint: 'security.requireAttestation is enabled; sensitive events must carry a valid signature',
          });
        }
        const pubKey = keys[ev.sig.key];
        if (!pubKey) {
          throw new BatonError(`unknown public key "${ev.sig.key}" for event ${ev.id}`, {
            code: 'ATTESTATION_KEY_UNKNOWN',
          });
        }
        const v = verifyEventAttestation(ev, pubKey);
        if (!v.valid) {
          throw new BatonError(`invalid cryptographic attestation on event ${ev.id}: ${v.reason}`, {
            code: 'ATTESTATION_INVALID',
          });
        }
      }
    }
  }

  return { ok: true };
}

/**
 * Reconciles the local event store with an incoming event directory (e.g. tracked mirror or remote clone).
 * Detects missing parents, corrupt events, revision conflicts, and semantic conflicts (conflicting claims,
 * divergent verdicts). Independent safe events are merged deterministically; unsafe conflicts are surfaced
 * without silently choosing an inconsistent owner or verdict.
 *
 * @param {string} root
 * @param {{fromDir?: string, dryRun?: boolean}} [options]
 * @returns {{
 *   ok: boolean,
 *   dryRun: boolean,
 *   from: string,
 *   counts: { total: number, identical: number, safe: number, applied: number, conflicts: number, skipped: number },
 *   identical: string[],
 *   safe: string[],
 *   applied: string[],
 *   conflicts: Array<{ id: string, type: string, packet?: string, stream?: string, reason: string, action: string, localEvent?: string, remoteEvent?: string }>,
 *   skipped: Array<{ id: string, reason: string, type: string }>
 * }}
 */
export function reconcileLedger(root, { fromDir = ledgerDir(root), dryRun = false } = {}) {
  return withLock(stateDir(root), () => {
    const fromPath = path.resolve(fromDir);
    if (!fs.existsSync(fromPath)) {
      return {
        ok: true,
        dryRun: Boolean(dryRun),
        from: fromPath,
        counts: { total: 0, identical: 0, safe: 0, applied: 0, conflicts: 0, skipped: 0 },
        identical: [],
        safe: [],
        applied: [],
        conflicts: [],
        skipped: [],
      };
    }

    const localStoreDir = eventsDir(root);
    const localMirrorDir = ledgerDir(root);
    const localStoreIds = new Set(listIds(localStoreDir));
    const localEvents = readEvents(root);
    const localById = new Map(localEvents.map((e) => [e.id, e]));
    const mirror = mirrorEnabled(root);

    const remoteIds = listIds(fromPath);
    const skipped = [];
    const identical = [];
    const candidateEvents = [];

    // 1. Structural & cryptographic integrity pass on remote files
    for (const id of remoteIds) {
      const file = path.join(fromPath, `${id}.json`);
      const { ev, error } = readEventFile(file);
      if (error) {
        skipped.push({ id, reason: error ? 'unreadable' : `unreadable JSON (${error})`, type: 'unreadable' });
        continue;
      }
      if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
        skipped.push({ id, reason: 'event must be a JSON object', type: 'corrupt' });
        continue;
      }
      if (ev.id !== id) {
        skipped.push({ id, reason: `filename does not match event id ${ev.id}`, type: 'corrupt' });
        continue;
      }
      if (!ev.sha || eventSha(ev) !== ev.sha) {
        skipped.push({ id, reason: 'failed sha check', type: 'sha_mismatch' });
        continue;
      }
      const schemaProblems = validateEventSchema(ev);
      if (schemaProblems.length) {
        skipped.push({ id, reason: `invalid schema: ${schemaProblems.join('; ')}`, type: 'invalid_schema' });
        continue;
      }

      if (localStoreIds.has(id)) {
        const localFile = path.join(localStoreDir, `${id}.json`);
        const { ev: localEv } = readEventFile(localFile);
        if (localEv && localEv.sha === ev.sha) {
          identical.push(id);
        } else {
          skipped.push({ id, reason: 'tampered: local and remote copies with same ID have differing hashes', type: 'sha_mismatch' });
        }
      } else {
        candidateEvents.push(ev);
      }
    }

    // 2. Graph and DAG validation (parents, cycles, revision collisions)
    const conflicts = [];
    const conflictedIds = new Set();

    // Map of all known valid events (local + candidate)
    const combinedById = new Map(localById);
    for (const ev of candidateEvents) {
      combinedById.set(ev.id, ev);
    }

    // Check missing parents
    for (const ev of candidateEvents) {
      for (const parentId of ev.parents || []) {
        if (!combinedById.has(parentId)) {
          conflicts.push({
            id: ev.id,
            type: 'missing_parent',
            parent: parentId,
            reason: `missing causal parent ${parentId}`,
            action: 'Pull predecessor commits or fetch missing events from origin',
          });
          conflictedIds.add(ev.id);
        }
      }
    }

    // Check cycles in candidate + local
    const eventsForCycleCheck = [...localEvents, ...candidateEvents.filter((e) => !conflictedIds.has(e.id))];
    const indegree = new Map(eventsForCycleCheck.map((ev) => [ev.id, 0]));
    const children = new Map(eventsForCycleCheck.map((ev) => [ev.id, []]));
    for (const ev of eventsForCycleCheck) {
      for (const parent of ev.parents || []) {
        if (indegree.has(parent)) {
          indegree.set(ev.id, indegree.get(ev.id) + 1);
          children.get(parent).push(ev.id);
        }
      }
    }
    const ready = [...indegree].filter(([, deg]) => deg === 0).map(([id]) => id);
    let visitedCount = 0;
    while (ready.length) {
      const id = ready.pop();
      visitedCount++;
      for (const child of children.get(id) || []) {
        indegree.set(child, indegree.get(child) - 1);
        if (indegree.get(child) === 0) ready.push(child);
      }
    }
    if (visitedCount !== eventsForCycleCheck.length) {
      for (const [id, deg] of indegree) {
        if (deg > 0 && !conflictedIds.has(id) && !localById.has(id)) {
          conflicts.push({
            id,
            type: 'causal_cycle',
            reason: 'causal parent cycle detected',
            action: 'Break circular event dependency or discard invalid event',
          });
          conflictedIds.add(id);
        }
      }
    }

    // Check revision collisions in same stream
    const streamRevisions = new Map();
    for (const ev of localEvents) {
      if (ev.rev != null) {
        streamRevisions.set(`${eventStream(ev)}@${ev.rev}`, ev.id);
      }
    }
    for (const ev of candidateEvents) {
      if (conflictedIds.has(ev.id) || ev.rev == null) continue;
      const key = `${eventStream(ev)}@${ev.rev}`;
      const existingId = streamRevisions.get(key);
      if (existingId && existingId !== ev.id) {
        conflicts.push({
          id: ev.id,
          type: 'rev_conflict',
          stream: eventStream(ev),
          rev: ev.rev,
          conflictingWith: existingId,
          reason: `concurrent revision conflict with ${existingId} in ${eventStream(ev)} at rev ${ev.rev}`,
          action: 'Resolve branch divergence or rebase events sequentially',
        });
        conflictedIds.add(ev.id);
      } else {
        streamRevisions.set(key, ev.id);
      }
    }

    // 3. Semantic / business-rule conflicts (claim conflicts & verdict conflicts)
    const localPacketClaims = new Map();
    const localPacketVerdicts = new Map();
    for (const ev of localEvents) {
      if (!ev.packet) continue;
      if (ev.kind === 'begin') {
        localPacketClaims.set(ev.packet, {
          by: ev.by,
          eventId: ev.id,
          leaseUntil: ev.data?.lease_until || null,
          leaseToken: ev.data?.lease_token || 0,
        });
      } else if (ev.kind === 'handoff' && ev.to === 'BLOCKED') {
        localPacketClaims.delete(ev.packet);
      }
      if (ev.kind === 'verdict') {
        localPacketVerdicts.set(ev.packet, {
          outcome: ev.to,
          by: ev.by,
          eventId: ev.id,
        });
      }
    }

    const now = utcnow();
    for (const ev of candidateEvents) {
      if (conflictedIds.has(ev.id) || !ev.packet) continue;

      // Claim conflict check
      if (ev.kind === 'begin') {
        const localClaim = localPacketClaims.get(ev.packet);
        if (localClaim && localClaim.by && localClaim.by !== ev.by) {
          const leaseEnd = localClaim.leaseUntil ? new Date(localClaim.leaseUntil) : null;
          const evTime = ev.ts ? new Date(ev.ts) : now;
          const isExpiredReclaim = (leaseEnd && evTime > leaseEnd) || ev.note?.startsWith('reclaimed');
          if (!isExpiredReclaim) {
            conflicts.push({
              id: ev.id,
              type: 'claim_conflict',
              packet: ev.packet,
              localOwner: localClaim.by,
              remoteClaimant: ev.by,
              localEvent: localClaim.eventId,
              remoteEvent: ev.id,
              reason: `concurrent conflicting claim on packet ${ev.packet} by ${ev.by} (locally owned by ${localClaim.by})`,
              action: 'Arbitrate packet ownership: keep local claim or yield with baton begin --force',
            });
            conflictedIds.add(ev.id);
            continue;
          }
        }
      }

      // Verdict conflict check
      if (ev.kind === 'verdict') {
        const localVerdict = localPacketVerdicts.get(ev.packet);
        if (localVerdict && localVerdict.outcome !== ev.to) {
          conflicts.push({
            id: ev.id,
            type: 'verdict_conflict',
            packet: ev.packet,
            localVerdict: localVerdict.outcome,
            remoteVerdict: ev.to,
            localEvent: localVerdict.eventId,
            remoteEvent: ev.id,
            reason: `conflicting verdict for packet ${ev.packet} (${localVerdict.outcome} locally vs ${ev.to} remotely)`,
            action: 'Review contradictory reviews and submit a resolving verdict',
          });
          conflictedIds.add(ev.id);
          continue;
        }
      }
    }

    // 4. Cascade: any candidate event depending on a conflicted event is transitively conflicted
    let changed = true;
    while (changed) {
      changed = false;
      for (const ev of candidateEvents) {
        if (conflictedIds.has(ev.id)) continue;
        for (const parentId of ev.parents || []) {
          if (conflictedIds.has(parentId)) {
            conflicts.push({
              id: ev.id,
              type: 'dependency_conflict',
              reason: `depends on conflicted event ${parentId}`,
              action: 'Resolve root conflict first',
            });
            conflictedIds.add(ev.id);
            changed = true;
            break;
          }
        }
      }
    }

    // 5. Safe events partition & deterministic ordering
    const safeCandidateEvents = candidateEvents.filter((ev) => !conflictedIds.has(ev.id));
    const safeOrdered = orderEvents(safeCandidateEvents);
    const safeIds = safeOrdered.map((e) => e.id);

    // 6. Apply if not dry-run
    const applied = [];
    if (!dryRun) {
      for (const ev of safeOrdered) {
        const text = JSON.stringify(ev, null, 2) + '\n';
        writeFileAtomic(path.join(localStoreDir, `${ev.id}.json`), text);
        if (mirror) {
          writeFileAtomic(path.join(localMirrorDir, `${ev.id}.json`), text);
        }
        applied.push(ev.id);
      }
    }

    return {
      ok: conflicts.length === 0 && skipped.length === 0,
      dryRun: Boolean(dryRun),
      from: fromPath,
      counts: {
        total: remoteIds.length,
        identical: identical.length,
        safe: safeIds.length,
        applied: applied.length,
        conflicts: conflicts.length,
        skipped: skipped.length,
      },
      identical,
      safe: safeIds,
      applied,
      conflicts,
      skipped,
    };
  });
}

function copyValid(fromDir, toDir, { dryRun = false } = {}) {
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
    if (!dryRun) writeFileAtomic(path.join(toDir, `${id}.json`), fs.readFileSync(file, 'utf8'));
    copied.push(id);
  }
  return { copied, skipped };
}

/** Copy valid events from the tracked mirror (or `fromDir`) into the local store. */
export function importLedger(root, fromDir = ledgerDir(root), { dryRun = false } = {}) {
  return withLock(stateDir(root), () => {
    const { copied, skipped } = copyValid(fromDir, eventsDir(root), { dryRun });
    return { imported: copied, skipped };
  });
}

/** Copy valid local events missing from the tracked mirror into `.baton/ledger/`. */
export function exportLedger(root, { dryRun = false } = {}) {
  return withLock(stateDir(root), () => {
    const { copied, skipped } = copyValid(eventsDir(root), ledgerDir(root), { dryRun });
    return { exported: copied, skipped };
  });
}
