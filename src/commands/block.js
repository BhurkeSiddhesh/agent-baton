import { UsageError } from '../lib/errors.js';
import { block } from '../lib/engine.js';

export const name = 'block';
export const group = 'Execution';
export const summary = 'Mark a packet BLOCKED with a reason and a question';
export const usage = 'baton block <packet> --agent <id> --reason "..." [--question "..."] [--json]';
export const options = {
  agent: { type: 'string', alias: 'a', description: 'acting agent id (or BATON_AGENT)' },
  reason: { type: 'string', description: 'why the packet cannot proceed (required)' },
  question: { type: 'string', description: 'the specific question that unblocks it' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

export async function run(ctx, args) {
  const pid = args._[0];
  if (!pid) throw new UsageError(`missing packet id. Usage: ${usage}`);
  const by = ctx.agent(args.agent);
  block(ctx.root, pid, { by, reason: args.reason, question: args.question || '' });
  if (args.json) ctx.json({ packet: pid, by, status: 'BLOCKED', reason: args.reason, question: args.question || '' });
  else ctx.out(`${pid} is BLOCKED: ${args.reason}\nA BLOCKER message was posted. Take a stretch packet or run "baton next --agent ${by}".`);
  return 0;
}
