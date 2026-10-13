import { UsageError } from '../lib/errors.js';
import { reclaim } from '../lib/engine.js';

export const name = 'reclaim';
export const group = 'Execution';
export const summary = 'Take over an in-progress packet whose lease expired';
export const usage = 'baton reclaim <packet> --agent <id> [--json]';
export const options = {
  agent: { type: 'string', alias: 'a', description: 'acting agent id (or BATON_AGENT)' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

export async function run(ctx, args) {
  const pid = args._[0];
  if (!pid) throw new UsageError(`missing packet id. Usage: ${usage}`);
  const agent = ctx.agent(args.agent);
  const r = reclaim(ctx.root, pid, agent);
  if (args.json) ctx.json({ packet: pid, agent, leaseUntil: r.leaseUntil });
  else ctx.out(`${agent} reclaimed ${pid}; lease until ${r.leaseUntil}`);
  return 0;
}
