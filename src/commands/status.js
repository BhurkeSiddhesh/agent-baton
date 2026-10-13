import { utcnow } from '../lib/util.js';
import { makePainter, statusLines, statusModel } from '../lib/views.js';

export const name = 'status';
export const group = 'Planning';
export const summary = 'Every packet with status, owner, reviewer, flags and open findings';
export const usage = 'baton status [--track <id>] [--agent <id>] [--json]';
export const examples = ['baton status', 'baton status --agent codex --json'];
export const options = {
  track: { type: 'string', description: 'only this track' },
  agent: { type: 'string', alias: 'a', description: 'only packets this agent authors, reviews or holds' },
  json: { type: 'boolean' },
};

export async function run(ctx, args) {
  const loaded = ctx.loadState();
  const model = statusModel(loaded, { track: args.track || null, agent: args.agent || null, now: utcnow() });
  if (args.json) ctx.json(model);
  else ctx.out(statusLines(model, makePainter(ctx.env)).join('\n'));
  return 0;
}
