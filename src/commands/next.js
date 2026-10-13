import { nextFor, findingsOf } from '../lib/engine.js';
import { utcnow } from '../lib/util.js';
import { cliOf, makePainter, renderTable } from '../lib/views.js';

export const name = 'next';
export const group = 'Planning';
export const summary = 'What an agent should do next, in strict order';
export const usage = 'baton next --agent <id> [--json]';
export const description = [
  'Order: 1 reviews awaiting you, 2 your rework (REJECTED, ACCEPTED_WITH_FIXES, CARRIED_OVER),',
  '3 ready packets assigned to you or unassigned on your tracks (P0 first), 4 stretch packets, 5 audit targets,',
  'then a HORIZON EXHAUSTED notice when there is no build work left for you.',
].join('\n');
export const examples = ['baton next --agent codex', 'baton next --agent claude --json'];
export const options = {
  agent: { type: 'string', alias: 'a', description: 'agent asking (or set BATON_AGENT)' },
  json: { type: 'boolean' },
};

const PRI = { P0: 0, P1: 1, P2: 2, P3: 3 };
const REWORK_STATUSES = new Set(['REJECTED', 'ACCEPTED_WITH_FIXES', 'CARRIED_OVER']);

export async function run(ctx, args) {
  const loaded = ctx.loadState();
  const { config, plan, events, state } = loaded;
  const agent = ctx.agent(args.agent, { required: true });
  const now = utcnow();
  const cli = cliOf(config);
  const q = nextFor(agent, plan, state, { config, now });
  const info = config.agents.find((a) => a.id === agent);
  const roles = info?.roles || ['worker', 'reviewer', 'auditor', 'orchestrator'];
  const can = (r) => agent === 'human' || roles.includes(r);
  const pk = (id) => plan.packets.find((p) => p.id === id);
  const open = findingsOf(events).filter((f) => f.status !== 'closed');
  const entry = (kind, id, why, command) => {
    const p = pk(id); const s = state.packets[id];
    return { kind, packet: id, title: p.title, priority: p.priority, track: p.track, status: s.status, author: s.agent, reviewer: s.reviewer, why, command };
  };

  const sections = { awaitingReview: [], rework: [], ready: [], stretch: [], audit: [], pull: [], stale: [], blocked: [] };
  if (can('reviewer')) sections.awaitingReview = q.awaitingReview.map((id) => entry('review', id, `ready for your review (author ${state.packets[id].agent || '-'})`, `${cli} review ${id}`));
  if (can('worker')) {
    sections.rework = q.reworkOwed.filter((id) => REWORK_STATUSES.has(state.packets[id].status)).map((id) => {
      const s = state.packets[id];
      const f = open.filter((x) => x.packet === id);
      return entry('rework', id, `${s.status}${s.verdict?.by ? ` by ${s.verdict.by}` : ''}${f.length ? `, ${f.length} open finding(s)` : ''}`, `${cli} begin ${id} --agent ${agent}`);
    });
    const myTracks = new Set(plan.tracks.filter((t) => t.owner === agent).map((t) => t.id));
    const inRework = new Set(sections.rework.map((e) => e.packet));
    const readyIds = [...q.own, ...q.unassigned.filter((id) => !pk(id).stretch && myTracks.has(pk(id).track))].filter((id) => !inRework.has(id));
    const ordered = readyIds.map((id, i) => ({ id, i })).sort((a, b) => (PRI[pk(a.id).priority] ?? 9) - (PRI[pk(b.id).priority] ?? 9) || a.i - b.i).map((x) => x.id);
    sections.ready = ordered.map((id) => entry('ready', id, state.packets[id].agent ? 'assigned to you' : `unassigned on your track ${pk(id).track}`, `${cli} begin ${id} --agent ${agent}`));
    sections.stretch = q.stretch.filter((id) => !inRework.has(id)).map((id) => entry('stretch', id, 'optional stretch packet', `${cli} begin ${id} --agent ${agent}`));
    sections.pull = q.pull.map((id) => entry('pull', id, `belongs to ${state.packets[id].agent}; announce on the bus before pulling`, `${cli} begin ${id} --agent ${agent} --pull`));
    sections.stale = q.staleReclaimable.filter((id) => state.packets[id].by !== agent).map((id) => entry('stale', id, `lease of ${state.packets[id].by || '-'} expired`, `${cli} reclaim ${id} --agent ${agent}`));
    sections.blocked = plan.packets.filter((p) => state.packets[p.id].status === 'BLOCKED' && (state.packets[p.id].agent === agent || state.packets[p.id].contributors.includes(agent)))
      .map((p) => entry('blocked', p.id, `blocked: ${state.packets[p.id].blockedReason || 'no reason recorded'}`, `${cli} begin ${p.id} --agent ${agent}`));
  }
  if (can('auditor') || can('reviewer')) {
    const inReview = new Set(q.awaitingReview);
    sections.audit = q.audit.filter((id) => !inReview.has(id)).map((id) => entry('audit', id, `${state.packets[id].status} by ${state.packets[id].agent || '-'}; audit read-only, file findings`, `${cli} review ${id}`));
  }
  const queue = [...sections.awaitingReview, ...sections.rework, ...sections.ready, ...sections.stretch, ...sections.audit].map((e, i) => ({ rank: i + 1, ...e }));
  const exhausted = !sections.rework.length && !sections.ready.length && !sections.stretch.length;
  const isOrch = agent === config.orchestrator;
  const notice = exhausted
    ? `HORIZON EXHAUSTED: no ready build work for ${agent}. ${sections.audit.length || sections.awaitingReview.length ? 'Audit mode: review the targets above (read-only, file findings). ' : ''}${isOrch ? `Add packets: ${cli} split "<goal>" or ${cli} plan add.` : `Ask ${config.orchestrator} for more packets: ${cli} bus post --from ${agent} --type REQUEST --text "need work".`}`
    : null;

  if (args.json) {
    ctx.json({ agent, next: queue[0] ?? null, queue, sections, horizonExhausted: exhausted, notice });
    return 0;
  }
  const paint = makePainter(ctx.env);
  const lines = [`next for ${agent}`];
  if (queue.length) {
    lines.push('', ...renderTable(queue, [
      { key: 'rank', label: '#', right: true },
      { get: (e) => e.kind.toUpperCase(), label: 'KIND', paint: (v) => ({ REVIEW: 'yellow', REWORK: 'red', READY: 'green', STRETCH: 'dim', AUDIT: 'cyan' })[v] },
      { key: 'packet', label: 'PACKET' },
      { key: 'priority', label: 'PRI' },
      { key: 'title', label: 'TITLE', max: 34 },
      { key: 'why', label: 'WHY', max: 52 },
    ], paint));
    lines.push('', `run: ${queue[0].command}`);
  }
  const extra = (label, list) => { if (list.length) lines.push('', `${label}:`, ...list.map((e) => `  ${e.packet}  ${e.title}  (${e.why})  ${e.command}`)); };
  extra('Your blocked packets', sections.blocked);
  extra('Stale leases you can reclaim', sections.stale);
  if (exhausted) extra('Could be pulled from others', sections.pull);
  if (notice) lines.push('', paint('bold', notice));
  ctx.out(lines.join('\n'));
  return 0;
}
