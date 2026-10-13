import { UsageError } from '../lib/errors.js';
import { heartbeat } from '../lib/engine.js';

export const name = 'heartbeat';
export const group = 'Execution';
export const summary = 'Extend the lease of your in-progress packet';
export const usage = 'baton heartbeat <packet> --agent <id> [--json]';
export const options = {
  agent: { type: 'string', alias: 'a', description: 'acting agent id (or BATON_AGENT)' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

export async function run(ctx, args) {
  const pid = args._[0];
  if (!pid) throw new UsageError(`missing packet id. Usage: ${usage}`);
  const agent = ctx.agent(args.agent);
  const leaseUntil = heartbeat(ctx.root, pid, agent);
  if (args.json) ctx.json({ packet: pid, agent, leaseUntil });
  else ctx.out(`${pid} lease extended until ${leaseUntil}`);
  return 0;
}
