// Read-only presentation helpers for the planning commands: terminal tables, colour, status/release/digest models,
// generated Markdown views and the variables handed to prompt templates. Pure functions of (config, plan, events, state).
import fs from 'node:fs';
import path from 'node:path';
import { BatonError } from './errors.js';
import { utcnow, stamp, parseTime, walk } from './util.js';
import { templatesDir, packageRoot, packageVersion } from './paths.js';
import { flags, findingsOf, nextFor, scores, progress, DONE, STATUSES } from './engine.js';
import { nextPacketId } from './plan.js';

// ------------------------------------------------------------------ colour and tables

const CODES = { red: 31, green: 32, yellow: 33, magenta: 35, cyan: 36, dim: 2, bold: 1 };
const STATUS_COLOR = {
  ACCEPTED: 'green', ACCEPTED_WITH_FIXES: 'yellow', IN_PROGRESS: 'cyan', READY_FOR_REVIEW: 'yellow',
  REJECTED: 'red', BLOCKED: 'red', CARRIED_OVER: 'magenta', PLANNED: 'dim',
};

/** Colour only on a TTY with NO_COLOR unset or empty (https://no-color.org). */
export function colorEnabled(env = process.env, isTTY = process.stdout.isTTY) {
  return !!isTTY && !(env && env.NO_COLOR);
}

/** @returns {(color: string, text: string) => string} wraps text in ANSI only when colour is enabled. */
export function makePainter(env = process.env, isTTY = process.stdout.isTTY) {
  const on = colorEnabled(env, isTTY);
  return (color, text) => (on && CODES[color] ? `\u001b[${CODES[color]}m${text}\u001b[0m` : String(text));
}

export const clip = (s, n) => { const t = String(s ?? ''); return t.length > n ? `${t.slice(0, Math.max(0, n - 1))}~` : t; };

/**
 * Aligned plain-text table. columns: [{key|get, label, max?, right?, paint?: (value, row) => colorName|null}].
 * Padding is applied before colouring so ANSI codes never disturb alignment.
 * @returns {string[]} lines (no trailing spaces)
 */
export function renderTable(rows, columns, paint = (_c, t) => t) {
  const cell = (r, c) => clip(c.get ? c.get(r) : r[c.key], c.max ?? 200);
  const widths = columns.map((c) => Math.max(String(c.label).length, ...rows.map((r) => cell(r, c).length)));
  const fmt = (text, i, c) => (c.right ? text.padStart(widths[i]) : text.padEnd(widths[i]));
  const lines = [columns.map((c, i) => paint('bold', fmt(String(c.label), i, c))).join('  ').trimEnd()];
  for (const r of rows) {
    lines.push(columns.map((c, i) => {
      const text = fmt(cell(r, c), i, c);
      const color = c.paint ? c.paint(cell(r, c), r) : null;
      return color ? paint(color, text) : text;
    }).join('  ').trimEnd());
  }
  return lines;
}

export const statusColor = (status) => STATUS_COLOR[status] || null;

export function bar(percent, width = 10) {
  const n = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return `[${'#'.repeat(n)}${'-'.repeat(width - n)}]`;
}

export function cliOf(config) { return config?.runtime?.command || 'baton'; }

export function shortTs(ts) { return String(ts || '').replace('T', ' ').replace(/:\d\dZ$/, 'Z'); }

// ------------------------------------------------------------------ status model

function leaseLabel(s, now) {
  if (s.status !== 'IN_PROGRESS') return '';
  const lease = parseTime(s.leaseUntil);
  if (!lease) return 'no lease';
  const h = (lease - now) / 3_600_000;
  if (h < 0) return `lease expired ${Math.max(1, Math.round(-h))}h ago`;
  return h < 1 ? `lease ${Math.max(1, Math.round(h * 60))}m left` : `lease ${Math.round(h)}h left`;
}

/**
 * Per-packet status rows plus counts. Filters: track, agent (author, reviewer, or current holder).
 * Row: {id,title,track,priority,milestone,stretch,status,agent,reviewer,by,flags[],lease,leaseUntil,deps[],openFindings:{BLOCKER,MAJOR,MINOR,total},rejections}
 */
export function statusModel({ config, plan, events, state }, { track = null, agent = null, now = utcnow() } = {}) {
  const open = findingsOf(events).filter((f) => f.status !== 'closed');
  let rows = plan.packets.map((p) => {
    const s = state.packets[p.id];
    const mine = open.filter((f) => f.packet === p.id);
    return {
      id: p.id, title: p.title, track: p.track, priority: p.priority, milestone: p.milestone, stretch: p.stretch,
      status: s.status, agent: s.agent, reviewer: s.reviewer, by: s.by,
      flags: flags(p.id, plan, state, { config, now }), lease: leaseLabel(s, now), leaseUntil: s.leaseUntil,
      deps: [...p.deps, ...p.needs_done.filter((d) => !p.deps.includes(d))],
      openFindings: { BLOCKER: mine.filter((f) => f.severity === 'BLOCKER').length, MAJOR: mine.filter((f) => f.severity === 'MAJOR').length, MINOR: mine.filter((f) => f.severity === 'MINOR').length, total: mine.length },
      rejections: s.rejections,
    };
  });
  if (track) rows = rows.filter((r) => r.track === track);
  if (agent) rows = rows.filter((r) => [r.agent, r.reviewer, r.by].includes(agent));
  const counts = Object.fromEntries(STATUSES.map((st) => [st, rows.filter((r) => r.status === st).length]));
  return {
    goal: plan.goal, filters: { track, agent }, total: rows.length, counts, packets: rows,
    gates: plan.gates.map((g) => ({ id: g.id, title: g.title ?? '', owner: g.owner ?? 'human', open: !!state.gates[g.id]?.open })),
  };
}

export function noteText(r) {
  const parts = [...r.flags];
  if (r.lease && !r.flags.includes('STALE') && !r.flags.includes('NO_LEASE')) parts.push(r.lease);
  if (r.openFindings.total) parts.push(`findings ${['BLOCKER', 'MAJOR', 'MINOR'].filter((k) => r.openFindings[k]).map((k) => `${r.openFindings[k]}${k[0]}`).join('/')}`);
  return parts.join(' ');
}

export function countsLine(counts) {
  const parts = STATUSES.filter((s) => counts[s]).map((s) => `${s} ${counts[s]}`);
  return parts.length ? parts.join('  ') : 'no packets';
}

export function statusLines(model, paint = (_c, t) => t) {
  const lines = [];
  if (model.goal) lines.push(`Goal: ${model.goal}`);
  const filt = [model.filters.track && `track=${model.filters.track}`, model.filters.agent && `agent=${model.filters.agent}`].filter(Boolean);
  lines.push(`Packets: ${model.total}${filt.length ? ` (${filt.join(', ')})` : ''}   ${countsLine(model.counts)}`);
  if (model.packets.length) {
    lines.push('');
    lines.push(...renderTable(model.packets, [
      { key: 'id', label: 'ID' },
      { key: 'priority', label: 'PRI' },
      { key: 'status', label: 'STATUS', paint: (v) => statusColor(v) },
      { label: 'AGENT>REVIEWER', get: (r) => `${r.agent || '-'}>${r.reviewer || '-'}` },
      { get: (r) => r.track || '-', label: 'TRACK' },
      { key: 'title', label: 'TITLE', max: 40 },
      { label: 'NOTES', get: noteText, paint: (v) => (/STALE|ESCALATE|BLOCKER/.test(v) ? 'red' : v ? 'yellow' : null) },
    ], paint));
  }
  const closed = model.gates.filter((g) => !g.open);
  if (closed.length) lines.push('', `Closed gates: ${closed.map((g) => `${g.id} (${g.owner}) ${g.title}`).join('; ')}`);
  return lines;
}

// ------------------------------------------------------------------ scores and release

export function scoreRows(plan, events, config) {
  const sc = scores(plan, events).agents;
  const blank = () => ({ started: 0, ready: 0, accepted: 0, acceptedWithFixes: 0, rejected: 0, rework: 0, reopensAfterFixes: 0, reviewsGiven: 0, meanScoreGiven: null, findingsFiled: 0, findingsConfirmed: 0, findingsInvalid: 0, findingsAgainstOpen: 0, findingsAgainstClosed: 0, firstPassRate: null });
  const ids = [...new Set([...(config.agents || []).map((a) => a.id), ...Object.keys(sc)])];
  return ids.map((id) => ({ agent: id, ...blank(), ...(sc[id] || {}) }));
}

export const SCORE_COLUMNS = [
  { key: 'agent', label: 'AGENT' },
  { key: 'started', label: 'START', right: true },
  { key: 'ready', label: 'READY', right: true },
  { key: 'accepted', label: 'ACC', right: true },
  { key: 'acceptedWithFixes', label: 'FIXES', right: true },
  { key: 'rejected', label: 'REJ', right: true },
  { key: 'rework', label: 'REWORK', right: true },
  { label: 'FIRST-PASS', right: true, get: (r) => (r.firstPassRate == null ? '-' : `${Math.round(r.firstPassRate * 100)}%`) },
  { label: 'REVIEWS(AVG)', right: true, get: (r) => `${r.reviewsGiven}${r.meanScoreGiven == null ? '' : `(${r.meanScoreGiven})`}` },
  { label: 'FOUND(OK/INV)', right: true, get: (r) => `${r.findingsFiled}(${r.findingsConfirmed}/${r.findingsInvalid})` },
  { label: 'AGAINST(OPEN/CLOSED)', right: true, get: (r) => `${r.findingsAgainstOpen}/${r.findingsAgainstClosed}` },
];

export function releaseLines(prog, paint = (_c, t) => t) {
  const lines = [];
  for (const m of prog.milestones) {
    const when = m.due ? `due ${m.due} (${m.daysLeft >= 0 ? `${m.daysLeft}d left` : `${-m.daysLeft}d ago`})` : 'no due date';
    const head = `${m.id ?? '-'}  ${m.title}`;
    lines.push(`${paint(m.overdue ? 'red' : 'bold', head)}  ${when}${m.overdue ? paint('red', '  OVERDUE') : ''}`);
    lines.push(`  ${bar(m.percent)} ${String(m.percent).padStart(3)}%  ${m.done}/${m.total} done, ${m.inReview} in review, ${m.inProgress} in progress, ${m.blocked} blocked, ${m.notStarted} not started${m.gated.length ? `, gated: ${m.gated.join(' ')}` : ''}`);
  }
  if (!prog.milestones.length) lines.push('no packets');
  lines.push('', `Overall: ${bar(prog.overall.percent)} ${prog.overall.percent}%  (${prog.overall.done}/${prog.overall.total} accepted; stretch packets excluded)`);
  if (prog.closedGates.length) {
    lines.push('', 'Closed gates:');
    for (const g of prog.closedGates) {
      const need = g.neededBy ? `  needed by ${g.neededBy}${g.daysUntilNeeded != null ? ` (${g.daysUntilNeeded >= 0 ? `${g.daysUntilNeeded}d` : `${-g.daysUntilNeeded}d overdue`})` : ''}` : '';
      lines.push(`  ${g.id}  ${g.title}  owner=${g.owner}${need}`);
    }
  }
  return lines;
}

// ------------------------------------------------------------------ bus

/** All bus messages, oldest first: {id,ts,from,to,type,packet,text}. */
export function busMessages(events) {
  return events.filter((e) => e.kind === 'message').map((e) => ({
    id: e.id, ts: e.ts, from: e.by, to: e.data?.to ?? 'all', type: e.data?.type ?? 'NOTICE', packet: e.packet ?? null, text: e.data?.text ?? '',
  }));
}

// ------------------------------------------------------------------ digest

const ATTENTION_TYPES = new Set(['REQUEST', 'QUESTION', 'BLOCKER']);

function describe(ev) {
  const d = ev.data || {};
  const p = ev.packet || '';
  switch (ev.kind) {
    case 'begin': return { group: 'started', text: `${p} started by ${ev.by}${ev.note ? ` (${ev.note})` : ''}` };
    case 'ready': return { group: 'ready for review', text: `${p} ready for review by ${ev.by}` };
    case 'verdict': return { group: 'verdicts', text: `${p} ${ev.to} by ${ev.by}${d.score != null ? ` score ${d.score}` : ''}${ev.note ? `: ${ev.note}` : ''}` };
    case 'status': return ev.to === 'BLOCKED' ? { group: 'blocked', text: `${p} blocked by ${ev.by}${ev.note ? `: ${ev.note}` : ''}` }
      : ev.to ? { group: 'status', text: `${p} -> ${ev.to} (${ev.by})` } : null;
    case 'handoff': return { group: 'handoffs', text: `${p} handed to ${d.agent} (from ${d.from || '-'}) by ${ev.by}` };
    case 'reviewer': return { group: 'handoffs', text: `${p} reviewer -> ${d.reviewer} by ${ev.by}` };
    case 'reclaim': return { group: 'started', text: `${p} reclaimed by ${ev.by}` };
    case 'finding': return { group: 'findings', text: `${d.fid} ${d.severity} on ${p} filed by ${ev.by}: ${ev.note}` };
    case 'finding_resolved': return { group: 'findings', text: `${d.fid} ${d.confirm ? 'confirmed' : `resolved as ${d.resolution}`} by ${ev.by}` };
    case 'gate': return { group: 'gates', text: `gate ${d.gate} ${d.open ? 'opened' : 'closed'} by ${ev.by}` };
    case 'merged': return { group: 'merged', text: `${p} merged${d.commit ? ` at ${String(d.commit).slice(0, 8)}` : ''}` };
    case 'plan': return { group: 'plan', text: `plan changed by ${ev.by}${ev.note ? `: ${ev.note}` : ''}` };
    case 'message': return ATTENTION_TYPES.has(d.type) ? { group: 'bus', text: `${d.type} ${ev.by}->${d.to}${p ? ` [${p}]` : ''}: ${d.text}` } : null;
    default: return null;
  }
}

/**
 * Orchestrator report: what changed (`events` already filtered to the window) plus what needs attention now.
 */
export function digestModel({ config, plan, events, state }, windowEvents, { since = null, now = utcnow() } = {}) {
  const changes = [];
  for (const ev of windowEvents) {
    const d = describe(ev);
    if (d) changes.push({ id: ev.id, ts: ev.ts, kind: ev.kind, packet: ev.packet ?? null, by: ev.by ?? null, ...d });
  }
  const attention = [];
  const rows = statusModel({ config, plan, events, state }, { now }).packets;
  for (const r of rows) {
    if (r.flags.includes('ESCALATE')) attention.push({ type: 'escalate', packet: r.id, text: `${r.id} rejected ${r.rejections}x: orchestrator decision needed` });
    if (r.flags.includes('STALE')) attention.push({ type: 'stale', packet: r.id, text: `${r.id} lease expired (held by ${r.by || '-'}): reclaim or hand off` });
    if (r.flags.includes('NO_LEASE')) attention.push({ type: 'no_lease', packet: r.id, text: `${r.id} in progress without a lease` });
    if (r.status === 'READY_FOR_REVIEW') attention.push({ type: 'review', packet: r.id, text: `${r.id} waits for review by ${r.reviewer || 'nobody (no reviewer)'}` });
    if (r.status === 'BLOCKED') attention.push({ type: 'blocked', packet: r.id, text: `${r.id} is blocked${state.packets[r.id].blockedReason ? `: ${state.packets[r.id].blockedReason}` : ''}` });
    if (r.status === 'REJECTED') attention.push({ type: 'carry', packet: r.id, text: `${r.id} rejected: rework by ${r.agent || '-'} or carry over` });
    if (r.openFindings.BLOCKER || r.openFindings.MAJOR) attention.push({ type: 'findings', packet: r.id, text: `${r.id} has open ${r.openFindings.BLOCKER} BLOCKER / ${r.openFindings.MAJOR} MAJOR finding(s)` });
    if (!DONE.has(r.status) && !r.stretch && (!r.agent || !r.reviewer)) attention.push({ type: 'unassigned', packet: r.id, text: `${r.id} lacks ${!r.agent ? 'an agent' : 'a reviewer'}: run "assign"` });
  }
  for (const g of plan.gates) {
    const gs = state.gates[g.id];
    if (gs && !gs.open) {
      const waiting = plan.packets.filter((p) => p.gate === g.id && !DONE.has(state.packets[p.id].status)).map((p) => p.id);
      if (waiting.length) attention.push({ type: 'gate', gate: g.id, text: `gate ${g.id} (${g.owner ?? 'human'}) is closed and holds ${waiting.join(', ')}` });
    }
  }
  const horizon = {};
  for (const a of config.agents) {
    if (!a.roles.includes('worker')) continue;
    const q = nextFor(a.id, plan, state, { config, now });
    horizon[a.id] = q.own.length + q.stretch.length;
    if (q.own.length < 3 && plan.packets.some((p) => !DONE.has(state.packets[p.id].status))) {
      attention.push({ type: 'horizon', agent: a.id, text: `${a.id} has ${q.own.length} ready packet(s); keep the horizon at least 3 deep` });
    }
  }
  const sm = statusModel({ config, plan, events, state }, { now });
  return {
    generated: stamp(now), since: since ? { ts: since.ts ?? null, event: since.event ?? null } : null,
    counts: sm.counts, total: sm.total, changes, attention, horizon, progress: progress(plan, state, { now }).overall,
  };
}

export function digestLines(model) {
  const lines = [`Digest generated ${model.generated}${model.since?.event ? `, since last digest (${model.since.ts})` : model.since?.ts ? `, since ${model.since.ts}` : ', full history'}`];
  lines.push(`Packets ${model.total}: ${countsLine(model.counts)}   overall ${model.progress.percent}% accepted`);
  const groups = new Map();
  for (const c of model.changes) { if (!groups.has(c.group)) groups.set(c.group, []); groups.get(c.group).push(c); }
  lines.push('', model.changes.length ? 'Changes:' : 'Changes: none');
  for (const [g, list] of groups) {
    lines.push(`  ${g} (${list.length})`);
    for (const c of list) lines.push(`    ${shortTs(c.ts)}  ${c.text}`);
  }
  lines.push('', model.attention.length ? 'Needs attention:' : 'Needs attention: nothing');
  for (const a of model.attention) lines.push(`  - ${a.text}`);
  return lines;
}

// ------------------------------------------------------------------ generated Markdown views

const mdCell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
function mdTable(headers, rows) {
  if (!rows.length) return '_none_\n';
  return `${[`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`)].join('\n')}\n`;
}
const GENERATED = (now) => `<!-- generated by baton render at ${stamp(now)}; do not edit -->\n`;

export function renderStatusMd(loaded, now = utcnow()) {
  const { config, plan, events, state } = loaded;
  const sm = statusModel(loaded, { now });
  const prog = progress(plan, state, { now });
  const out = [`# Status: ${config.project?.name ?? ''}\n`, GENERATED(now), sm.goal ? `**Goal:** ${sm.goal}\n` : '', `**Packets:** ${sm.total} (${countsLine(sm.counts)})  \n**Overall:** ${prog.overall.percent}% (${prog.overall.done}/${prog.overall.total} accepted)\n`];
  out.push('## Packets\n', mdTable(['ID', 'Pri', 'Status', 'Agent', 'Reviewer', 'Track', 'Title', 'Notes'],
    sm.packets.map((r) => [r.id, r.priority, r.status, r.agent || '-', r.reviewer || '-', r.track || '-', r.title, noteText(r)])));
  out.push('## Milestones\n', mdTable(['ID', 'Title', 'Due', 'Done', 'In review', 'In progress', 'Blocked', 'Not started', '%'],
    prog.milestones.map((m) => [m.id ?? '-', m.title, m.due ?? '-', `${m.done}/${m.total}`, m.inReview, m.inProgress, m.blocked, m.notStarted, `${m.percent}%`])));
  out.push('## Gates\n', mdTable(['ID', 'Title', 'Owner', 'State'], sm.gates.map((g) => [g.id, g.title, g.owner, g.open ? 'open' : 'closed'])));
  const open = findingsOf(events).filter((f) => f.status !== 'closed');
  out.push('## Open findings\n', mdTable(['ID', 'Packet', 'Severity', 'Status', 'Filed by', 'Against', 'Text'],
    open.map((f) => [f.fid, f.packet, f.severity, f.status, f.by, f.against || '-', f.text])));
  return out.join('\n');
}

export function renderBusMd(loaded, now = utcnow()) {
  const msgs = busMessages(loaded.events);
  return [`# Bus\n`, GENERATED(now), mdTable(['Time', 'From', 'To', 'Type', 'Packet', 'Text'], msgs.map((m) => [shortTs(m.ts), m.from, m.to, m.type, m.packet || '-', m.text]))].join('\n');
}

export function renderScoreboardMd(loaded, now = utcnow()) {
  const rows = scoreRows(loaded.plan, loaded.events, loaded.config);
  const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`);
  return [`# Scoreboard\n`, GENERATED(now), mdTable(
    ['Agent', 'Started', 'Ready', 'Accepted', 'With fixes', 'Rejected', 'Rework', 'First-pass', 'Reviews', 'Mean score given', 'Findings filed', 'Confirmed', 'Invalid', 'Against open', 'Against closed'],
    rows.map((r) => [r.agent, r.started, r.ready, r.accepted, r.acceptedWithFixes, r.rejected, r.rework, pct(r.firstPassRate), r.reviewsGiven, r.meanScoreGiven ?? '-', r.findingsFiled, r.findingsConfirmed, r.findingsInvalid, r.findingsAgainstOpen, r.findingsAgainstClosed])),
  ].join('\n');
}

export function renderPlanMd(loaded, now = utcnow()) {
  const { config, plan, state } = loaded;
  const out = [`# Plan: ${config.project?.name ?? ''}\n`, GENERATED(now), plan.goal ? `**Goal:** ${plan.goal}\n` : ''];
  out.push('## Tracks\n', mdTable(['ID', 'Owner', 'Theme', 'Owns'], plan.tracks.map((t) => [t.id, t.owner, t.theme, (t.owns || []).join(', ')])));
  out.push('## Milestones\n', mdTable(['ID', 'Title', 'Due'], plan.milestones.map((m) => [m.id, m.title ?? '', m.due ?? '-'])));
  out.push('## Gates\n', mdTable(['ID', 'Title', 'Owner', 'State'], plan.gates.map((g) => [g.id, g.title ?? '', g.owner ?? 'human', state.gates[g.id]?.open ? 'open' : 'closed'])));
  out.push('## Packets\n');
  for (const p of plan.packets) {
    const s = state.packets[p.id];
    out.push(`### ${p.id} ${p.title}\n`);
    out.push([
      `- Status: ${s.status}${p.stretch ? ' (stretch)' : ''}; priority ${p.priority}; track ${p.track || '-'}; milestone ${p.milestone || '-'}`,
      `- Agent: ${s.agent || '-'}; reviewer: ${s.reviewer || '-'}`,
      `- Owns: ${p.owns.map((o) => `\`${o}\``).join(', ') || '-'}`,
      p.reads.length ? `- Reads: ${p.reads.map((o) => `\`${o}\``).join(', ')}` : '',
      p.deps.length || p.needs_done.length ? `- Depends on: ${[...p.deps, ...p.needs_done.map((d) => `${d} (must be accepted)`)].join(', ')}` : '',
      p.gate ? `- Gate: ${p.gate} (${p.gate_mode})` : '',
      p.test ? `- Test command: \`${p.test}\`` : '',
    ].filter(Boolean).join('\n') + '\n');
    if (p.description) out.push(`${p.description}\n`);
    if (p.done_checks.length) out.push(`Done checks:\n${p.done_checks.map((c) => `- [${DONE.has(s.status) ? 'x' : ' '}] ${c}`).join('\n')}\n`);
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ prompt templates

export const ROLE_TITLES = { orchestrator: 'Orchestrator', worker: 'Worker', reviewer: 'Reviewer', auditor: 'Auditor', split: 'Planner' };
export const PROMPT_NAMES = Object.keys(ROLE_TITLES);

/** Templates directory: BATON_TEMPLATES_DIR (tests, custom kits) or the package's templates/. */
export function templatesRoot(env = process.env) {
  return env.BATON_TEMPLATES_DIR ? path.resolve(env.BATON_TEMPLATES_DIR) : templatesDir();
}

/** @returns {{text: string, file: string, dir: string}} the raw prompt template. */
export function loadPromptTemplate(name, env = process.env) {
  const dir = templatesRoot(env);
  const file = path.join(dir, 'prompts', `${name}.md`);
  try {
    return { text: fs.readFileSync(file, 'utf8'), file, dir };
  } catch {
    throw new BatonError(`prompt template not found: ${file}`, { code: 'NO_TEMPLATE', hint: `expected templates/prompts/${name}.md under ${path.relative(process.cwd(), packageRoot()) || '.'}` });
  }
}

export const PLAN_SCHEMA = `{
  "goal": "one sentence",
  "tracks":     [ { "id": "api", "owner": "<agent id>", "theme": "short theme", "owns": ["src/api/", "tests/api/"] } ],
  "gates":      [ { "id": "G1", "title": "what a human must decide", "owner": "human" } ],
  "milestones": [ { "id": "M1", "title": "Alpha", "due": "YYYY-MM-DD" } ],
  "packets": [ {
    "id": "WP-001",                      // optional in a proposal; unique, [A-Za-z0-9][A-Za-z0-9_.-]*
    "title": "short imperative title",
    "track": "api",
    "agent": "<agent id> | null",         // author; null lets "baton assign" decide
    "reviewer": "<agent id> | null",      // never the author
    "owns": ["exact/file.js", "dir/"],    // required, repo-relative, no "..", no secrets or .env files
    "reads": ["docs/CONTRACT.md"],
    "deps": ["WP-000"],                   // same-track deps block starting until reviewable
    "needs_done": [],                     // must be ACCEPTED before starting
    "gate": null, "gate_mode": "start",   // "start" | "live_only"
    "priority": "P0",                     // P0 | P1 | P2 | P3
    "milestone": "M1", "stretch": false,
    "test": null,                         // optional per-packet test command
    "description": "what and why",
    "done_checks": ["observable, checkable statement"]
  } ]
}`;

export const PLAN_EXAMPLE = `{
  "packets": [
    { "title": "Invoice CSV exporter", "track": "api", "owns": ["src/api/export.js", "tests/api/export.test.js"], "priority": "P0", "done_checks": ["handles empty invoices", "tests green"] },
    { "title": "Export route", "track": "api", "owns": ["src/api/route.js"], "deps": ["WP-001"], "priority": "P1" }
  ]
}`;

export const SPLIT_RULES = [
  'Every packet owns an exact list of files or directories; two packets that can run at the same time must never own overlapping paths.',
  'Packets in different tracks must not depend on each other for starting; use deps only inside a track, needs_done for hard prerequisites.',
  'Never plan edits to secrets, .env files, keys, databases or credentials.',
  'Prefer 0.5 to 2 day packets with 2 to 5 observable done_checks each.',
  'Use agent strengths to pick authors; the reviewer must differ from the author.',
  'Output exactly one JSON object and nothing else.',
];

/** Compact repo tree: top-level files, directories with file counts, one more level below them. */
export function treeSummary(root, { maxLines = 60 } = {}) {
  let files;
  try { files = walk(root).filter((f) => !f.startsWith('.baton/')); } catch { files = []; }
  const top = []; const d1 = new Map(); const d2 = new Map();
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length === 1) { top.push(f); continue; }
    d1.set(parts[0], (d1.get(parts[0]) || 0) + 1);
    if (parts.length > 2) { const k = `${parts[0]}/${parts[1]}`; d2.set(k, (d2.get(k) || 0) + 1); }
  }
  const lines = [...top.slice(0, 25)];
  if (top.length > 25) lines.push(`... (+${top.length - 25} more top-level files)`);
  for (const dir of [...d1.keys()].sort()) {
    lines.push(`${dir}/ (${d1.get(dir)} files)`);
    for (const sub of [...d2.keys()].filter((k) => k.startsWith(`${dir}/`)).sort()) lines.push(`  ${sub}/ (${d2.get(sub)})`);
  }
  if (!lines.length) return '(empty repository)';
  if (lines.length > maxLines) return [...lines.slice(0, maxLines), `... (+${lines.length - maxLines} more entries)`].join('\n');
  return lines.join('\n');
}

/**
 * Variables for prompt templates (spec 7.1 plus planning extras).
 * `agent` is the acting agent's id (empty when none); `agentName` its display name.
 */
export function buildPromptVars({ root, config, plan, state, env = process.env }, { role, agent = null, goal = '' } = {}) {
  const info = agent ? config.agents.find((a) => a.id === agent) : null;
  const packets = plan.packets.map((p) => ({ id: p.id, title: p.title, track: p.track || '', agent: state.packets[p.id].agent || '', reviewer: state.packets[p.id].reviewer || '', status: state.packets[p.id].status, priority: p.priority, owns: p.owns }));
  const prefixes = {};
  for (const p of plan.packets) { const m = /^(.*)-\d+$/.exec(p.id); if (m) prefixes[m[1]] = (prefixes[m[1]] || 0) + 1; }
  const prefix = Object.entries(prefixes).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || 'WP';
  return {
    project: { name: config.project?.name ?? '', description: config.project?.description ?? '', stack: config.project?.stack ?? [] },
    cli: cliOf(config),
    agents: config.agents.map((a) => ({ id: a.id, name: a.name, kind: a.kind, roles: a.roles, strengths: a.strengths })),
    orchestrator: config.orchestrator,
    testCommand: config.test?.command ?? '',
    role, roleTitle: ROLE_TITLES[role] || role,
    agent: agent || '', agentName: info?.name || agent || '', agentRoles: info?.roles || [],
    baton: { version: packageVersion() },
    goal: goal || plan.goal || '',
    tree: treeSummary(root), schema: PLAN_SCHEMA, example: PLAN_EXAMPLE, rules: SPLIT_RULES,
    planGoal: plan.goal || '', tracks: plan.tracks, gates: plan.gates, milestones: plan.milestones,
    packets, packetCount: packets.length, hasPlan: packets.length > 0, nextId: nextPacketId(plan, prefix),
  };
}
