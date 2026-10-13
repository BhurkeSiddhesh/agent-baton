import fs from 'node:fs';
import { BatonError, UsageError } from '../lib/errors.js';
import { decodeText, list, utcnow } from '../lib/util.js';
import { withLock } from '../lib/lock.js';
import { stateDir, appendEvent } from '../lib/store.js';
import { savePlan, validatePlan, planHash, normalizePacket, normalizePlan, ID_RE, idProblem, PRIORITIES, GATE_MODES } from '../lib/plan.js';
import { DONE } from '../lib/engine.js';
import { makePainter, renderTable, statusLines, statusModel } from '../lib/views.js';

export const name = 'plan';
export const group = 'Planning';
export const summary = 'Show, validate, edit, import or graph the plan';
export const usage = 'baton plan <show|validate|track add|add|edit|rm|import|graph> [id|file] [options]';
export const description = [
  'show [id]                  print the plan (or one packet in full)',
  'validate                   check the plan against the roster and ownership rules (exit 1 on errors)',
  'track add --id T --owner A --owns a/,b/   create a track (packets name it with --track)',
  'add --title T --owns a,b   add a packet (id assigned unless --id)',
  'edit <id> [flags]          change only the flags given; "none" clears track/agent/reviewer/milestone/gate/test/deps/owns lists',
  'rm <id> [--force]          remove a packet that never started (--force also drops dependencies on it)',
  'import <file|-> [--merge|--replace] [--dry-run] [--allow-test-commands]   apply a plan or a proposal {"packets":[...]}; per-packet "test" shell commands are dropped unless allowed',
  'graph [--mermaid]          dependency graph as ASCII or Mermaid',
  'Plan writes are for the orchestrator or human: set --by, or BATON_AGENT, to your id.',
].join('\n');
export const examples = [
  'baton plan track add --id api --owner codex --owns src/api/',
  'baton plan add --title "CSV exporter" --track api --owns src/api/export.js --priority P0 --check "tests green"',
  'baton plan edit WP-003 --reviewer gemini --deps WP-001',
  'baton plan import .baton/proposals/20261013T101500Z.json --dry-run',
];
export const options = {
  json: { type: 'boolean', description: 'machine-readable output' },
  by: { type: 'string', description: 'acting agent (orchestrator or human)' },
  id: { type: 'string', description: 'add: explicit packet id' },
  title: { type: 'string', description: 'packet title' },
  track: { type: 'string', description: 'track id (see "plan track add")' },
  agent: { type: 'string', description: 'author of the packet' },
  reviewer: { type: 'string', description: 'reviewing agent (must differ from the author)' },
  owns: { type: 'string[]', description: 'owned paths, comma separated or repeated' },
  owner: { type: 'string', description: 'track add: owning agent' },
  theme: { type: 'string', description: 'track add: short theme' },
  reads: { type: 'string[]', description: 'paths the packet reads but does not own' },
  deps: { type: 'string[]', description: 'packets that should finish first' },
  'needs-done': { type: 'string[]', description: 'packets that must be ACCEPTED before this one starts' },
  priority: { type: 'string', description: 'P0|P1|P2|P3' },
  milestone: { type: 'string', description: 'milestone id' },
  description: { type: 'string', description: 'longer description of the packet' },
  check: { type: 'string[]', description: 'done check (repeatable; on edit replaces the list)' },
  stretch: { type: 'boolean', description: 'mark the packet as stretch work' },
  'no-stretch': { type: 'boolean', description: 'edit: make the packet non-stretch' },
  gate: { type: 'string', description: 'gate id that blocks this packet' },
  'gate-mode': { type: 'string', description: 'start|live_only' },
  test: { type: 'string', description: 'per-packet test command (a shell command that "baton verify" runs)' },
  force: { type: 'boolean', description: 'rm: also drop dependencies on the removed packet' },
  merge: { type: 'boolean', description: 'import: add to the existing plan (default)' },
  replace: { type: 'boolean', description: 'import: replace packets (and any lists the file provides)' },
  'allow-test-commands': { type: 'boolean', description: 'import: keep per-packet "test" shell commands from the file (dropped by default)' },
  'dry-run': { type: 'boolean', description: 'import: show the outcome without writing' },
  mermaid: { type: 'boolean', description: 'graph: print Mermaid instead of ASCII' },
};

// ------------------------------------------------------------------ shared helpers (also used by assign and split)

/** Who is acting on the plan: --by, BATON_AGENT or nobody (a human at the keyboard). Only orchestrator/human may write. */
export function requirePlanner(ctx, config, claimed) {
  const actor = ctx.agent(claimed, { required: false });
  if (actor && actor !== 'human' && actor !== config.orchestrator) {
    throw new BatonError(`only the orchestrator (${config.orchestrator}) or human may change the plan; acting as ${actor}`, { code: 'NOT_ORCHESTRATOR', hint: 'post a REQUEST on the bus instead' });
  }
  return actor || 'human';
}

/** Errors that the change introduced (pre-existing ones do not block unrelated edits) and all warnings of the new plan. */
export function diffValidation(before, after, config, state) {
  const done = Object.values(state.packets).filter((s) => DONE.has(s.status)).map((s) => s.id);
  const b = validatePlan(before, config, { done });
  const a = validatePlan(after, config, { done });
  return { errors: a.errors.filter((e) => !b.errors.includes(e)), allErrors: a.errors, warnings: a.warnings };
}

function refuse(errors) {
  const hint = errors.some((e) => /unknown track/.test(e))
    ? 'create the track first: baton plan track add --id <id> --owner <agent> --owns <paths>  (or "baton plan import" a file with a "tracks" array)'
    : null;
  return new BatonError(`refusing to write: the change introduces ${errors.length} plan error(s):\n  - ${errors.join('\n  - ')}`, { code: 'BAD_PLAN', hint });
}

/**
 * Locked read-modify-write of .baton/plan.json. `fn(draft, loaded)` mutates `draft` (a clone) and returns a result; it may
 * return {plan} to replace the draft. Refuses changes that add validation errors; records a `plan` event.
 * @returns {{result: any, plan: object, warnings: string[], written: boolean}}
 */
export function mutatePlan(ctx, args, fn, { note = '', dryRun = false } = {}) {
  return withLock(stateDir(ctx.root), () => {
    const loaded = ctx.loadState();
    const actor = requirePlanner(ctx, loaded.config, args.by);
    const draft = structuredClone(loaded.plan);
    const out = fn(draft, loaded) ?? {};
    const after = normalizePlan(out.plan ?? draft);
    const v = diffValidation(loaded.plan, after, loaded.config, loaded.state);
    if (v.errors.length) throw refuse(v.errors);
    const write = !dryRun && !out.skip;
    if (write) {
      savePlan(ctx.root, after);
      appendEvent(ctx.root, { kind: 'plan', by: actor, note, data: { hash: planHash(after) } });
    }
    return { result: out.result, plan: after, warnings: v.warnings, written: write };
  });
}

const none = (v) => (v === 'none' || v === '' ? null : v);

/** Option value of a string[] flag: undefined when absent, [] for "none", else the flattened list. */
function listArg(v) {
  if (!Array.isArray(v) || !v.length) return undefined;
  const l = list(v);
  return l.length === 1 && l[0] === 'none' ? [] : l;
}

/** Apply the packet flags that were given. Returns the changed field names. */
function applyFields(p, args) {
  const changed = [];
  const set = (k, v) => { if (v !== undefined && JSON.stringify(p[k]) !== JSON.stringify(v)) { p[k] = v; changed.push(k); } };
  if (args.title !== undefined) set('title', args.title);
  for (const k of ['track', 'agent', 'reviewer', 'milestone', 'gate', 'test']) if (args[k] !== undefined) set(k, none(args[k]));
  if (args.priority !== undefined) {
    if (!PRIORITIES.includes(args.priority)) throw new UsageError(`--priority must be one of ${PRIORITIES.join('|')}`);
    set('priority', args.priority);
  }
  if (args['gate-mode'] !== undefined) {
    if (!GATE_MODES.includes(args['gate-mode'])) throw new UsageError(`--gate-mode must be one of ${GATE_MODES.join('|')}`);
    set('gate_mode', args['gate-mode']);
  }
  if (args.description !== undefined) set('description', args.description);
  set('owns', listArg(args.owns));
  set('reads', listArg(args.reads));
  set('deps', listArg(args.deps));
  set('needs_done', listArg(args['needs-done']));
  if (args.check?.length) set('done_checks', args.check.map((c) => c.trim()).filter(Boolean));
  if (args.stretch) set('stretch', true);
  if (args['no-stretch']) set('stretch', false);
  return changed;
}

// ------------------------------------------------------------------ proposals

/** Accept a full plan, {"plan": {...}}, a proposal {"packets": [...]} or a bare array of packets. */
export function normalizeProposal(doc) {
  let d = doc;
  if (Array.isArray(d)) d = { packets: d };
  if (d && typeof d === 'object' && d.plan && typeof d.plan === 'object' && !Array.isArray(d.plan)) d = d.plan;
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new BatonError('a proposal must be a JSON object with a "packets" array', { code: 'BAD_PROPOSAL' });
  if (!Array.isArray(d.packets) && !Array.isArray(d.tracks)) throw new BatonError('a proposal needs a "packets" array (or "tracks")', { code: 'BAD_PROPOSAL' });
  for (const k of ['packets', 'tracks', 'gates', 'milestones']) if (d[k] !== undefined && !Array.isArray(d[k])) throw new BatonError(`proposal "${k}" must be an array`, { code: 'BAD_PROPOSAL' });
  for (const p of d.packets || []) if (!p || typeof p !== 'object' || Array.isArray(p)) throw new BatonError('every proposal packet must be an object', { code: 'BAD_PROPOSAL' });
  return d;
}

/**
 * Pure merge of a proposal into a plan. merge (default): proposal packets are appended, new tracks/gates/milestones added
 * (existing ids win); proposal ids that collide with the plan, or are missing, get fresh ids and references inside the
 * proposal are rewritten. A per-packet "test" field is a shell command, so it is stripped (with a note) unless `allowTests`. replace: packets (and tracks/gates/milestones/goal, when the proposal has them) replace the plan's.
 * @returns {{plan: object, added: string[], remap: Record<string,string>, notes: string[]}}
 */
export function mergeProposal(plan, proposal, mode = 'merge', { allowTests = false } = {}) {
  const prop = normalizeProposal(proposal);
  const notes = [];
  const out = structuredClone(normalizePlan(plan));
  const replace = mode === 'replace';
  if (prop.goal && (replace || !out.goal)) out.goal = prop.goal;
  for (const [key, label] of [['tracks', 'track'], ['gates', 'gate'], ['milestones', 'milestone']]) {
    if (!Array.isArray(prop[key])) continue;
    if (replace) { out[key] = structuredClone(prop[key]); continue; }
    for (const item of prop[key]) {
      const existing = out[key].find((x) => x.id === item.id);
      if (!existing) out[key].push(structuredClone(item));
      else if (JSON.stringify(existing) !== JSON.stringify(item)) notes.push(`${label} ${item.id} already exists: kept the existing definition`);
    }
  }
  const kept = replace ? [] : out.packets;
  const used = new Set(kept.map((p) => p.id));
  const seen = new Set();
  for (const p of prop.packets || []) {
    if (p.id == null) continue;
    if (seen.has(p.id)) throw new BatonError(`proposal has two packets with id ${p.id}`, { code: 'BAD_PROPOSAL' });
    seen.add(p.id);
  }
  const prefixes = {};
  for (const id of [...used, ...seen]) { const m = /^(.*)-\d+$/.exec(id); if (m) prefixes[m[1]] = (prefixes[m[1]] || 0) + 1; }
  const prefix = Object.entries(prefixes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || 'WP';
  let counter = 0;
  for (const id of [...used, ...seen]) { const m = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`).exec(id); if (m) counter = Math.max(counter, Number(m[1])); }
  const fresh = () => { let id; do { counter += 1; id = `${prefix}-${String(counter).padStart(3, '0')}`; } while (used.has(id) || seen.has(id)); return id; };
  const remap = {};
  const added = [];
  const incoming = [];
  for (const raw of prop.packets || []) {
    let id = raw.id;
    if (id == null || used.has(id) || idProblem(id)) {
      const old = id;
      id = fresh();
      if (old != null) remap[old] = id;
    }
    used.add(id);
    const inc = { ...raw, id };
    if (inc.test != null && inc.test !== '') {
      if (allowTests) notes.push(`${id} will run this shell command in "baton verify": ${inc.test}`);
      else { notes.push(`${id}: dropped its "test" command (${JSON.stringify(inc.test)}); pass --allow-test-commands to keep it`); delete inc.test; }
    }
    incoming.push(inc);
  }
  const rw = (arr) => (Array.isArray(arr) ? arr.map((d) => remap[d] ?? d) : arr);
  for (const p of incoming) {
    if (p.deps) p.deps = rw(p.deps);
    if (p.needs_done) p.needs_done = rw(p.needs_done);
    added.push(p.id);
  }
  if (replace) {
    const byId = new Map(incoming.map((p) => [p.id, p]));
    out.packets = [...byId.values()].map(normalizePacket);
  } else {
    out.packets = [...out.packets, ...incoming.map(normalizePacket)];
  }
  if (Object.keys(remap).length) notes.push(`renumbered: ${Object.entries(remap).map(([a, b]) => `${a}->${b}`).join(', ')}`);
  return { plan: out, added, remap, notes };
}

function readInput(src) {
  const buf = src === '-' ? fs.readFileSync(0) : (() => {
    try { return fs.readFileSync(src); } catch (e) { throw new BatonError(`cannot read ${src}: ${e.code || e.message}`, { code: 'IO' }); }
  })();
  const text = decodeText(buf).replace(/^﻿/, '');
  try { return JSON.parse(text); } catch (e) { throw new BatonError(`${src === '-' ? 'stdin' : src} is not valid JSON: ${e.message}`, { code: 'BAD_JSON' }); }
}

// ------------------------------------------------------------------ graph

function graphModel(plan, state) {
  const nodes = plan.packets.map((p) => ({ id: p.id, title: p.title, status: state.packets[p.id].status, track: p.track }));
  const edges = [];
  for (const p of plan.packets) {
    for (const d of p.deps) edges.push({ from: d, to: p.id, hard: false });
    for (const d of p.needs_done) edges.push({ from: d, to: p.id, hard: true });
  }
  return { nodes, edges };
}

function asciiGraph(g) {
  const label = (n) => `${n.id} ${n.title} [${n.status}]`;
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const kids = new Map(g.nodes.map((n) => [n.id, []]));
  const hasParent = new Set();
  for (const e of g.edges) if (kids.has(e.from) && byId.has(e.to)) { kids.get(e.from).push(e); hasParent.add(e.to); }
  const lines = [];
  const printed = new Set();
  const walk = (id, prefix, last, hard, top) => {
    const n = byId.get(id);
    const again = printed.has(id);
    lines.push(`${top ? '' : `${prefix}${last ? '`- ' : '|- '}`}${hard ? '(needs accepted) ' : ''}${label(n)}${again ? ' (see above)' : ''}`);
    if (again) return;
    printed.add(id);
    const next = top ? '' : `${prefix}${last ? '   ' : '|  '}`;
    kids.get(id).forEach((e, i, arr) => walk(e.to, next, i === arr.length - 1, e.hard, false));
  };
  for (const n of g.nodes) if (!hasParent.has(n.id)) walk(n.id, '', true, false, true);
  const stray = g.nodes.filter((n) => !printed.has(n.id));
  if (stray.length) { lines.push('', 'Unreachable from any root (dependency cycle?):'); for (const n of stray) lines.push(`  ${label(n)}`); }
  return lines;
}

function mermaidGraph(g) {
  const nid = (id) => `n_${String(id).replace(/[^A-Za-z0-9]/g, '_')}`;
  const esc = (s) => String(s).replace(/"/g, "'");
  const lines = ['graph TD'];
  for (const n of g.nodes) lines.push(`  ${nid(n.id)}["${esc(n.id)}: ${esc(n.title)}<br/>${n.status}"]`);
  for (const e of g.edges) lines.push(`  ${nid(e.from)} ${e.hard ? '==>' : '-->'} ${nid(e.to)}`);
  return lines;
}

// ------------------------------------------------------------------ subcommands

function packetDetail(p, s) {
  const row = (k, v) => `${k.padEnd(11)} ${Array.isArray(v) ? (v.length ? v.join(', ') : '-') : (v ?? '-') === '' ? '-' : (v ?? '-')}`;
  return [
    `${p.id}  ${p.title}`,
    row('status', `${s.status}${p.stretch ? ' (stretch)' : ''}`), row('track', p.track), row('agent', s.agent), row('reviewer', s.reviewer),
    row('priority', p.priority), row('milestone', p.milestone), row('owns', p.owns), row('reads', p.reads), row('deps', p.deps),
    row('needs_done', p.needs_done), row('gate', p.gate ? `${p.gate} (${p.gate_mode})` : null), row('test', p.test),
    row('description', p.description), ...(p.done_checks.length ? ['done checks:', ...p.done_checks.map((c) => `  - ${c}`)] : []),
  ];
}

function show(ctx, args, rest) {
  const { config, plan, events, state } = ctx.loadState();
  const paint = makePainter(ctx.env);
  if (rest[0]) {
    const p = plan.packets.find((x) => x.id === rest[0]);
    if (!p) throw new BatonError(`unknown packet ${rest[0]}`, { code: 'UNKNOWN_PACKET' });
    if (args.json) ctx.json({ packet: p, status: state.packets[p.id] });
    else ctx.out(packetDetail(p, state.packets[p.id]).join('\n'));
    return 0;
  }
  if (args.json) {
    ctx.json({ plan, statuses: Object.fromEntries(Object.values(state.packets).map((s) => [s.id, s.status])) });
    return 0;
  }
  const lines = statusLines(statusModel({ config, plan, events, state }, { now: utcnow() }), paint);
  if (plan.tracks.length) {
    lines.push('', 'Tracks:', ...renderTable(plan.tracks, [{ key: 'id', label: 'ID' }, { key: 'owner', label: 'OWNER' }, { key: 'theme', label: 'THEME', max: 36 }, { get: (t) => (t.owns || []).join(' '), label: 'OWNS', max: 60 }], paint).map((l) => `  ${l}`));
  }
  if (plan.milestones.length) lines.push('', `Milestones: ${plan.milestones.map((m) => `${m.id} ${m.title ?? ''}${m.due ? ` (${m.due})` : ''}`).join('; ')}`);
  ctx.out(lines.join('\n'));
  return 0;
}

function validate(ctx, args) {
  const { config, plan, state } = ctx.loadState();
  const done = Object.values(state.packets).filter((s) => DONE.has(s.status)).map((s) => s.id);
  const r = validatePlan(plan, config, { done });
  if (args.json) ctx.json({ ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings });
  else {
    for (const e of r.errors) ctx.out(`error: ${e}`);
    for (const w of r.warnings) ctx.out(`warning: ${w}`);
    ctx.out(r.errors.length ? `plan invalid: ${r.errors.length} error(s), ${r.warnings.length} warning(s)` : `plan valid (${plan.packets.length} packets, ${r.warnings.length} warning(s))`);
  }
  return r.errors.length ? 1 : 0;
}

function add(ctx, args) {
  if (!args.title || !String(args.title).trim()) throw new UsageError('plan add needs --title "..."');
  if (args.id !== undefined && idProblem(args.id)) throw new UsageError(`--id must match ${ID_RE}`);
  const { result, warnings, plan } = mutatePlan(ctx, args, (draft) => {
    const id = args.id || nextId(draft);
    if (draft.packets.some((p) => p.id === id)) throw new BatonError(`packet ${id} already exists`, { code: 'DUPLICATE' });
    const p = normalizePacket({ id, title: String(args.title).trim() });
    applyFields(p, args);
    draft.packets.push(p);
    return { result: p };
  }, { note: `add packet` });
  if (args.json) ctx.json({ packet: result, warnings, total: plan.packets.length });
  else {
    ctx.out(`added ${result.id}  ${result.title}`);
    for (const w of warnings.filter((x) => x.startsWith(`${result.id}:`))) ctx.out(`warning: ${w}`);
  }
  return 0;
}

function trackCmd(ctx, args, rest) {
  if (rest[0] !== 'add') throw new UsageError('plan track needs a subcommand: add');
  if (!args.id || idProblem(args.id)) throw new UsageError('plan track add needs --id <id> (letters, digits, "_", "-", ".")');
  if (!args.owner) throw new UsageError('plan track add needs --owner <agent>');
  const owns = listArg(args.owns) || [];
  const { result } = mutatePlan(ctx, args, (draft) => {
    if (draft.tracks.some((t) => t.id === args.id)) throw new BatonError(`track ${args.id} already exists`, { code: 'DUPLICATE' });
    const t = { id: args.id, owner: args.owner, theme: args.theme ?? '', owns };
    draft.tracks.push(t);
    return { result: t };
  }, { note: `add track ${args.id}` });
  if (args.json) ctx.json({ track: result });
  else ctx.out(`added track ${result.id} (owner ${result.owner}${owns.length ? `, owns ${owns.join(' ')}` : ''})`);
  return 0;
}

function nextId(plan) {
  const prefixes = {};
  for (const p of plan.packets) { const m = /^(.*)-\d+$/.exec(p.id); if (m) prefixes[m[1]] = (prefixes[m[1]] || 0) + 1; }
  const prefix = Object.entries(prefixes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || 'WP';
  let max = 0;
  for (const p of plan.packets) { const m = /^(.*)-(\d+)$/.exec(p.id); if (m && m[1] === prefix) max = Math.max(max, Number(m[2])); }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

const LOCKED_FIELDS = ['owns', 'agent', 'reviewer', 'track', 'deps', 'needs_done'];

function edit(ctx, args, rest) {
  const id = rest[0];
  if (!id) throw new UsageError('plan edit needs a packet id');
  const { result, warnings } = mutatePlan(ctx, args, (draft, { state }) => {
    const p = draft.packets.find((x) => x.id === id);
    if (!p) throw new BatonError(`unknown packet ${id}`, { code: 'UNKNOWN_PACKET' });
    const changed = applyFields(p, args);
    if (!changed.length) throw new UsageError('plan edit: nothing to change (pass at least one field flag)');
    const st = state.packets[id].status;
    const locked = changed.filter((k) => LOCKED_FIELDS.includes(k));
    if (locked.length && st !== 'PLANNED' && st !== 'CARRIED_OVER') {
      throw new BatonError(`${id} is ${st}; changing ${locked.join(', ')} would break its claim, review or ownership`, { code: 'PACKET_STARTED', hint: 'use "baton handoff", "baton reassign" or open a new packet' });
    }
    return { result: { id, changed } };
  }, { note: `edit ${id}` });
  if (args.json) ctx.json({ ...result, warnings });
  else {
    ctx.out(`edited ${id}: ${result.changed.join(', ')}`);
    for (const w of warnings.filter((x) => x.startsWith(`${id}:`))) ctx.out(`warning: ${w}`);
  }
  return 0;
}

function rm(ctx, args, rest) {
  const id = rest[0];
  if (!id) throw new UsageError('plan rm needs a packet id');
  const { result } = mutatePlan(ctx, args, (draft, { state, events }) => {
    if (!draft.packets.some((p) => p.id === id)) throw new BatonError(`unknown packet ${id}`, { code: 'UNKNOWN_PACKET' });
    const st = state.packets[id].status;
    if (st !== 'PLANNED' || events.some((e) => e.packet === id && e.kind !== 'plan')) {
      throw new BatonError(`${id} already has history (${st}); it cannot be removed`, { code: 'PACKET_STARTED', hint: 'reject it or leave it; ledger history must stay consistent' });
    }
    const dependents = draft.packets.filter((p) => p.id !== id && (p.deps.includes(id) || p.needs_done.includes(id))).map((p) => p.id);
    if (dependents.length && !args.force) {
      throw new BatonError(`${dependents.join(', ')} depend on ${id}`, { code: 'HAS_DEPENDENTS', hint: 'remove the dependency first, or pass --force to drop it' });
    }
    for (const p of draft.packets) { p.deps = p.deps.filter((d) => d !== id); p.needs_done = p.needs_done.filter((d) => d !== id); }
    draft.packets = draft.packets.filter((p) => p.id !== id);
    return { result: { id, dependentsUpdated: dependents } };
  }, { note: `remove ${id}` });
  if (args.json) ctx.json(result);
  else ctx.out(`removed ${id}${result.dependentsUpdated.length ? ` (dependency dropped from ${result.dependentsUpdated.join(', ')})` : ''}`);
  return 0;
}

function importCmd(ctx, args, rest) {
  const src = rest[0];
  if (!src) throw new UsageError('plan import needs a file path (or - for stdin)');
  if (args.merge && args.replace) throw new UsageError('use either --merge or --replace');
  const mode = args.replace ? 'replace' : 'merge';
  const doc = readInput(src);
  const dry = args['dry-run'];
  let summary;
  const outcome = (() => {
    try {
      return mutatePlan(ctx, args, (draft, { state, events }) => {
        const m = mergeProposal(draft, doc, mode, { allowTests: !!args['allow-test-commands'] });
        if (mode === 'replace') {
          const kept = new Set(m.plan.packets.map((p) => p.id));
          const lost = draft.packets.filter((p) => !kept.has(p.id) && (state.packets[p.id].status !== 'PLANNED' || events.some((e) => e.packet === p.id && e.kind !== 'plan'))).map((p) => p.id);
          if (lost.length) throw new BatonError(`--replace would drop packets that already have history: ${lost.join(', ')}`, { code: 'PACKET_STARTED', hint: 'use --merge, or keep those packets in the file' });
        }
        summary = m;
        return { plan: m.plan, result: m };
      }, { note: `import ${src === '-' ? 'stdin' : src} (${mode})`, dryRun: dry });
    } catch (e) {
      if (dry && e instanceof BatonError && e.code === 'BAD_PLAN') return { failed: e };
      throw e;
    }
  })();
  if (outcome.failed) {
    const msg = outcome.failed.message;
    if (args.json) ctx.json({ ok: false, dryRun: true, error: msg });
    else ctx.out(`dry run: the import would be refused.\n${msg}`);
    return 1;
  }
  const m = outcome.result;
  if (args.json) ctx.json({ ok: true, dryRun: !!dry, mode, added: m.added, remap: m.remap, notes: m.notes, warnings: outcome.warnings, packets: outcome.plan.packets.length });
  else {
    ctx.out(`${dry ? 'dry run: would import' : 'imported'} ${m.added.length} packet(s) (${mode}): ${m.added.join(', ') || 'none'}`);
    for (const n of m.notes) ctx.out(`note: ${n}`);
    for (const w of outcome.warnings) ctx.out(`warning: ${w}`);
    if (dry) ctx.out('nothing was written');
  }
  return 0;
}

function graph(ctx, args) {
  const { plan, state } = ctx.loadState();
  const g = graphModel(plan, state);
  if (args.json) ctx.json(g);
  else ctx.out((args.mermaid ? mermaidGraph(g) : asciiGraph(g)).join('\n'));
  return 0;
}

export async function run(ctx, args) {
  const [sub, ...rest] = args._;
  if (!sub) throw new UsageError('plan needs a subcommand: show|validate|track add|add|edit|rm|import|graph');
  switch (sub) {
    case 'show': return show(ctx, args, rest);
    case 'validate': return validate(ctx, args);
    case 'track': return trackCmd(ctx, args, rest);
    case 'add': return add(ctx, args);
    case 'edit': return edit(ctx, args, rest);
    case 'rm': case 'remove': return rm(ctx, args, rest);
    case 'import': return importCmd(ctx, args, rest);
    case 'graph': return graph(ctx, args);
    default: throw new UsageError(`unknown plan subcommand "${sub}" (show|validate|track add|add|edit|rm|import|graph)`);
  }
}

