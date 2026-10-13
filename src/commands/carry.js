import { UsageError } from '../lib/errors.js';
import { carry, postMessage } from '../lib/engine.js';

export const name = 'carry';
export const group = 'Execution';
export const summary = 'Carry a REJECTED packet over for another attempt (orchestrator)';
export const usage = 'baton carry <packet> --by <orchestrator> [--note "..."] [--json]';
export const options = {
  by: { type: 'string', description: 'the orchestrator (or BATON_AGENT)' },
  agent: { type: 'string', alias: 'a', description: 'alias of --by' },
  note: { type: 'string', description: 'why / what changes' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

export async function run(ctx, args) {
  const pid = args._[0];
  if (!pid) throw new UsageError(`missing packet id. Usage: ${usage}`);
  const by = ctx.agent(args.by || args.agent);
  carry(ctx.root, pid, { by, note: args.note || '' });
  postMessage(ctx.root, { from: by, to: 'all', type: 'NOTICE', packet: pid, text: `${pid} carried over.${args.note ? ` ${args.note}` : ''}` });
  if (args.json) ctx.json({ packet: pid, by, status: 'CARRIED_OVER' });
  else ctx.out(`${pid} -> CARRIED_OVER`);
  return 0;
}
