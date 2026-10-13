import { UsageError } from '../lib/errors.js';
import { reassignReviewer } from '../lib/engine.js';

export const name = 'reassign';
export const group = 'Execution';
export const summary = 'Change the reviewer of an undecided packet (orchestrator)';
export const usage = 'baton reassign <packet> --reviewer <id> --by <orchestrator> [--json]';
export const options = {
  reviewer: { type: 'string', description: 'new reviewer id' },
  by: { type: 'string', description: 'the orchestrator (or BATON_AGENT)' },
  agent: { type: 'string', alias: 'a', description: 'alias of --by' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

export async function run(ctx, args) {
  const pid = args._[0];
  if (!pid) throw new UsageError(`missing packet id. Usage: ${usage}`);
  if (!args.reviewer) throw new UsageError(`missing --reviewer. Usage: ${usage}`);
  const by = ctx.agent(args.by || args.agent);
  reassignReviewer(ctx.root, pid, args.reviewer, { by });
  if (args.json) ctx.json({ packet: pid, by, reviewer: args.reviewer });
  else ctx.out(`${pid} reviewer is now ${args.reviewer}`);
  return 0;
}
