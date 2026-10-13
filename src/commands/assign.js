import { BatonError, UsageError } from '../lib/errors.js';
import { hasRole } from '../lib/config.js';
import { DONE } from '../lib/engine.js';
import { mutatePlan } from './plan.js';

export const name = 'assign';
export const group = 'Planning';
export const summary = 'Fill missing authors and reviewers deterministically';
export const usage = 'baton assign [--dry-run] [--only-unassigned] [--by <orchestrator>]';
export const description = [
  'For every packet that has not started: picks an author (track owner, strength overlap with the packet text, lowest load)',
  'and a reviewer (reviewer role, never the author or a contributor, fewest reviews so far, rotating).',
  'By default conflicts (reviewer equals author, missing role) are repaired too; --only-unassigned only fills blanks.',
].join('\n');
export const options = {
  'dry-run': { type: 'boolean', description: 'show the assignments without writing' },
  'only-unassigned': { type: 'boolean', description: 'fill blanks only; never change an existing value' },
  by: { type: 'string', description: 'acting agent (orchestrator or human)' },
  json: { type: 'boolean' },
};

const STARTABLE = new Set(['PLANNED', 'CARRIED_OVER', 'REJECTED', 'BLOCKED']);
const tokens = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1));

function overlap(agent, words) {
  let n = 0;
  for (const s of agent.strengths || []) {
    const parts = tokens(s);
    if (parts.size && [...parts].every((t) => words.has(t))) n += 2;
    else for (const t of parts) if (words.has(t)) n += 1;
  }
  return n;
}

/** Pure assignment pass over a plan draft. Mutates `draft` and returns the change list. */
export function assignPlan(draft, { config, state }, { onlyUnassigned = false } = {}) {
  const roster = config.agents;
  const idx = Object.fromEntries(roster.map((a, i) => [a.id, i]));
  const workers = roster.filter((a) => a.roles.includes('worker'));
  const reviewers = roster.filter((a) => a.roles.includes('reviewer'));
  const authorLoad = Object.fromEntries(roster.map((a) => [a.id, 0]));
  const reviewLoad = Object.fromEntries(roster.map((a) => [a.id, 0]));
  const live = draft.packets.filter((p) => !DONE.has(state.packets[p.id]?.status));
  for (const p of live) {
    if (p.agent in authorLoad) authorLoad[p.agent] += 1;
    if (p.reviewer in reviewLoad) reviewLoad[p.reviewer] += 1;
  }
  const trackOwner = (p) => draft.tracks.find((t) => t.id === p.track)?.owner ?? null;
  const changes = [];
  const warnings = [];
  for (const p of draft.packets) {
    const s = state.packets[p.id];
    if (!s || !STARTABLE.has(s.status)) continue;
    const words = tokens([p.title, p.description, p.id, p.track, draft.tracks.find((t) => t.id === p.track)?.theme, ...p.owns].join(' '));
    const change = { packet: p.id, agent: null, reviewer: null, why: [] };
    const fixAuthor = !p.agent || (!onlyUnassigned && !workers.some((a) => a.id === p.agent) && p.agent in idx);
    if (fixAuthor) {
      const owner = trackOwner(p);
      const rank = workers.map((a) => ({ a, ov: overlap(a, words), own: a.id === owner ? 1 : 0, load: authorLoad[a.id] }))
        .sort((x, y) => (y.own * 50 + y.ov * 10 - y.load * 2) - (x.own * 50 + x.ov * 10 - x.load * 2) || idx[x.a.id] - idx[y.a.id]);
      const pick = rank[0];
      if (!pick) warnings.push(`${p.id}: no agent with the worker role`);
      else {
        if (p.agent in authorLoad) authorLoad[p.agent] -= 1;
        change.agent = { from: p.agent, to: pick.a.id };
        change.why.push(pick.own ? `track owner of ${p.track}` : pick.ov ? `strengths match (${pick.ov})` : 'lowest load');
        p.agent = pick.a.id;
        authorLoad[p.agent] += 1;
      }
    }
    const conflicted = p.reviewer && !onlyUnassigned && (p.reviewer === p.agent || !reviewers.some((a) => a.id === p.reviewer) && p.reviewer in idx || s.contributors.includes(p.reviewer));
    if (!p.reviewer || conflicted) {
      const cands = reviewers.filter((a) => a.id !== p.agent && !s.contributors.includes(a.id));
      const rank = cands.map((a) => ({ a, ov: overlap(a, words), rl: reviewLoad[a.id] - (a.id === p.reviewer ? 1 : 0), al: authorLoad[a.id] }))
        .sort((x, y) => x.rl - y.rl || y.ov - x.ov || x.al - y.al || idx[x.a.id] - idx[y.a.id]);
      const pick = rank[0];
      if (!pick) warnings.push(`${p.id}: no eligible reviewer (needs the reviewer role and must differ from ${p.agent || 'the author'})`);
      else {
        if (p.reviewer in reviewLoad) reviewLoad[p.reviewer] -= 1;
        change.reviewer = { from: p.reviewer, to: pick.a.id };
        change.why.push(conflicted ? 'repaired reviewer conflict' : `review load ${pick.rl}`);
        p.reviewer = pick.a.id;
        reviewLoad[p.reviewer] += 1;
      }
    }
    if (change.agent || change.reviewer) changes.push(change);
  }
  return { changes, warnings };
}

export async function run(ctx, args) {
  if (args._.length) throw new UsageError('assign takes no positional arguments');
  const cfg = ctx.loadConfig();
  if (!cfg.agents.some((a) => hasRole(cfg, a.id, 'worker'))) throw new BatonError('the roster has no agent with the worker role', { code: 'NO_WORKERS' });
  const { result, written } = mutatePlan(ctx, args, (draft, loaded) => { const result = assignPlan(draft, loaded, { onlyUnassigned: args['only-unassigned'] }); return { result, skip: !result.changes.length }; },
    { note: 'assign', dryRun: args['dry-run'] });
  const { changes, warnings } = result;
  if (args.json) ctx.json({ dryRun: !!args['dry-run'], written: written && changes.length > 0, changes, warnings });
  else {
    const show = (c) => (c ? `${c.from ?? '-'} -> ${c.to}` : 'unchanged');
    if (!changes.length) ctx.out('nothing to assign');
    for (const c of changes) ctx.out(`${c.packet.padEnd(8)} agent ${show(c.agent).padEnd(24)} reviewer ${show(c.reviewer).padEnd(24)} (${c.why.join('; ')})`);
    for (const w of warnings) ctx.out(`warning: ${w}`);
    ctx.out(args['dry-run'] ? `dry run: ${changes.length} packet(s) would change; nothing written` : `${changes.length} packet(s) updated`);
  }
  return 0;
}
