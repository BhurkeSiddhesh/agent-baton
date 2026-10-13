import { progress } from '../lib/engine.js';
import { utcnow } from '../lib/util.js';
import { makePainter, releaseLines } from '../lib/views.js';

export const name = 'release';
export const group = 'Planning';
export const summary = 'Milestone progress, due dates and closed gates';
export const usage = 'baton release [--json]';
export const description = 'Accepted packets count as done; packets in review are shown separately; stretch packets are excluded.';
export const options = { json: { type: 'boolean' } };

export async function run(ctx, args) {
  const { plan, state } = ctx.loadState();
  const prog = progress(plan, state, { now: utcnow() });
  if (args.json) ctx.json(prog);
  else ctx.out(releaseLines(prog, makePainter(ctx.env)).join('\n'));
  return 0;
}
