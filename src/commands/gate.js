import { UsageError } from '../lib/errors.js';
import { setGate, DONE } from '../lib/engine.js';
import { makePainter, renderTable } from '../lib/views.js';

export const name = 'gate';
export const group = 'Planning';
export const summary = 'List, open or close human gates';
export const usage = 'baton gate <list|open|close> [id] --by <actor> [--note "..."] [--json]';
export const description = 'Gates are human decisions that block packets until opened. Only the gate owner or "human" may open or close one.';
export const examples = ['baton gate list', 'baton gate open G1 --by human --note "key provisioned"'];
export const options = {
  by: { type: 'string', description: 'who opens or closes the gate (the owner, or human)' },
  note: { type: 'string', description: 'reason recorded with the decision' },
  json: { type: 'boolean' },
};

function rows(plan, state) {
  return plan.gates.map((g) => {
    const s = state.gates[g.id];
    const pending = (mode) => plan.packets.filter((p) => p.gate === g.id && (p.gate_mode === 'live_only') === (mode === 'live') && !DONE.has(state.packets[p.id].status)).map((p) => p.id);
    return { id: g.id, title: g.title ?? '', owner: g.owner ?? 'human', open: !!s?.open, by: s?.by ?? null, ts: s?.ts ?? null, note: s?.note ?? '', neededBy: g.needed_by ?? null, blocks: pending('start'), liveOnly: pending('live') };
  });
}

export async function run(ctx, args) {
  const [sub = 'list', id] = args._;
  if (!['list', 'open', 'close'].includes(sub)) throw new UsageError(`unknown gate subcommand "${sub}" (list|open|close)`);
  if (sub === 'list') {
    const { plan, state } = ctx.loadState();
    const r = rows(plan, state);
    if (args.json) ctx.json({ gates: r });
    else if (!r.length) ctx.out('no gates in the plan');
    else {
      const paint = makePainter(ctx.env);
      ctx.out(renderTable(r, [
        { key: 'id', label: 'GATE' },
        { get: (g) => (g.open ? 'open' : 'closed'), label: 'STATE', paint: (v) => (v === 'open' ? 'green' : 'red') },
        { key: 'owner', label: 'OWNER' },
        { key: 'title', label: 'TITLE', max: 44 },
        { get: (g) => [g.blocks.length ? `blocks ${g.blocks.join(',')}` : '', g.liveOnly.length ? `live-only ${g.liveOnly.join(',')}` : '', g.neededBy ? `needed by ${g.neededBy}` : ''].filter(Boolean).join('; '), label: 'EFFECT' },
      ], paint).join('\n'));
    }
    return 0;
  }
  if (!id) throw new UsageError(`gate ${sub} needs a gate id`);
  const by = ctx.agent(args.by, { required: true });
  const ev = setGate(ctx.root, id, sub === 'open', { by, note: args.note || '' });
  if (args.json) ctx.json({ gate: id, open: sub === 'open', by, event: ev.id });
  else ctx.out(`gate ${id} ${sub === 'open' ? 'opened' : 'closed'} by ${by}`);
  return 0;
}
