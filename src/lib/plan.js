import fs from 'node:fs';
import { BatonError } from './errors.js';
import { readJson, writeJsonAtomic, canonicalJson, sha256, toPosix } from './util.js';
import { patternsOverlap, matchPath, isProtected } from './glob.js';
import { planPath } from './config.js';

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
export const GATE_MODES = ['start', 'live_only'];
export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** Windows device names: a file called NUL.json is the NUL device, so such ids silently lose their state files. */
const RESERVED_NAME_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Why `id` cannot be used as an id (ids become file names under .git/baton), or null when it is fine. */
export function idProblem(id) {
  const s = String(id);
  if (!ID_RE.test(s)) return 'must match ' + ID_RE;
  if (s.length > 100) return 'is longer than 100 characters';
  if (/[. ]$/.test(s)) return 'must not end with a dot';
  if (RESERVED_NAME_RE.test(s)) return 'is a reserved Windows device name';
  return null;
}

const PACKET_KEY_ORDER = ['id', 'title', 'track', 'agent', 'reviewer', 'owns', 'reads', 'deps', 'needs_done', 'gate', 'gate_mode',
  'priority', 'milestone', 'stretch', 'test', 'description', 'done_checks'];
const TRACK_KEY_ORDER = ['id', 'owner', 'theme', 'owns'];
const GATE_KEY_ORDER = ['id', 'title', 'owner', 'open', 'needed_by'];
const MILESTONE_KEY_ORDER = ['id', 'title', 'due'];

/** Fill every optional packet field with its default (does not mutate the input). */
export function normalizePacket(p) {
  return {
    ...p,
    title: p.title ?? '',
    track: p.track ?? null,
    agent: p.agent ?? null,
    reviewer: p.reviewer ?? null,
    owns: Array.isArray(p.owns) ? p.owns : [],
    reads: Array.isArray(p.reads) ? p.reads : [],
    deps: Array.isArray(p.deps) ? p.deps : [],
    needs_done: Array.isArray(p.needs_done) ? p.needs_done : [],
    gate: p.gate ?? null,
    gate_mode: p.gate_mode ?? 'start',
    priority: p.priority ?? 'P2',
    milestone: p.milestone ?? null,
    stretch: p.stretch === true,
    test: p.test ?? null,
    description: p.description ?? '',
    done_checks: Array.isArray(p.done_checks) ? p.done_checks : [],
  };
}

/** Fill defaults for the whole plan. */
export function normalizePlan(plan) {
  const src = plan && typeof plan === 'object' ? plan : {};
  return {
    ...src,
    version: src.version ?? 1,
    goal: src.goal ?? '',
    tracks: (src.tracks || []).map((t) => ({ ...t, owns: t.owns ?? [], theme: t.theme ?? '' })),
    gates: (src.gates || []).map((g) => ({ ...g, owner: g.owner ?? 'human', open: g.open === true })),
    milestones: src.milestones || [],
    packets: (src.packets || []).map(normalizePacket),
  };
}

function ordered(obj, order) {
  const out = {};
  for (const k of order) if (k in obj) out[k] = obj[k];
  for (const k of Object.keys(obj).sort()) if (!(k in out)) out[k] = obj[k];
  return out;
}

/** Stable key order for writing. */
export function orderPlan(plan) {
  const p = normalizePlan(plan);
  return {
    version: p.version,
    goal: p.goal,
    tracks: p.tracks.map((t) => ordered(t, TRACK_KEY_ORDER)),
    gates: p.gates.map((g) => ordered(g, GATE_KEY_ORDER)),
    milestones: p.milestones.map((m) => ordered(m, MILESTONE_KEY_ORDER)),
    packets: p.packets.map((x) => ordered(x, PACKET_KEY_ORDER)),
  };
}

/** Read .baton/plan.json (defaults filled in). Throws BatonError when missing or corrupt. */
export function loadPlan(root) {
  const file = planPath(root);
  if (!fs.existsSync(file)) {
    throw new BatonError(`${toPosix(file)} is missing`, { code: 'NO_PLAN', hint: 'run "baton init" or "baton plan import"' });
  }
  const raw = readJson(file);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BatonError('.baton/plan.json must be a JSON object', { code: 'BAD_PLAN' });
  const plan = normalizePlan(raw);
  // Packet ids name files in the state dir (snapshots, verify markers): refuse unsafe ones before anything uses them.
  for (const p of plan.packets) {
    const bad = typeof p?.id === 'string' ? idProblem(p.id) : 'must be a string';
    if (bad) throw new BatonError(`packet id invalid: ${JSON.stringify(p?.id)} ${bad}`, { code: 'BAD_PLAN', hint: 'fix the id in .baton/plan.json' });
  }
  return plan;
}

/** Write the plan with stable key order, 2-space indent and a trailing newline. */
export function savePlan(root, plan) {
  writeJsonAtomic(planPath(root), orderPlan(plan));
}

/** sha256 of the canonical plan (recorded in `plan` events). */
export function planHash(plan) {
  return sha256(canonicalJson(orderPlan(plan)));
}

export function packetMap(plan) {
  const m = {};
  for (const p of plan.packets) m[p.id] = p;
  return m;
}

/** Next id like `WP-004` (prefix default "WP", width 3): one above the highest numeric suffix in use. */
export function nextPacketId(plan, prefix = 'WP') {
  let max = 0;
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  for (const p of plan.packets) {
    const m = re.exec(p.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

function edges(p) { return [...(p.deps || []), ...(p.needs_done || [])]; }

/** First dependency cycle as an id path like ['A','B','A'], or null. */
export function findCycle(plan) {
  const map = packetMap(plan);
  const color = {};
  let found = null;
  const visit = (id, trail) => {
    if (found || !map[id]) return;
    if (color[id] === 2) return;
    if (color[id] === 1) { found = [...trail.slice(trail.indexOf(id)), id]; return; }
    color[id] = 1;
    for (const d of edges(map[id])) visit(d, [...trail, id]);
    color[id] = 2;
  };
  for (const p of plan.packets) visit(p.id, []);
  return found;
}

export function hasCycle(plan) {
  return findCycle(plan) !== null;
}

/** Ids in dependency order (dependencies first, file order otherwise). Throws BatonError on a cycle. */
export function topoOrder(plan) {
  const cyc = findCycle(plan);
  if (cyc) throw new BatonError(`dependency cycle: ${cyc.join(' -> ')}`, { code: 'CYCLE' });
  const map = packetMap(plan);
  const seen = new Set();
  const out = [];
  const visit = (id) => {
    if (seen.has(id) || !map[id]) return;
    seen.add(id);
    for (const d of edges(map[id])) visit(d);
    out.push(id);
  };
  for (const p of plan.packets) visit(p.id);
  return out;
}

/** Every packet id `id` depends on, directly or not (deps and needs_done). */
export function transitiveDeps(plan, id) {
  const map = packetMap(plan);
  const out = new Set();
  const stack = [...(map[id] ? edges(map[id]) : [])];
  while (stack.length) {
    const d = stack.pop();
    if (out.has(d) || !map[d]) continue;
    out.add(d);
    stack.push(...edges(map[d]));
  }
  return out;
}

/** Pairs [a, b] of owns patterns of the two packets that overlap. */
export function packetsOverlap(p, q) {
  const out = [];
  for (const a of p.owns) for (const b of q.owns) if (patternsOverlap(a, b)) out.push([a, b]);
  return out;
}

function badPath(own) {
  if (typeof own !== 'string' || !own.trim()) return 'must be a non-empty string';
  if (own.includes('\\')) return 'must use forward slashes';
  if (own.startsWith('/') || /^[A-Za-z]:/.test(own)) return 'must be repo-relative, not absolute';
  if (own.split('/').includes('..')) return 'must not contain ".."';
  return null;
}

function inside(own, trackOwns) {
  if (/[*?]/.test(own)) return trackOwns.some((t) => patternsOverlap(t, own));
  return trackOwns.some((t) => matchPath(t, own));
}

/**
 * Validate a plan against the roster. Never throws.
 * @param {any} plan
 * @param {any} config
 * @param {{done?: Set<string>|string[]}} [opts] ids of accepted packets (ignored for ownership overlap)
 * @returns {{errors: string[], warnings: string[]}}
 */
export function validatePlan(plan, config, { done = [] } = {}) {
  const errors = [];
  const warnings = [];
  if (!plan || typeof plan !== 'object') return { errors: ['plan must be a JSON object'], warnings };
  const pl = normalizePlan(plan);
  const roster = new Set((config.agents || []).map((a) => a.id));
  const extra = config.protected?.globs || [];
  const doneSet = new Set(done);
  if (pl.version !== 1) errors.push(`plan.version must be 1 (got ${JSON.stringify(plan.version)})`);

  const trackIds = new Set();
  const gateIds = new Set();
  const milestoneIds = new Set();
  for (const t of pl.tracks) {
    if (idProblem(t.id)) errors.push(`track id invalid: ${JSON.stringify(t.id)}`);
    else if (trackIds.has(t.id)) errors.push(`duplicate track id ${t.id}`);
    trackIds.add(t.id);
    if (!roster.has(t.owner)) errors.push(`track ${t.id}: owner "${t.owner}" is not in the roster`);
    if (!Array.isArray(t.owns) || !t.owns.length) warnings.push(`track ${t.id}: owns nothing`);
    for (const o of t.owns || []) { const b = badPath(o); if (b) errors.push(`track ${t.id}: owns path ${JSON.stringify(o)} ${b}`); }
  }
  for (let i = 0; i < pl.tracks.length; i++) {
    for (let j = i + 1; j < pl.tracks.length; j++) {
      const a = pl.tracks[i];
      const b = pl.tracks[j];
      for (const x of a.owns) for (const y of b.owns) if (patternsOverlap(x, y)) errors.push(`tracks ${a.id} and ${b.id} have overlapping ownership: ${x} / ${y}`);
    }
  }
  for (const g of pl.gates) {
    if (idProblem(g.id)) errors.push(`gate id invalid: ${JSON.stringify(g.id)}`);
    else if (gateIds.has(g.id)) errors.push(`duplicate gate id ${g.id}`);
    gateIds.add(g.id);
  }
  for (const m of pl.milestones) {
    if (idProblem(m.id)) errors.push(`milestone id invalid: ${JSON.stringify(m.id)}`);
    else if (milestoneIds.has(m.id)) errors.push(`duplicate milestone id ${m.id}`);
    milestoneIds.add(m.id);
  }

  const ids = new Set();
  for (const p of pl.packets) {
    const at = (m) => `${p.id}: ${m}`;
    if (idProblem(p.id)) { errors.push(`packet id invalid: ${JSON.stringify(p.id)}`); continue; }
    if (ids.has(p.id)) errors.push(`duplicate packet id ${p.id}`);
    ids.add(p.id);
    if (!String(p.title).trim()) errors.push(at('title is empty'));
    if (p.agent == null) warnings.push(at('no agent assigned (run "baton assign")'));
    else if (!roster.has(p.agent)) errors.push(at(`agent "${p.agent}" is not in the roster`));
    if (p.reviewer == null) warnings.push(at('no reviewer assigned (run "baton assign")'));
    else if (!roster.has(p.reviewer)) errors.push(at(`reviewer "${p.reviewer}" is not in the roster`));
    if (p.agent && p.reviewer && p.agent === p.reviewer && config.requireDifferentReviewer !== false) errors.push(at('reviewer equals author'));
    if (!PRIORITIES.includes(p.priority)) errors.push(at(`priority must be one of ${PRIORITIES.join('|')}`));
    if (!GATE_MODES.includes(p.gate_mode)) errors.push(at(`gate_mode must be one of ${GATE_MODES.join('|')}`));
    if (p.gate && !gateIds.has(p.gate)) errors.push(at(`unknown gate ${p.gate}`));
    if (p.milestone && pl.milestones.length && !milestoneIds.has(p.milestone)) errors.push(at(`unknown milestone ${p.milestone}`));
    if (typeof p.stretch !== 'boolean') errors.push(at('stretch must be boolean'));
    if (p.test != null && typeof p.test !== 'string') errors.push(at('test must be a string or null'));
    if (!p.owns.length) errors.push(at('owns nothing'));
    for (const o of p.owns) {
      const b = badPath(o);
      if (b) { errors.push(at(`owns path ${JSON.stringify(o)} ${b}`)); continue; }
      if (isProtected(o, extra)) errors.push(at(`owns protected path ${o}`));
    }
    let track = null;
    if (p.track != null) {
      track = pl.tracks.find((t) => t.id === p.track) || null;
      if (!track) errors.push(at(`unknown track ${p.track}`));
    }
    if (track) {
      if (p.agent && track.owner !== p.agent) warnings.push(at(`agent ${p.agent} is not the owner of track ${track.id} (${track.owner})`));
      if (track.owns.length) for (const o of p.owns) if (!badPath(o) && !inside(o, track.owns)) warnings.push(at(`${o} lies outside track ${track.id} ownership`));
    }
    for (const d of [...p.deps, ...p.needs_done]) {
      if (d === p.id) errors.push(at('depends on itself'));
      else if (!pl.packets.some((q) => q.id === d)) errors.push(at(`unknown dependency ${d}`));
    }
    p.done_checks.forEach((c) => { if (typeof c !== 'string') errors.push(at('done_checks must be strings')); });
  }

  const cyc = findCycle(pl);
  if (cyc) errors.push(`dependency cycle: ${cyc.join(' -> ')}`);

  if (!cyc) {
    const closure = {};
    for (const p of pl.packets) closure[p.id] = transitiveDeps(pl, p.id);
    for (let i = 0; i < pl.packets.length; i++) {
      for (let j = i + 1; j < pl.packets.length; j++) {
        const p = pl.packets[i];
        const q = pl.packets[j];
        if (doneSet.has(p.id) || doneSet.has(q.id)) continue;
        if (closure[p.id].has(q.id) || closure[q.id].has(p.id)) continue; // sequenced, never concurrent
        const clash = packetsOverlap(p, q);
        if (!clash.length) continue;
        const msg = `${p.id} and ${q.id} own overlapping paths ${clash.map(([a, b]) => (a === b ? a : `${a} / ${b}`)).join(', ')}`;
        if ((p.track ?? null) === (q.track ?? null)) warnings.push(`same-track overlap: ${msg}`);
        else errors.push(`cross-track overlap: ${msg}`);
      }
    }
  }
  return { errors, warnings };
}
