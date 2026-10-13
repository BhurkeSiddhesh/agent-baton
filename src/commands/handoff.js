import { UsageError } from '../lib/errors.js';
import { handoff, load } from '../lib/engine.js';

export const name = 'handoff';
export const group = 'Execution';
export const summary = 'Hand a packet to another author (releases it when in progress)';
export const usage = 'baton handoff <packet> --to <agent> --by <agent> [--note "..."] [--json]';
export const options = {
  to: { type: 'string', description: 'new author id' },
  by: { type: 'string', description: 'current author/holder or the orchestrator (or BATON_AGENT)' },
  agent: { type: 'string', alias: 'a', description: 'alias of --by' },
  note: { type: 'string', description: 'context for the new author' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

export async function run(ctx, args) {
  const pid = args._[0];
  if (!pid) throw new UsageError(`missing packet id. Usage: ${usage}`);
  if (!args.to) throw new UsageError(`missing --to. Usage: ${usage}`);
  const by = ctx.agent(args.by || args.agent);
  const ev = handoff(ctx.root, pid, { to: args.to, by, note: args.note || '' });
  const status = load(ctx.root).state.packets[pid].status;
  const released = ev.to === 'BLOCKED';
  if (args.json) ctx.json({ packet: pid, by, to: args.to, status, released });
  else ctx.out(`${pid} handed to ${args.to} (status ${status}).${released ? ` ${args.to} must run "baton begin ${pid} --agent ${args.to}".` : ''}`);
  return 0;
}
