import fs from 'node:fs';
import path from 'node:path';
import { BatonError } from './errors.js';
import { utcnow, stamp, addHours, parseTime, daysUntil, readJson, writeJsonAtomic, assertInside, isProcessAlive } from './util.js';
import { loadConfig, hasRole, getAgent, isKnownActor, RESERVED_AGENTS } from './config.js';
import { loadPlan, packetsOverlap } from './plan.js';
import { patternsOverlap, BUILTIN_COORDINATION } from './glob.js';
import { appendEvent, readEvents, stateDir, stateSub, EVENT_KINDS, assertSensitiveReplay } from './store.js';
import { withLock } from './lock.js';
import { headCommit, isDirty, preserveGitWork, listWorktrees } from './git.js';
import { saveSnapshot, packetFingerprint } from './snapshot.js';
import { fingerprint } from './util.js';

export { EVENT_KINDS };

export const STATUSES = ['PLANNED', 'IN_PROGRESS', 'BLOCKED', 'READY_FOR_REVIEW', 'ACCEPTED', 'ACCEPTED_WITH_FIXES', 'REJECTED', 'CARRIED_OVER'];
export const DONE = new Set(['ACCEPTED', 'ACCEPTED_WITH_FIXES']);
/** A dependency is satisfied (for same-track starts) once its work is reviewable. */
export const REVIEWABLE = new Set(['READY_FOR_REVIEW', 'ACCEPTED', 'ACCEPTED_WITH_FIXES']);
export const ACTIVE = new Set(['IN_PROGRESS', 'READY_FOR_REVIEW']);
/** Entering IN_PROGRESS from here re-runs the dependency, gate and ownership-clash checks. */
export const STARTABLE = new Set(['PLANNED', 'CARRIED_OVER', 'REJECTED', 'BLOCKED']);
/** Entering IN_PROGRESS from here is "rework" by a prior contributor; dependency and gate checks are skipped. */
export const REWORK = new Set(['READY_FOR_REVIEW', 'ACCEPTED_WITH_FIXES']);
export const REVIEW_OUTCOMES = new Set(['ACCEPTED', 'ACCEPTED_WITH_FIXES', 'REJECTED']);
export const TRANSITIONS = {
  PLANNED: new Set(['IN_PROGRESS', 'BLOCKED']),
  CARRIED_OVER: new Set(['IN_PROGRESS', 'BLOCKED']),
  IN_PROGRESS: new Set(['READY_FOR_REVIEW', 'BLOCKED']),
  BLOCKED: new Set(['IN_PROGRESS']),
  READY_FOR_REVIEW: new Set(['ACCEPTED', 'ACCEPTED_WITH_FIXES', 'REJECTED', 'IN_PROGRESS']),
  ACCEPTED_WITH_FIXES: new Set(['ACCEPTED', 'IN_PROGRESS']),
  REJECTED: new Set(['CARRIED_OVER', 'IN_PROGRESS']),
  ACCEPTED: new Set(),
};
export const MESSAGE_TYPES = ['CLAIM', 'RELEASE', 'REQUEST', 'NOTICE', 'BLOCKER', 'HANDOFF', 'VERDICT', 'QUESTION', 'SIGNOFF'];
export const SEVERITIES = ['BLOCKER', 'MAJOR', 'MINOR'];
export const RESOLUTIONS = ['fixed', 'wontfix', 'invalid'];
const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

// ------------------------------------------------------------------ state

function freshPacketState(p) {
  return {
    id: p.id, status: 'PLANNED', agent: p.agent ?? null, reviewer: p.reviewer ?? null, by: null, contributors: [],
    leaseUntil: null, base: null, commit: null, depCommits: {}, rejections: 0, lastTs: null, merged: null,
    verdict: null, blockedReason: null, claimEventId: null, claimConflicts: [], leaseToken: 0,
  };
}

/** Empty state for a plan: every packet PLANNED, gates as declared in the plan. */
export function initialState(plan) {
  const packets = {};
  for (const p of plan.packets) packets[p.id] = freshPacketState(p);
  const gates = {};
  for (const g of plan.gates || []) gates[g.id] = { id: g.id, title: g.title ?? '', owner: g.owner ?? 'human', open: g.open === true, by: null, ts: null, note: '' };
  return { packets, gates };
}

/** Apply one event to a state object in place (also used by scores and audits). */
export function applyEvent(state, ev) {
  const data = ev.data || {};
  if (ev.kind === 'gate') {
    const g = state.gates[data.gate];
    if (g) Object.assign(g, { open: !!data.open, by: ev.by, ts: ev.ts, note: ev.note || '' });
    return;
  }
  const s = state.packets[ev.packet];
  if (!s) return;
  s.lastTs = ev.ts;
  if (ev.to) {
    s.status = ev.to;
    s.blockedReason = ev.to === 'BLOCKED' ? (data.reason ?? ev.note ?? '') : null;
  }
  const add = (a) => { if (a && !s.contributors.includes(a)) { s.contributors.push(a); s.contributors.sort(); } };
  switch (ev.kind) {
    case 'begin':
      add(ev.by);
      const isReclaim = ev.note?.startsWith('reclaimed')
        || (parseTime(s.leaseUntil) && parseTime(ev.ts) && parseTime(ev.ts) > parseTime(s.leaseUntil));
      if (s.status === 'IN_PROGRESS' && s.by && s.by !== ev.by && !isReclaim) {
        s.claimConflicts.push({
          claimant: ev.by,
          eventId: ev.id,
          winningClaimant: s.by,
          winningEventId: s.claimEventId || null,
          ts: ev.ts,
        });
        break;
      }
      s.leaseToken = data.lease_token != null ? data.lease_token : ((s.leaseToken || 0) + 1);
      Object.assign(s, { by: ev.by, base: data.base ?? null, leaseUntil: data.lease_until ?? null, commit: null, claimEventId: ev.id, leaseToken: s.leaseToken });
      if (data.dep_commits) s.depCommits = { ...data.dep_commits };
      break;
    case 'heartbeat':
      if (data.lease_token != null && s.leaseToken && data.lease_token !== s.leaseToken) {
        break;
      }
      add(ev.by);
      s.leaseUntil = data.lease_until ?? null;
      s.by = s.by || ev.by;
      break;
    case 'ready':
      s.commit = data.commit ?? null;
      break;
    case 'reviewer':
      s.reviewer = data.reviewer ?? null;
      break;
    case 'handoff':
      s.agent = data.agent ?? s.agent;
      s.leaseToken = (s.leaseToken || 0) + 1;
      if (ev.to === 'BLOCKED') { s.by = null; s.leaseUntil = null; s.claimEventId = null; }
      break;
    case 'verdict':
      s.verdict = { outcome: ev.to, by: ev.by, score: data.score ?? null, ts: ev.ts };
      if (ev.to === 'REJECTED') s.rejections += 1;
      break;
    case 'merged':
      s.merged = data.commit ?? null;
      break;
    default:
  }
}

/**
 * Replay events over the plan.
 * @returns {{packets: Record<string, PacketState>, gates: Record<string, GateState>}}
 *   PacketState: {id, status, agent, reviewer, by, contributors[], leaseUntil, base, commit, depCommits{}, rejections,
 *   lastTs, merged, verdict, blockedReason}; GateState: {id, title, owner, open, by, ts, note}
 */
export function derive(plan, events) {
  const state = initialState(plan);
  for (const ev of events) applyEvent(state, ev);
  return state;
}

/** Load config, plan, events and derived state fresh from disk. */
export function load(root) {
  const config = loadConfig(root);
  const plan = loadPlan(root);
  const events = readEvents(root);
  return { config, plan, events, state: derive(plan, events) };
}

export function getPacket(plan, pid) {
  const p = plan.packets.find((x) => x.id === pid);
  if (!p) throw new BatonError(`unknown packet ${pid}`, { code: 'UNKNOWN_PACKET', hint: 'run "baton status" to list packet ids' });
  return p;
}

// ------------------------------------------------------------------ rules

export function gateBlocks(packet, state) {
  if (!packet.gate || packet.gate_mode === 'live_only') return false;
  return !state.gates[packet.gate]?.open;
}

/**
 * Unmet dependencies that block STARTING. Only same-track dependencies block (until reviewable); cross-track ones
 * never block (they raise AT_RISK). `needs_done` always blocks until ACCEPTED.
 */
export function blockingDeps(packet, plan, state) {
  const map = Object.fromEntries(plan.packets.map((p) => [p.id, p]));
  const soft = (packet.deps || []).filter((d) => map[d] && !REVIEWABLE.has(state.packets[d].status)
    && (!packet.track || map[d].track === packet.track));
  const hard = (packet.needs_done || []).filter((d) => map[d] && state.packets[d].status !== 'ACCEPTED');
  return [...soft, ...hard.filter((d) => !soft.includes(d))];
}

export function reviewerOf(pid, state) {
  return state.packets[pid].reviewer;
}

/**
 * Advisory flags: NO_LEASE, STALE, AT_RISK:<dep>=<status>, AT_RISK:<dep>-changed, ESCALATE, GATE_CLOSED:<id>.
 * @returns {string[]}
 */
export function flags(pid, plan, state, { config = {}, now = utcnow() } = {}) {
  const p = getPacket(plan, pid);
  const s = state.packets[pid];
  const out = [];
  if (s.status === 'IN_PROGRESS') {
    const lease = parseTime(s.leaseUntil);
    if (!lease) out.push('NO_LEASE');
    else if (now > lease) out.push('STALE');
  }
  if (ACTIVE.has(s.status)) {
    for (const dep of p.deps) {
      const ds = state.packets[dep];
      if (!ds) continue;
      const seen = s.depCommits[dep];
      if (!REVIEWABLE.has(ds.status)) out.push(`AT_RISK:${dep}=${ds.status}`);
      else if (seen != null && seen !== 'unbuilt' && seen !== ds.commit) out.push(`AT_RISK:${dep}-changed`);
    }
  }
  if (s.rejections >= (config.escalateAfterRejections ?? 2) && !DONE.has(s.status)) out.push('ESCALATE');
  if (p.gate && !DONE.has(s.status) && state.gates[p.gate] && !state.gates[p.gate].open) out.push(`GATE_CLOSED:${p.gate}`);
  if (s.claimConflicts?.length) {
    const claimants = [...new Set(s.claimConflicts.map((c) => c.claimant))].sort().join(',');
    out.push(`CLAIM_CONFLICT:${claimants}`);
  }
  return out;
}

/** Plan packets that can be started right now (PLANNED/CARRIED_OVER/REJECTED, deps and gate satisfied, no overlap with IN_PROGRESS work). */
export function readyPackets(plan, state) {
  const working = plan.packets.filter((p) => state.packets[p.id].status === 'IN_PROGRESS');
  return plan.packets.filter((p) => {
    if (!['PLANNED', 'CARRIED_OVER', 'REJECTED'].includes(state.packets[p.id].status)) return false;
    if (blockingDeps(p, plan, state).length || gateBlocks(p, state)) return false;
    return !working.some((w) => packetsOverlap(p, w).length);
  });
}

function milestoneRank(plan) {
  const r = {};
  [...plan.milestones].sort((a, b) => String(a.due || '9999').localeCompare(String(b.due || '9999'))).forEach((m, i) => { r[m.id] = i; });
  return r;
}

/**
 * Work queue for an agent. Every list holds packet ids.
 * awaitingReview: READY_FOR_REVIEW packets you review; reworkOwed: yours to fix (ACCEPTED_WITH_FIXES, BLOCKED, REJECTED, CARRIED_OVER);
 * own: ready packets assigned to you (non-stretch); stretch: ready optional packets assigned to you; pull: ready packets of other agents;
 * staleReclaimable: IN_PROGRESS with an expired lease held by someone else; audit: reviewable packets by others you did not touch.
 */
export function nextFor(agent, plan, state, { config = {}, now = utcnow() } = {}) {
  const mr = milestoneRank(plan);
  const rank = (p) => [
    ['CARRIED_OVER', 'REJECTED'].includes(state.packets[p.id].status) ? 0 : 1,
    mr[p.milestone] ?? 99, PRIORITY_RANK[p.priority] ?? 9, state.packets[p.id].agent === agent ? 0 : 1, p.id,
  ];
  const sorter = (a, b) => {
    const x = rank(a); const y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  };
  const ready = readyPackets(plan, state).sort(sorter);
  const mine = (p) => state.packets[p.id].agent === agent;
  const contributor = (p) => state.packets[p.id].contributors.includes(agent);
  const audit = plan.packets.filter((p) => REVIEWABLE.has(state.packets[p.id].status) && !mine(p) && !contributor(p))
    .sort((a, b) => {
      const sa = state.packets[a.id]; const sb = state.packets[b.id];
      return (sa.status !== 'READY_FOR_REVIEW') - (sb.status !== 'READY_FOR_REVIEW')
        || (sa.reviewer !== agent) - (sb.reviewer !== agent) || a.id.localeCompare(b.id);
    });
  return {
    agent,
    awaitingReview: audit.filter((p) => state.packets[p.id].status === 'READY_FOR_REVIEW' && state.packets[p.id].reviewer === agent).map((p) => p.id),
    reworkOwed: plan.packets.filter((p) => (mine(p) || contributor(p)) && ['ACCEPTED_WITH_FIXES', 'BLOCKED', 'REJECTED', 'CARRIED_OVER'].includes(state.packets[p.id].status)).map((p) => p.id),
    own: ready.filter((p) => mine(p) && !p.stretch).map((p) => p.id),
    stretch: ready.filter((p) => mine(p) && p.stretch).map((p) => p.id),
    pull: ready.filter((p) => !mine(p) && state.packets[p.id].agent).map((p) => p.id),
    unassigned: ready.filter((p) => !state.packets[p.id].agent).map((p) => p.id),
    staleReclaimable: plan.packets.filter((p) => flags(p.id, plan, state, { config, now }).includes('STALE')).map((p) => p.id),
    audit: audit.map((p) => p.id),
  };
}

// ------------------------------------------------------------------ identity

/** If BATON_AGENT is set, commands may only act as that agent. Enforces actor-match in GitHub Actions when configured. */
export function checkIdentity(claimed, env = process.env, config = null) {
  const me = env?.BATON_AGENT;
  if (me && claimed && me !== claimed) throw new BatonError(`BATON_AGENT=${me} but the command acts as ${claimed}`, { code: 'IDENTITY' });
  if (config?.security?.requireActorMatch && env?.GITHUB_ACTIONS === 'true' && env?.GITHUB_ACTOR) {
    const ag = getAgent(config, claimed);
    if (ag?.github && env.GITHUB_ACTOR.toLowerCase() !== ag.github.toLowerCase()) {
      throw new BatonError(`GitHub actor "${env.GITHUB_ACTOR}" does not match assigned agent "${claimed}" (expected GitHub username "${ag.github}")`, {
        code: 'IDENTITY_MISMATCH',
      });
    }
  }
}

function requireActor(config, id, what = 'actor') {
  if (!id) throw new BatonError(`${what} is required`, { code: 'NO_ACTOR' });
  if (!isKnownActor(config, id)) throw new BatonError(`unknown ${what} "${id}" (not in the roster)`, { code: 'UNKNOWN_AGENT' });
}

function requireOrchestrator(config, by) {
  if (by !== config.orchestrator && by !== 'human') throw new BatonError(`only the orchestrator (${config.orchestrator}) or human may do this; got ${by}`, { code: 'NOT_ORCHESTRATOR' });
}

// ------------------------------------------------------------------ verify marker

export function verifyMarkerPath(root, pid) {
  const dir = stateSub(root, 'verified');
  return assertInside(dir, path.join(dir, `${pid}.json`));
}

export function readVerifyMarker(root, pid) {
  return readJson(verifyMarkerPath(root, pid), null);
}

function clearVerifyMarker(root, pid) {
  try { fs.unlinkSync(verifyMarkerPath(root, pid)); } catch { /* none */ }
}

/**
 * Filter ledger events for an operation ID.
 * @param {object[]} events
 * @param {string|null} opId
 * @returns {object[]}
 */
export function findOperationEvents(events, opId) {
  if (!opId) return [];
  const target = String(opId).trim();
  return events.filter((ev) => ev.op_id === target);
}

/**
 * Persist a verify result and append a `verify` event. `result` must carry {ok, mode, commit, fingerprint, tests:{tail}}.
 * Modes starting with "git-branch" are bound to a clean tree at HEAD == commit; other modes (git-shared, snapshot) to the fingerprint (`fingerprint_kind: "owned"` = only the packet's own files; otherwise the whole tree).
 */
export function recordVerify(root, pid, result, opts = {}) {
  return withLock(stateDir(root), () => {
    const { plan, state } = load(root);
    getPacket(plan, pid);
    const leaseToken = state.packets[pid]?.leaseToken || 0;
    const opId = opts.opId || opts.op_id || null;
    if (opId) {
      const existing = findOperationEvents(readEvents(root), opId);
      const verEv = existing.find((e) => e.packet === pid && e.kind === 'verify');
      if (verEv) {
        const marker = { ...result, lease_token: verEv.data.lease_token ?? leaseToken, op_id: opId };
        writeJsonAtomic(verifyMarkerPath(root, pid), marker);
        return verEv;
      }
    }
    const marker = { ...result, lease_token: leaseToken, ...(opId ? { op_id: opId } : {}) };
    writeJsonAtomic(verifyMarkerPath(root, pid), marker);
    return appendEvent(root, {
      packet: pid, kind: 'verify', by: 'harness', ...(opId ? { op_id: opId } : {}),
      data: { ok: !!result.ok, commit: result.commit ?? null, mode: result.mode ?? null, lease_token: leaseToken },
    });
  });
}

// ------------------------------------------------------------------ messages

/**
 * Append a bus message. type in MESSAGE_TYPES; `to` is "all" or an actor id.
 * @param {string} root
 * @param {{from: string, to?: string, type: string, text: string, packet?: string|null}} m
 */
export function postMessage(root, { from, to = 'all', type, text, packet = null, opId = null }) {
  if (!MESSAGE_TYPES.includes(type)) throw new BatonError(`message type must be one of ${MESSAGE_TYPES.join('|')}`, { code: 'BAD_MESSAGE' });
  if (!String(text || '').trim()) throw new BatonError('a message needs text', { code: 'BAD_MESSAGE' });
  const config = loadConfig(root);
  requireActor(config, from, 'sender');
  if (to !== 'all') requireActor(config, to, 'recipient');
  checkIdentity(from);
  if (opId) {
    const existing = findOperationEvents(readEvents(root), opId);
    const found = existing.find((e) => e.kind === 'message' && e.data?.type === type && (packet == null || e.packet === packet));
    if (found) return found;
  }
  return appendEvent(root, { packet, kind: 'message', by: from, ...(opId ? { op_id: opId } : {}), data: { type, to, text: String(text) } });
}

// ------------------------------------------------------------------ transition

/**
 * The full rule set of docs 2.3. Appends one event and returns it.
 * @param {string} root
 * @param {string} pid
 * @param {string} to target status
 * @param {{by?: string|null, note?: string, kind?: string, data?: object}} [opts] kind "begin" is required for IN_PROGRESS
 */
export function transition(root, pid, to, { by = null, note = '', kind = 'status', data = {}, opId = null, env = process.env } = {}) {
  return withLock(stateDir(root), () => {
    const { config, plan, state } = load(root);
    if (['ACCEPTED', 'ACCEPTED_WITH_FIXES', 'READY_FOR_REVIEW'].includes(to)) {
      assertSensitiveReplay(root, { packet: pid, action: `transition to ${to}`, config });
    }
    const p = getPacket(plan, pid);
    checkIdentity(by, env, config);
    const s = state.packets[pid];
    const old = s.status;
    if (!STATUSES.includes(to)) throw new BatonError(`invalid status ${to}`, { code: 'BAD_STATUS' });
    if (!TRANSITIONS[old].has(to)) {
      throw new BatonError(`${pid}: ${old} -> ${to} is not allowed (allowed: ${[...TRANSITIONS[old]].join(', ') || 'none'})`, { code: 'BAD_TRANSITION', hint: `run "baton review ${pid}" to see its state and what comes next` });
    }
    if (to === 'IN_PROGRESS') {
      if (kind !== 'begin') throw new BatonError(`${pid}: IN_PROGRESS is reachable only through "begin" (lease, snapshot and claim)`, { code: 'BEGIN_ONLY' });
      if (!REWORK.has(old)) {
        const unmet = blockingDeps(p, plan, state);
        if (unmet.length) throw new BatonError(`${pid}: dependencies not yet ready: ${unmet.join(', ')}`, { code: 'DEPS_UNMET' });
        if (gateBlocks(p, state)) throw new BatonError(`${pid}: human gate ${p.gate} is closed`, { code: 'GATE_CLOSED' });
      }
      const clash = plan.packets.filter((q) => q.id !== pid && state.packets[q.id].status === 'IN_PROGRESS' && packetsOverlap(p, q).length).map((q) => q.id);
      if (clash.length) throw new BatonError(`${pid}: file ownership overlaps in-progress packet(s) ${clash.join(', ')}`, { code: 'OWNERSHIP_CLASH' });
    }
    let evKind = kind;
    let evData = { ...data };
    if (REVIEW_OUTCOMES.has(to)) {
      if (!s.reviewer) throw new BatonError(`${pid}: no reviewer assigned`, { code: 'NO_REVIEWER' });
      if (by !== s.reviewer && by !== 'human') throw new BatonError(`${pid}: only the assigned reviewer (${s.reviewer}) or human may record a verdict; got --by ${by}`, { code: 'NOT_REVIEWER' });
      if (config.requireDifferentReviewer !== false && by !== 'human' && (s.contributors.includes(by) || by === s.agent)) {
        throw new BatonError(`${pid}: the reviewer worked on this packet; use "baton reassign"`, { code: 'REVIEWER_CONFLICT' });
      }
      const open = findingsOf(readEvents(root), pid).filter((f) => f.status !== 'closed');
      if (to === 'ACCEPTED') {
        const blocking = open.filter((f) => f.severity === 'BLOCKER' || f.severity === 'MAJOR');
        if (blocking.length) throw new BatonError(`${pid}: cannot accept with open BLOCKER/MAJOR findings: ${blocking.map((f) => f.fid).join(', ')}`, { code: 'OPEN_FINDINGS' });
      }
      if (to === 'REJECTED' && !String(note).trim() && !findingsOf(readEvents(root), pid).length) {
        throw new BatonError(`${pid}: a rejection needs a note or at least one finding`, { code: 'REJECT_NEEDS_REASON' });
      }
      evKind = 'verdict';
      evData = { ...evData, commit: s.commit };
    }
    if (to === 'READY_FOR_REVIEW') {
      const marker = readVerifyMarker(root, pid) || {};
      if (!marker.ok) throw new BatonError(`${pid}: run "baton verify ${pid}" successfully before requesting review`, { code: 'NOT_VERIFIED' });
      if (marker.lease_token != null && s.leaseToken && marker.lease_token !== s.leaseToken) {
        throw new BatonError(`${pid}: verified under lease token ${marker.lease_token} but current lease token is ${s.leaseToken}; verify again`, { code: 'STALE_LEASE_TOKEN' });
      }
      const verifyEvents = readEvents(root).filter((e) => e.packet === pid && e.kind === 'verify');
      const latestVerify = verifyEvents[verifyEvents.length - 1];
      if (!latestVerify || !latestVerify.data?.ok) {
        throw new BatonError(`${pid}: no passing verify event found in ledger (uncommitted verify); run "baton verify ${pid}"`, { code: 'NOT_VERIFIED' });
      }
      if (latestVerify.data?.lease_token != null && s.leaseToken && latestVerify.data.lease_token !== s.leaseToken) {
        throw new BatonError(`${pid}: latest verify event is under lease token ${latestVerify.data.lease_token} but current lease token is ${s.leaseToken}; verify again`, { code: 'STALE_LEASE_TOKEN' });
      }
      if (String(marker.mode || '').startsWith('git-branch')) {
        if (isDirty(root, { exclude: BUILTIN_COORDINATION })) throw new BatonError(`${pid}: commit your work first so the reviewer sees an exact artifact`, { code: 'DIRTY_TREE' });
        if (marker.commit !== headCommit(root)) throw new BatonError(`${pid}: HEAD moved since verify; run verify again`, { code: 'STALE_VERIFY' });
      } else if (marker.fingerprint !== (marker.fingerprint_kind === 'owned' ? packetFingerprint(root, p.owns) : fingerprint(root))) {
        throw new BatonError(`${pid}: files changed since verify; run verify again`, { code: 'STALE_VERIFY' });
      }
      evKind = 'ready';
      evData = { ...evData, commit: marker.commit ?? null, tests: marker.tests?.tail ?? '' };
    }
    if (old === 'READY_FOR_REVIEW' && to === 'IN_PROGRESS') clearVerifyMarker(root, pid);
    return appendEvent(root, { packet: pid, kind: evKind, to, by, note, data: evData, env, ...(opId ? { op_id: opId } : {}) });
  });
}

// ------------------------------------------------------------------ lifecycle commands

function leaseUntil(config) {
  return stamp(addHours(utcnow(), config.lease?.hours ?? 8));
}

function requireWorker(config, agent) {
  requireActor(config, agent, 'agent');
  if (!RESERVED_AGENTS.includes(agent) && !hasRole(config, agent, 'worker')) throw new BatonError(`${agent} has no worker role`, { code: 'NOT_WORKER' });
}

/**
 * Start (or restart) work: lease + snapshot + claim message. IN_PROGRESS is reachable only through here.
 * @returns {{event: object, pulledEarly: boolean, rework: boolean, owns: string[], leaseUntil: string, base: string|null}}
 */
export function begin(root, pid, agent, { pull = false, expectedRev = null, opId = null, env = process.env } = {}) {
  return withLock(stateDir(root), () => {
    const { config, plan, state } = load(root);
    const p = getPacket(plan, pid);
    checkIdentity(agent, env, config);
    requireWorker(config, agent);
    if (opId) {
      const existing = findOperationEvents(readEvents(root), opId);
      const begEv = existing.find((e) => e.packet === pid && e.kind === 'begin' && e.by === agent);
      if (begEv) {
        clearVerifyMarker(root, pid);
        saveSnapshot(root, pid, agent);
        const hasMsg = existing.some((e) => e.kind === 'message' && e.data?.type === 'CLAIM');
        if (!hasMsg) {
          appendEvent(root, {
            packet: pid, kind: 'message', by: agent, op_id: opId,
            data: { type: 'CLAIM', to: 'all', text: `${pid} ${p.title}. Owns: ${p.owns.join(', ')}. Lease until ${begEv.data.lease_until}` },
          });
        }
        return {
          event: begEv,
          pulledEarly: begEv.note === 'pulled early',
          rework: begEv.note === 'rework',
          owns: p.owns,
          leaseUntil: begEv.data.lease_until,
          leaseToken: begEv.data.lease_token || 1,
          base: begEv.data.base,
          idempotent: true,
        };
      }
    }
    const s = state.packets[pid];
    const stream = `packet:${pid}`;
    const streamEvents = readEvents(root).filter((item) => (item.packet ? `packet:${item.packet}` : '') === stream);
    const currentRev = streamEvents.length ? Math.max(...streamEvents.map((item) => item.rev || 0)) : 0;
    if (expectedRev != null && currentRev !== expectedRev) {
      throw new BatonError(`claim CAS conflict for ${pid}: expected revision ${expectedRev} but current revision is ${currentRev}`, {
        code: 'STALE_REVISION', hint: 're-read the current ledger before claiming',
      });
    }
    const pulled = !!s.agent && s.agent !== agent;
    if (pulled && !pull && !s.contributors.includes(agent)) {
      throw new BatonError(`${pid} belongs to ${s.agent}; pass --pull to take it (announce it on the bus)`, { code: 'NOT_YOURS' });
    }
    if (agent === s.reviewer) throw new BatonError(`${agent} is the reviewer of ${pid} and cannot work on it`, { code: 'REVIEWER_CONFLICT' });
    if (s.status === 'IN_PROGRESS') throw new BatonError(`${pid} is already in progress (by ${s.by}); use "baton reclaim" if its lease is stale`, { code: 'ALREADY_STARTED' });
    if (s.status === 'ACCEPTED') throw new BatonError(`${pid} is already accepted`, { code: 'ALREADY_DONE' });
    const rework = REWORK.has(s.status);
    if (rework && s.contributors.length && !s.contributors.includes(agent)) {
      throw new BatonError(`${pid} is under review; only its contributors (${s.contributors.join(', ')}) may rework it`, { code: 'NOT_CONTRIBUTOR' });
    }
    const lease = leaseUntil(config);
    const nextToken = (s.leaseToken || 0) + 1;
    const depCommits = {};
    for (const d of p.deps) if (state.packets[d]) depCommits[d] = state.packets[d].commit || 'unbuilt';
    const base = rework && s.base ? s.base : headCommit(root);
    const event = transition(root, pid, 'IN_PROGRESS', {
      by: agent, kind: 'begin', opId, env, note: pulled ? 'pulled early' : rework ? 'rework' : '',
      data: { base, lease_until: lease, lease_token: nextToken, dep_commits: depCommits, ...(expectedRev != null ? { expected_rev: expectedRev } : {}) },
    });
    clearVerifyMarker(root, pid);
    saveSnapshot(root, pid, agent);
    appendEvent(root, {
      packet: pid, kind: 'message', by: agent, op_id: opId,
      data: { type: 'CLAIM', to: 'all', text: `${pid} ${p.title}. Owns: ${p.owns.join(', ')}. Lease until ${lease}${pulled ? ' (pulled early)' : ''}${rework ? ' (rework)' : ''}` },
    });
    return { event, pulledEarly: pulled, rework, owns: p.owns, leaseUntil: lease, leaseToken: nextToken, base };
  });
}

/** Extend the lease of your own IN_PROGRESS packet. Returns the new lease timestamp. */
export function heartbeat(root, pid, agent) {
  return withLock(stateDir(root), () => {
    const { config, plan, state } = load(root);
    getPacket(plan, pid);
    checkIdentity(agent);
    requireActor(config, agent, 'agent');
    const s = state.packets[pid];
    if (s.status !== 'IN_PROGRESS') throw new BatonError(`${pid} is not IN_PROGRESS`, { code: 'NOT_IN_PROGRESS' });
    if (s.by && s.by !== agent && !flags(pid, plan, state, { config }).includes('STALE')) throw new BatonError(`${pid} is held by ${s.by}`, { code: 'HELD' });
    if (s.by && s.by !== agent) {
      // extending someone else's stale lease is a takeover: reclaim is the way, and never for the reviewer
      throw new BatonError(`${pid} is held by ${s.by}; its lease is stale`, { code: 'HELD', hint: `run "baton reclaim ${pid} --agent ${agent}" to take it over` });
    }
    if (agent === s.reviewer) throw new BatonError(`${agent} is the reviewer of ${pid} and cannot work on it`, { code: 'REVIEWER_CONFLICT' });
    const lease = leaseUntil(config);
    const leaseToken = s.leaseToken || 1;
    appendEvent(root, { packet: pid, kind: 'heartbeat', by: agent, data: { lease_until: lease, lease_token: leaseToken } });
    return lease;
  });
}

/** Take over an IN_PROGRESS packet whose lease expired or process confirmed crashed. */
export function reclaim(root, pid, agent, { opId = null, reassign = null, crashedPid = null, force = false, preserve = true, worktreeDir = null, env = process.env } = {}) {
  return withLock(stateDir(root), () => {
    const { config, plan, state } = load(root);
    const p = getPacket(plan, pid);
    checkIdentity(agent, env, config);
    const newAgent = reassign || agent;
    if (reassign) {
      requireActor(config, agent, 'agent');
      requireWorker(config, reassign);
    } else {
      requireWorker(config, agent);
    }
    if (opId) {
      const existing = findOperationEvents(readEvents(root), opId);
      const begEv = existing.find((e) => e.packet === pid && e.kind === 'begin' && e.by === newAgent);
      if (begEv) {
        const hasMsg = existing.some((e) => e.kind === 'message' && e.data?.type === 'NOTICE');
        if (!hasMsg) {
          appendEvent(root, {
            packet: pid, kind: 'message', by: newAgent, op_id: opId,
            data: { type: 'NOTICE', to: 'all', text: `${pid} reclaimed (lease token ${begEv.data?.lease_token || 1})` },
          });
        }
        return {
          event: begEv,
          leaseUntil: begEv.data.lease_until,
          leaseToken: begEv.data.lease_token || 1,
          recoveredFrom: begEv.data.recovered_from || null,
          rescueRef: begEv.data.rescue_ref || null,
          idempotent: true,
        };
      }
    }
    const s = state.packets[pid];
    if (!s || s.status !== 'IN_PROGRESS') {
      throw new BatonError(`${pid} is ${s?.status || 'unknown'}; only IN_PROGRESS packets can be reclaimed`, { code: 'NOT_IN_PROGRESS' });
    }
    let confirmedCrashed = false;
    if (crashedPid != null) {
      if (isProcessAlive(crashedPid)) {
        throw new BatonError(`process ${crashedPid} is still alive; cannot reclaim ${pid} as crashed`, {
          code: 'PROCESS_ALIVE', hint: 'wait for the process to exit or lease to expire',
        });
      }
      confirmedCrashed = true;
    }
    const f = flags(pid, plan, state, { config });
    if (!f.includes('STALE') && !f.includes('NO_LEASE') && !confirmedCrashed && !force) {
      throw new BatonError(`${pid} is not stale (lease until ${s.leaseUntil})`, {
        code: 'NOT_STALE',
        hint: `wait for the lease to expire, verify crashed PID with --crashed-pid, or ask ${s.by} to hand it off`,
      });
    }
    if (newAgent === s.reviewer) {
      throw new BatonError(`${newAgent} is the reviewer of ${pid} and cannot work on it`, { code: 'REVIEWER_CONFLICT' });
    }

    // Preserve dirty changes and uncommitted work
    let rescueData = { preserved: false, ref: null, sha: null };
    if (preserve) {
      let targetDir = worktreeDir;
      if (!targetDir && p.track) {
        const wts = listWorktrees(root);
        const prefix = config.branches?.trackPrefix || 'track/';
        const trackBranch = plan.tracks?.find((t) => t.id === p.track)?.branch || `${prefix}${p.track}`;
        const match = wts.find((w) => w.branch === trackBranch);
        if (match && fs.existsSync(match.path)) targetDir = match.path;
      }
      targetDir = targetDir || root;
      try {
        rescueData = preserveGitWork(targetDir, `${pid}-${s.by}-${Date.now()}`);
      } catch {
        // non-fatal if git preservation fails
      }
    }

    const lease = leaseUntil(config);
    const oldToken = s.leaseToken || 1;
    const nextToken = oldToken + 1;

    // Invalidate stale verify marker so old tests cannot authorize submit
    clearVerifyMarker(root, pid);
    saveSnapshot(root, pid, newAgent);

    const event = appendEvent(root, {
      packet: pid, kind: 'begin', to: 'IN_PROGRESS', by: newAgent, op_id: opId,
      note: reassign ? `reclaimed from ${s.by} and reassigned to ${newAgent}` : `reclaimed from ${s.by}`,
      data: {
        base: s.base,
        lease_until: lease,
        lease_token: nextToken,
        dep_commits: s.depCommits,
        recovered_from: s.by,
        recovery_mode: reassign ? 'reassign' : 'resume',
        ...(confirmedCrashed ? { crashed_pid: crashedPid } : {}),
        ...(rescueData.ref ? { rescue_ref: rescueData.ref, rescue_sha: rescueData.sha } : {}),
      },
    });

    const rescueMsg = rescueData.ref ? `; work preserved at ${rescueData.ref}` : '';
    appendEvent(root, {
      packet: pid, kind: 'message', by: newAgent, op_id: opId,
      data: {
        type: 'NOTICE', to: 'all',
        text: `${pid} reclaimed from ${s.by} by ${newAgent} (revoking lease token ${oldToken}; new token ${nextToken})${rescueMsg}. Fresh verification required before submit.`,
      },
    });

    return {
      event,
      leaseUntil: lease,
      leaseToken: nextToken,
      recoveredFrom: s.by,
      rescueRef: rescueData.ref || null,
    };
  });
}

/** IN_PROGRESS/PLANNED/CARRIED_OVER -> BLOCKED with a reason; posts a BLOCKER message (with `question` when given). */
export function block(root, pid, { by, reason, question = '', opId = null }) {
  if (!String(reason || '').trim()) throw new BatonError('a block needs a --reason', { code: 'NEEDS_REASON' });
  return withLock(stateDir(root), () => {
    const { config, state } = load(root);
    requireActor(config, by, 'agent');
    if (opId) {
      const existing = findOperationEvents(readEvents(root), opId);
      const blkEv = existing.find((e) => e.packet === pid && e.kind === 'status' && e.to === 'BLOCKED');
      if (blkEv) {
        const hasMsg = existing.some((e) => e.kind === 'message' && e.data?.type === 'BLOCKER');
        if (!hasMsg) {
          appendEvent(root, {
            packet: pid, kind: 'message', by, op_id: opId,
            data: { type: 'BLOCKER', to: 'all', text: `${pid} blocked: ${reason}${question ? ` Question: ${question}` : ''}` },
          });
        }
        return blkEv;
      }
    }
    const s = state.packets[pid];
    if (s && s.status === 'IN_PROGRESS' && s.by && s.by !== by && by !== config.orchestrator && by !== 'human') {
      throw new BatonError(`${pid} is held by ${s.by}`, { code: 'HELD' });
    }
    const event = transition(root, pid, 'BLOCKED', { by, note: reason, opId, data: { reason, question } });
    appendEvent(root, {
      packet: pid, kind: 'message', by, op_id: opId,
      data: { type: 'BLOCKER', to: 'all', text: `${pid} blocked: ${reason}${question ? ` Question: ${question}` : ''}` },
    });
    return event;
  });
}

/** IN_PROGRESS -> READY_FOR_REVIEW (needs a current passing verify marker). Posts a SIGNOFF message. */
export function submit(root, pid, { by, note = '', opId = null }) {
  return withLock(stateDir(root), () => {
    const { config, state } = load(root);
    requireActor(config, by, 'agent');
    const s = state.packets[pid];
    if (s && s.status === 'IN_PROGRESS' && s.by !== by && !RESERVED_AGENTS.includes(by)) {
      const lost = s.claimConflicts?.some((c) => c.claimant === by);
      throw new BatonError(lost ? `${pid} claim was won by ${s.by}; ${by} cannot submit it` : `${pid} is held by ${s.by}; ${by} cannot submit it`, { code: 'HELD' });
    }
    if (opId) {
      const existing = findOperationEvents(readEvents(root), opId);
      const readyEv = existing.find((e) => e.packet === pid && e.kind === 'ready' && e.to === 'READY_FOR_REVIEW');
      if (readyEv) {
        const hasMsg = existing.some((e) => e.kind === 'message' && e.data?.type === 'SIGNOFF');
        if (!hasMsg) {
          const tail = String(readyEv.data?.tests || '').split(/\r?\n/).filter(Boolean).pop() || 'n/a';
          appendEvent(root, {
            packet: pid, kind: 'message', by, op_id: opId,
            data: { type: 'SIGNOFF', to: state.packets[pid]?.reviewer || 'all', text: `${pid} READY_FOR_REVIEW commit=${readyEv.data?.commit || 'n/a'} tests: ${tail}` },
          });
        }
        return readyEv;
      }
    }
    const event = transition(root, pid, 'READY_FOR_REVIEW', { by, note, opId });
    const tail = String(event.data.tests || '').split(/\r?\n/).filter(Boolean).pop() || 'n/a';
    appendEvent(root, {
      packet: pid, kind: 'message', by, op_id: opId,
      data: { type: 'SIGNOFF', to: state.packets[pid].reviewer || 'all', text: `${pid} READY_FOR_REVIEW commit=${event.data.commit || 'n/a'} tests: ${tail}` },
    });
    return event;
  });
}

/**
 * Check whether an agent's claim on a packet is authoritatively confirmed or conflicted.
 * @returns {{confirmed: boolean, owner: string|null, conflict: boolean, competitors: string[], reason?: string}}
 */
export function confirmClaim(root, pid, agent) {
  const { plan, state } = load(root);
  getPacket(plan, pid);
  const s = state.packets[pid];
  const competitors = s.claimConflicts ? [...new Set(s.claimConflicts.map((c) => c.claimant))] : [];
  if (s.status !== 'IN_PROGRESS') {
    return { confirmed: false, owner: s.by, conflict: false, competitors, reason: `${pid} is not IN_PROGRESS (${s.status})` };
  }
  if (s.by === agent) {
    return { confirmed: true, owner: agent, conflict: competitors.length > 0, competitors };
  }
  return {
    confirmed: false,
    owner: s.by,
    conflict: true,
    competitors,
    reason: `claim lost to ${s.by}`,
  };
}

/**
 * Record a review verdict: outcome ACCEPTED | ACCEPTED_WITH_FIXES | REJECTED. Also accepts ACCEPTED_WITH_FIXES -> ACCEPTED.
 * `score` is optional, 0..10.
 */
export function verdict(root, pid, outcome, { by, note = '', score = null, opId = null, env = process.env } = {}) {
  if (!REVIEW_OUTCOMES.has(outcome)) throw new BatonError(`outcome must be one of ${[...REVIEW_OUTCOMES].join('|')}`, { code: 'BAD_STATUS' });
  if (score != null && !(Number.isFinite(score) && score >= 0 && score <= 10)) throw new BatonError('score must be a number from 0 to 10', { code: 'BAD_SCORE' });
  return withLock(stateDir(root), () => {
    const { plan } = load(root);
    const p = getPacket(plan, pid);
    if (opId) {
      const existing = findOperationEvents(readEvents(root), opId);
      const verdEv = existing.find((e) => e.packet === pid && e.kind === 'verdict');
      if (verdEv) {
        if (verdEv.to !== outcome) {
          throw new BatonError(`operation ${opId} was already executed with outcome ${verdEv.to}; cannot change to ${outcome}`, { code: 'OP_CONFLICT' });
        }
        const hasMsg = existing.some((e) => e.kind === 'message' && e.data?.type === 'VERDICT');
        if (!hasMsg) {
          appendEvent(root, {
            packet: pid, kind: 'message', by, op_id: opId, env,
            data: { type: 'VERDICT', to: p.agent || 'all', text: `${pid} ${outcome}.${note ? ` ${note}` : ''}` },
          });
        }
        return verdEv;
      }
    }
    const event = transition(root, pid, outcome, { by, note, opId, env, data: score == null ? {} : { score } });
    appendEvent(root, {
      packet: pid, kind: 'message', by, op_id: opId, env,
      data: { type: 'VERDICT', to: p.agent || 'all', text: `${pid} ${outcome}.${note ? ` ${note}` : ''}` },
    });
    return event;
  });
}

/** REJECTED -> CARRIED_OVER (orchestrator or human only). */
export function carry(root, pid, { by, note = '' }) {
  return withLock(stateDir(root), () => {
    requireOrchestrator(loadConfig(root), by);
    return transition(root, pid, 'CARRIED_OVER', { by, note });
  });
}

/** Change the reviewer of an undecided packet (orchestrator or human only; the new reviewer must not have worked on it). */
export function reassignReviewer(root, pid, reviewer, { by, opId = null }) {
  return withLock(stateDir(root), () => {
    const { config, plan, state } = load(root);
    getPacket(plan, pid);
    checkIdentity(by);
    requireOrchestrator(config, by);
    const s = state.packets[pid];
    if (s.status === 'ACCEPTED') throw new BatonError(`${pid} is already decided`, { code: 'ALREADY_DONE' });
    if (opId) {
      const existing = findOperationEvents(readEvents(root), opId);
      const revEv = existing.find((e) => e.packet === pid && e.kind === 'reviewer');
      if (revEv) {
        const hasMsg = existing.some((e) => e.kind === 'message' && e.data?.text?.includes('reviewer reassigned'));
        if (!hasMsg) {
          appendEvent(root, {
            packet: pid, kind: 'message', by, op_id: opId,
            data: { type: 'NOTICE', to: 'all', text: `${pid} reviewer reassigned to ${reviewer}` },
          });
        }
        return revEv;
      }
    }
    requireActor(config, reviewer, 'reviewer');
    if (!hasRole(config, reviewer, 'reviewer')) throw new BatonError(`${reviewer} has no reviewer role`, { code: 'NOT_REVIEWER' });
    if (reviewer === s.agent || s.contributors.includes(reviewer)) throw new BatonError(`${reviewer} worked on ${pid} and cannot review it`, { code: 'REVIEWER_CONFLICT' });
    const event = appendEvent(root, { packet: pid, kind: 'reviewer', by, op_id: opId, note: `reviewer -> ${reviewer}`, data: { reviewer } });
    appendEvent(root, {
      packet: pid, kind: 'message', by, op_id: opId,
      data: { type: 'NOTICE', to: 'all', text: `${pid} reviewer reassigned to ${reviewer}` },
    });
    return event;
  });
}

/**
 * Hand a packet to another author. Allowed for PLANNED/CARRIED_OVER/REJECTED/BLOCKED/IN_PROGRESS packets, by the current
 * author/holder, the orchestrator or human. An IN_PROGRESS packet is released (-> BLOCKED); the new author must `begin` it.
 */
export function handoff(root, pid, { to, by, note = '', opId = null }) {
  return withLock(stateDir(root), () => {
    const { config, plan, state } = load(root);
    getPacket(plan, pid);
    checkIdentity(by);
    requireActor(config, by, 'agent');
    requireWorker(config, to);
    const s = state.packets[pid];
    if (REWORK.has(s.status) || s.status === 'ACCEPTED') throw new BatonError(`${pid} is ${s.status}; it cannot be handed off`, { code: 'BAD_TRANSITION' });
    if (![s.agent, s.by].includes(by) && by !== config.orchestrator && by !== 'human') throw new BatonError(`only the author, holder or orchestrator may hand off ${pid}`, { code: 'NOT_YOURS' });
    if (to === s.reviewer) throw new BatonError(`${to} is the reviewer of ${pid}; reassign the reviewer first`, { code: 'REVIEWER_CONFLICT' });
    if (opId) {
      const existing = findOperationEvents(readEvents(root), opId);
      const hndEv = existing.find((e) => e.packet === pid && e.kind === 'handoff');
      if (hndEv) {
        const hasMsg = existing.some((e) => e.kind === 'message' && e.data?.type === 'HANDOFF');
        if (!hasMsg) {
          appendEvent(root, {
            packet: pid, kind: 'message', by, op_id: opId,
            data: { type: 'HANDOFF', to, text: `${pid} handed to ${to}.${note ? ` ${note}` : ''}` },
          });
        }
        return hndEv;
      }
    }
    if (s.status === 'IN_PROGRESS') {
      clearVerifyMarker(root, pid);
    }
    const event = appendEvent(root, {
      packet: pid, kind: 'handoff', to: s.status === 'IN_PROGRESS' ? 'BLOCKED' : null, by, note, op_id: opId,
      data: { agent: to, from: s.agent, reason: 'handoff' },
    });
    appendEvent(root, {
      packet: pid, kind: 'message', by, op_id: opId,
      data: { type: 'HANDOFF', to, text: `${pid} handed to ${to}.${note ? ` ${note}` : ''}` },
    });
    return event;
  });
}

/** Open or close a human gate. Allowed for the gate owner or "human". */
export function setGate(root, gateId, open, { by, note = '', opId = null }) {
  return withLock(stateDir(root), () => {
    const { config, plan } = load(root);
    const g = plan.gates.find((x) => x.id === gateId);
    if (!g) throw new BatonError(`unknown gate ${gateId}`, { code: 'UNKNOWN_GATE', hint: 'run "baton gate list" to see the gates' });
    requireActor(config, by, 'actor');
    if (by !== 'human' && by !== g.owner) throw new BatonError(`gate ${gateId} belongs to ${g.owner}; ${by} cannot ${open ? 'open' : 'close'} it`, { code: 'NOT_GATE_OWNER' });
    if (opId) {
      const existing = findOperationEvents(readEvents(root), opId);
      const gateEv = existing.find((e) => e.kind === 'gate' && e.data?.gate === gateId);
      if (gateEv) {
        const hasMsg = existing.some((e) => e.kind === 'message' && e.data?.text?.includes(`gate ${gateId}`));
        if (!hasMsg) {
          appendEvent(root, {
            packet: null, kind: 'message', by, op_id: opId,
            data: { type: 'NOTICE', to: 'all', text: `gate ${gateId} ${open ? 'opened' : 'closed'} by ${by}` },
          });
        }
        return gateEv;
      }
    }
    const event = appendEvent(root, { packet: null, kind: 'gate', by, note, op_id: opId, data: { gate: gateId, open: !!open } });
    appendEvent(root, {
      kind: 'message', by, op_id: opId,
      data: { type: 'NOTICE', to: 'all', text: `gate ${gateId} ${open ? 'opened' : 'closed'} by ${by}` },
    });
    return event;
  });
}

/** Record that a known ledger anomaly was reviewed (it stays visible as an acknowledged warning). */
export function acknowledge(root, eventId, { by, reason }) {
  if (!String(reason || '').trim()) throw new BatonError('a reason is required', { code: 'NEEDS_REASON' });
  if (!readEvents(root).some((e) => e.id === eventId)) {
    // the anomaly may be an unreadable file, so only warn-free ids that exist as files are acceptable too
    const known = fs.existsSync(path.join(stateDir(root), 'events', `${eventId}.json`));
    if (!known) throw new BatonError(`no event ${eventId}`, { code: 'UNKNOWN_EVENT' });
  }
  checkIdentity(by);
  return appendEvent(root, { kind: 'ack', by, note: reason, data: { event: eventId } });
}

// ------------------------------------------------------------------ findings

/**
 * Fold finding / finding_resolved events into findings:
 * {fid, packet, severity, file, line, evidence, fix, against, by, text, ts, status: 'open'|'resolved'|'closed',
 *  resolution, resolvedBy, closedBy}. `closed` = confirmed by the filer, or "invalid" resolved by the filer.
 */
export function findingsOf(events, pid = null) {
  const map = new Map();
  for (const ev of events) {
    const d = ev.data || {};
    if (ev.kind === 'finding') {
      map.set(d.fid, {
        fid: d.fid, packet: ev.packet, severity: d.severity, file: d.file || '', line: d.line || 0, evidence: d.evidence || '',
        fix: d.fix || '', against: d.against || null, by: ev.by, text: ev.note || '', ts: ev.ts,
        status: 'open', resolution: null, resolvedBy: null, closedBy: null,
      });
    } else if (ev.kind === 'finding_resolved') {
      const f = map.get(d.fid);
      if (!f) continue;
      if (d.confirm) { if (ev.by === f.by) { f.status = 'closed'; f.closedBy = ev.by; } }
      else if (ev.by === f.by && d.resolution === 'invalid') Object.assign(f, { status: 'closed', resolution: 'invalid', resolvedBy: ev.by, closedBy: ev.by });
      else Object.assign(f, { status: 'resolved', resolution: d.resolution, resolvedBy: ev.by });
    }
  }
  const all = [...map.values()].sort((a, b) => a.fid.localeCompare(b.fid));
  return pid ? all.filter((f) => f.packet === pid) : all;
}

export function nextFindingId(events) {
  let max = 0;
  for (const ev of events) if (ev.kind === 'finding') max = Math.max(max, Number(/(\d+)$/.exec(ev.data?.fid || '')?.[1] || 0));
  return `AUD-${String(max + 1).padStart(3, '0')}`;
}

/** File a finding (auditors and reviewers file; they never edit the audited files). Returns {fid, event}. */
export function addFinding(root, { packet, by, severity, text, file = '', line = 0, evidence = '', fix = '', against = null }) {
  if (!SEVERITIES.includes(severity)) throw new BatonError(`severity must be one of ${SEVERITIES.join('|')}`, { code: 'BAD_SEVERITY' });
  if (!String(text || '').trim()) throw new BatonError('a finding needs text', { code: 'NEEDS_REASON' });
  return withLock(stateDir(root), () => {
    const { config, plan, state, events } = load(root);
    getPacket(plan, packet);
    checkIdentity(by);
    requireActor(config, by, 'filer');
    if (by !== 'human' && !hasRole(config, by, 'auditor') && !hasRole(config, by, 'reviewer')) throw new BatonError(`${by} has neither the auditor nor the reviewer role`, { code: 'NOT_AUDITOR' });
    const s = state.packets[packet];
    if (by === s.agent || s.contributors.includes(by)) throw new BatonError(`${by} worked on ${packet} and cannot file findings against it`, { code: 'REVIEWER_CONFLICT' });
    const fid = nextFindingId(events);
    const event = appendEvent(root, {
      packet, kind: 'finding', by, note: text,
      data: { fid, severity, file, line, evidence, fix, against: against || s.by || s.agent },
    });
    return { fid, event };
  });
}

/**
 * Resolve a finding. Without `confirm`: the fixer (anyone but nobody in particular) records resolution fixed|wontfix|invalid;
 * the filer's own "invalid" closes it. With `confirm: true`: only the filer, only after it was resolved, closes it.
 */
export function resolveFinding(root, fid, { by, resolution, confirm = false, note = '' }) {
  return withLock(stateDir(root), () => {
    const { config, events } = load(root);
    checkIdentity(by);
    requireActor(config, by, 'actor');
    const f = findingsOf(events).find((x) => x.fid === fid);
    if (!f) throw new BatonError(`unknown finding ${fid}`, { code: 'UNKNOWN_FINDING' });
    if (f.status === 'closed') throw new BatonError(`${fid} is already closed`, { code: 'ALREADY_DONE' });
    if (confirm) {
      if (by !== f.by) throw new BatonError(`only the filer (${f.by}) can confirm ${fid}`, { code: 'NOT_FILER' });
      if (f.status !== 'resolved') throw new BatonError(`${fid} has not been resolved yet`, { code: 'NOT_RESOLVED' });
      return appendEvent(root, { packet: f.packet, kind: 'finding_resolved', by, note, data: { fid, resolution: f.resolution, confirm: true } });
    }
    if (!RESOLUTIONS.includes(resolution)) throw new BatonError(`resolution must be one of ${RESOLUTIONS.join('|')}`, { code: 'BAD_RESOLUTION' });
    return appendEvent(root, { packet: f.packet, kind: 'finding_resolved', by, note, data: { fid, resolution, confirm: false } });
  });
}

// ------------------------------------------------------------------ audit (ledger semantics)

/**
 * Replay the ledger and report rule violations: illegal transitions, IN_PROGRESS without begin, ready at an unverified
 * commit, verdicts by non-reviewers/contributors, unknown packets. Problems carry `acked` when an `ack` event names them.
 * @returns {{id: string, severity: 'error', problem: string, acked: boolean}[]}
 */
export function auditEvents(plan, events, config = {}) {
  const problems = [];
  const state = initialState(plan);
  const verified = {};
  const acked = new Set(events.filter((e) => e.kind === 'ack').map((e) => e.data?.event));
  const bad = (ev, problem) => problems.push({ id: ev.id, severity: 'error', problem, acked: acked.has(ev.id) });
  for (const ev of events) {
    if (ev.kind === 'gate' || !ev.packet) { applyEvent(state, ev); continue; }
    const s = state.packets[ev.packet];
    if (!s) { bad(ev, `event for unknown packet ${ev.packet}`); continue; }
    if (ev.to && ev.to !== s.status) {
      if (!TRANSITIONS[s.status].has(ev.to)) bad(ev, `illegal transition ${ev.packet} ${s.status} -> ${ev.to}`);
      else if (ev.to === 'IN_PROGRESS' && ev.kind !== 'begin') bad(ev, `${ev.packet} entered IN_PROGRESS without "begin"`);
    }
    if (ev.kind === 'begin' && s.status === 'IN_PROGRESS' && s.by && s.by !== ev.by) {
      const isReclaim = ev.note?.startsWith('reclaimed')
        || (parseTime(s.leaseUntil) && parseTime(ev.ts) && parseTime(ev.ts) > parseTime(s.leaseUntil));
      if (!isReclaim) bad(ev, `conflicting claim on ${ev.packet} by ${ev.by}; already held by ${s.by}`);
    }
    if (ev.kind === 'verify' && ev.data?.ok) verified[ev.packet] = ev.data.commit ?? null;
    if (ev.kind === 'ready' && (ev.data?.commit ?? null) !== (verified[ev.packet] ?? null)) bad(ev, `${ev.packet} became ready at a commit that was not verified`);
    if (ev.kind === 'verdict') {
      if (ev.by !== s.reviewer && ev.by !== 'human') bad(ev, `verdict on ${ev.packet} by ${ev.by}; the reviewer is ${s.reviewer}`);
      if (config.requireDifferentReviewer !== false && ev.by !== 'human' && s.contributors.includes(ev.by)) bad(ev, `verdict on ${ev.packet} by a contributor (${ev.by})`);
      if (ev.prov?.gh?.actor) {
        const revAgent = getAgent(config, s.reviewer);
        if (revAgent?.github && ev.prov.gh.actor.toLowerCase() !== revAgent.github.toLowerCase()) {
          bad(ev, `verdict on ${ev.packet} has identity mismatch: GitHub actor "${ev.prov.gh.actor}" does not match reviewer "${s.reviewer}" (${revAgent.github})`);
        }
      }
    }
    applyEvent(state, ev);
  }
  return problems;
}

// ------------------------------------------------------------------ scoring and progress

function blankScore() {
  return {
    started: 0, ready: 0, accepted: 0, acceptedWithFixes: 0, rejected: 0, rework: 0, reopensAfterFixes: 0,
    reviewsGiven: 0, meanScoreGiven: null, findingsFiled: 0, findingsConfirmed: 0, findingsInvalid: 0,
    findingsAgainstOpen: 0, findingsAgainstClosed: 0, firstPassRate: null,
  };
}

/**
 * Per-agent scoreboard, a pure function of the ledger. Returns {agents: {id: Score}}.
 * Score: started (distinct packets begun), ready, accepted/acceptedWithFixes/rejected (credited to the packet holder at verdict time),
 * rework (rework begins), reopensAfterFixes (rework from ACCEPTED_WITH_FIXES), reviewsGiven, meanScoreGiven (null if none),
 * findingsFiled/Confirmed/Invalid, findingsAgainstOpen/Closed, firstPassRate (first verdict was ACCEPTED / packets with a verdict; null if none).
 */
export function scores(plan, events) {
  const state = initialState(plan);
  const agents = {};
  const A = (id) => { if (!id) return blankScore(); return (agents[id] ??= { ...blankScore(), _started: new Set(), _sum: 0, _n: 0, _first: new Map() }); };
  for (const a of plan.packets) { if (a.agent) A(a.agent); if (a.reviewer) A(a.reviewer); }
  for (const ev of events) {
    const s = state.packets[ev.packet];
    if (s && ev.kind === 'begin' && ev.by) {
      const a = A(ev.by);
      a._started.add(ev.packet);
      if (REWORK.has(s.status)) { a.rework++; if (s.status === 'ACCEPTED_WITH_FIXES') a.reopensAfterFixes++; }
    } else if (s && ev.kind === 'ready' && ev.by) {
      A(ev.by).ready++;
    } else if (s && ev.kind === 'verdict') {
      const reviewer = A(ev.by);
      reviewer.reviewsGiven++;
      if (typeof ev.data?.score === 'number') { reviewer._sum += ev.data.score; reviewer._n++; }
      const holder = A(s.by || s.agent);
      if (ev.to === 'ACCEPTED') holder.accepted++;
      else if (ev.to === 'ACCEPTED_WITH_FIXES') holder.acceptedWithFixes++;
      else if (ev.to === 'REJECTED') holder.rejected++;
      if (holder._first && !holder._first.has(ev.packet)) holder._first.set(ev.packet, ev.to === 'ACCEPTED');
    }
    applyEvent(state, ev);
  }
  for (const f of findingsOf(events)) {
    const filer = A(f.by);
    filer.findingsFiled++;
    if (f.status === 'closed') { if (f.resolution === 'invalid') filer.findingsInvalid++; else filer.findingsConfirmed++; }
    if (f.against) { const t = A(f.against); if (f.status === 'closed') t.findingsAgainstClosed++; else t.findingsAgainstOpen++; }
  }
  const out = {};
  for (const [id, a] of Object.entries(agents)) {
    const { _started, _sum, _n, _first, ...rest } = a;
    out[id] = {
      ...rest, started: _started.size, meanScoreGiven: _n ? Math.round((_sum / _n) * 100) / 100 : null,
      firstPassRate: _first.size ? Math.round(([..._first.values()].filter(Boolean).length / _first.size) * 1000) / 1000 : null,
    };
  }
  return { agents: out };
}

/**
 * Milestone and overall progress. Stretch packets are excluded from totals. ACCEPTED counts as done; READY_FOR_REVIEW and
 * ACCEPTED_WITH_FIXES count as inReview.
 * @returns {{milestones: object[], overall: {done: number, total: number, percent: number}, closedGates: object[], now: string}}
 */
export function progress(plan, state, { now = utcnow() } = {}) {
  const counted = plan.packets.filter((p) => !p.stretch);
  const row = (id, title, due, list) => {
    const st = (p) => state.packets[p.id].status;
    const left = daysUntil(due, now);
    const done = list.filter((p) => st(p) === 'ACCEPTED').length;
    return {
      id, title, due: due ?? null, daysLeft: left, total: list.length, done,
      inReview: list.filter((p) => st(p) === 'READY_FOR_REVIEW' || st(p) === 'ACCEPTED_WITH_FIXES').length,
      inProgress: list.filter((p) => st(p) === 'IN_PROGRESS').length,
      blocked: list.filter((p) => st(p) === 'BLOCKED').length,
      notStarted: list.filter((p) => ['PLANNED', 'CARRIED_OVER', 'REJECTED'].includes(st(p))).length,
      gated: list.filter((p) => p.gate && !DONE.has(st(p)) && !state.gates[p.gate]?.open).map((p) => p.id),
      percent: list.length ? Math.round((done / list.length) * 100) : 0,
      overdue: left !== null && left < 0 && done < list.length,
    };
  };
  const milestones = plan.milestones.map((m) => row(m.id, m.title ?? '', m.due, counted.filter((p) => p.milestone === m.id)));
  const loose = counted.filter((p) => !p.milestone || !plan.milestones.some((m) => m.id === p.milestone));
  if (loose.length) milestones.push(row(null, 'Unscheduled', null, loose));
  const done = counted.filter((p) => state.packets[p.id].status === 'ACCEPTED').length;
  const closedGates = plan.gates.filter((g) => !state.gates[g.id]?.open)
    .map((g) => ({ id: g.id, title: g.title ?? '', owner: g.owner ?? 'human', neededBy: g.needed_by ?? null, daysUntilNeeded: daysUntil(g.needed_by, now) }));
  return { milestones, overall: { done, total: counted.length, percent: counted.length ? Math.round((done / counted.length) * 100) : 0 }, closedGates, now: stamp(now) };
}

/**
 * Detect and reconcile interrupted or incomplete multi-event transitions and verify markers.
 * @param {string} root
 * @returns {{reconciled: string[], clearedMarkers: string[], restoredMarkers: string[]}}
 */
export function reconcileOperations(root) {
  return withLock(stateDir(root), () => {
    const { plan, state } = load(root);
    const events = readEvents(root);
    const reconciled = [];
    const clearedMarkers = [];
    const restoredMarkers = [];

    // Group events by op_id
    const byOp = new Map();
    for (const ev of events) {
      if (ev.op_id) {
        if (!byOp.has(ev.op_id)) byOp.set(ev.op_id, []);
        byOp.get(ev.op_id).push(ev);
      }
    }

    for (const [opId, opEvents] of byOp) {
      // 1. ready -> SIGNOFF message
      const readyEv = opEvents.find((e) => e.kind === 'ready' && e.to === 'READY_FOR_REVIEW');
      if (readyEv && !opEvents.some((e) => e.kind === 'message' && e.data?.type === 'SIGNOFF')) {
        const pid = readyEv.packet;
        const tail = String(readyEv.data?.tests || '').split(/\r?\n/).filter(Boolean).pop() || 'n/a';
        appendEvent(root, {
          packet: pid, kind: 'message', by: readyEv.by, op_id: opId,
          data: { type: 'SIGNOFF', to: state.packets[pid]?.reviewer || 'all', text: `${pid} READY_FOR_REVIEW commit=${readyEv.data?.commit || 'n/a'} tests: ${tail}` },
        });
        reconciled.push(`reconciled SIGNOFF message for op ${opId} (${pid})`);
      }

      // 2. verdict -> VERDICT message
      const verdEv = opEvents.find((e) => e.kind === 'verdict');
      if (verdEv && !opEvents.some((e) => e.kind === 'message' && e.data?.type === 'VERDICT')) {
        const pid = verdEv.packet;
        const p = plan.packets.find((item) => item.id === pid);
        appendEvent(root, {
          packet: pid, kind: 'message', by: verdEv.by, op_id: opId,
          data: { type: 'VERDICT', to: p?.agent || 'all', text: `${pid} ${verdEv.to}.${verdEv.note ? ` ${verdEv.note}` : ''}` },
        });
        reconciled.push(`reconciled VERDICT message for op ${opId} (${pid})`);
      }

      // 3. begin -> CLAIM message
      const begEv = opEvents.find((e) => e.kind === 'begin' && e.to === 'IN_PROGRESS');
      if (begEv && !opEvents.some((e) => e.kind === 'message' && (e.data?.type === 'CLAIM' || e.data?.type === 'NOTICE'))) {
        const pid = begEv.packet;
        const p = plan.packets.find((item) => item.id === pid);
        if (p) {
          appendEvent(root, {
            packet: pid, kind: 'message', by: begEv.by, op_id: opId,
            data: { type: 'CLAIM', to: 'all', text: `${pid} ${p.title}. Owns: ${p.owns.join(', ')}. Lease until ${begEv.data?.lease_until || 'n/a'}` },
          });
          reconciled.push(`reconciled CLAIM message for op ${opId} (${pid})`);
        }
      }

      // 4. status (BLOCKED) -> BLOCKER message
      const blkEv = opEvents.find((e) => e.kind === 'status' && e.to === 'BLOCKED');
      if (blkEv && !opEvents.some((e) => e.kind === 'message' && e.data?.type === 'BLOCKER')) {
        const pid = blkEv.packet;
        appendEvent(root, {
          packet: pid, kind: 'message', by: blkEv.by, op_id: opId,
          data: { type: 'BLOCKER', to: 'all', text: `${pid} blocked: ${blkEv.note}` },
        });
        reconciled.push(`reconciled BLOCKER message for op ${opId} (${pid})`);
      }
    }

    // 5. Reconcile verify markers vs ledger events
    for (const p of plan.packets) {
      const markerPath = verifyMarkerPath(root, p.id);
      const hasMarker = fs.existsSync(markerPath);
      const verifyEvents = events.filter((e) => e.packet === p.id && e.kind === 'verify');
      const latestVerify = verifyEvents[verifyEvents.length - 1];

      if (hasMarker && (!latestVerify || !latestVerify.data?.ok)) {
        try { fs.unlinkSync(markerPath); } catch {}
        clearedMarkers.push(p.id);
      } else if (!hasMarker && latestVerify && latestVerify.data?.ok && state.packets[p.id]?.leaseToken === latestVerify.data?.lease_token) {
        writeJsonAtomic(markerPath, {
          packet: p.id,
          ok: true,
          mode: latestVerify.data.mode,
          commit: latestVerify.data.commit,
          lease_token: latestVerify.data.lease_token,
          fingerprint: null,
          fingerprint_kind: 'owned',
          problems: [],
          tests: { ran: true, ok: true, tail: '' },
        });
        restoredMarkers.push(p.id);
      }
    }

    return { reconciled, clearedMarkers, restoredMarkers };
  });
}

export { patternsOverlap, getAgent };
