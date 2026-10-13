import { UsageError } from '../lib/errors.js';
import { verdict } from '../lib/engine.js';

export const name = 'reject';
export const group = 'Execution';
export const summary = 'Reject a reviewed packet (needs a note or at least one finding)';
export const usage = 'baton reject <packet> --by <reviewer> --note "..." [--score 0-10] [--json]';
export const options = {
  by: { type: 'string', description: 'the assigned reviewer (or BATON_AGENT)' },
  agent: { type: 'string', alias: 'a', description: 'alias of --by' },
  note: { type: 'string', description: 'why it is rejected' },
  score: { type: 'number', description: 'quality score 0-10' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

export async function run(ctx, args) {
  const pid = args._[0];
  if (!pid) throw new UsageError(`missing packet id. Usage: ${usage}`);
  const by = ctx.agent(args.by || args.agent);
  const score = args.score === undefined ? null : args.score;
  verdict(ctx.root, pid, 'REJECTED', { by, note: args.note || '', score });
  if (args.json) ctx.json({ packet: pid, by, status: 'REJECTED', note: args.note || '', score });
  else ctx.out(`${pid} -> REJECTED by ${by}`);
  return 0;
}
