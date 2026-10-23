import { UsageError } from '../lib/errors.js';
import { verdict } from '../lib/engine.js';

export const name = 'fix';
export const group = 'Execution';
export const summary = 'Accept with fixes: the author must resolve the findings';
export const usage = 'baton fix <packet> --by <reviewer> [--note "..."] [--score 0-10] [--op-id <id>] [--json]';
export const options = {
  by: { type: 'string', description: 'the assigned reviewer (or BATON_AGENT)' },
  agent: { type: 'string', alias: 'a', description: 'alias of --by' },
  note: { type: 'string', description: 'what must be fixed' },
  score: { type: 'number', description: 'quality score 0-10' },
  'op-id': { type: 'string', description: 'idempotent operation id' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

export async function run(ctx, args) {
  const pid = args._[0];
  if (!pid) throw new UsageError(`missing packet id. Usage: ${usage}`);
  const by = ctx.agent(args.by || args.agent);
  const score = args.score === undefined ? null : args.score;
  const opId = args['op-id'] || null;
  verdict(ctx.root, pid, 'ACCEPTED_WITH_FIXES', { by, note: args.note || '', score, opId });
  if (args.json) ctx.json({ packet: pid, by, status: 'ACCEPTED_WITH_FIXES', note: args.note || '', score });
  else ctx.out(`${pid} -> ACCEPTED_WITH_FIXES by ${by}`);
  return 0;
}
