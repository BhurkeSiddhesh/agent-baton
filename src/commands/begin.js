import { UsageError } from '../lib/errors.js';
import { begin } from '../lib/engine.js';

export const name = 'begin';
export const group = 'Execution';
export const summary = 'Start (or restart) a packet: lease, snapshot and claim';
export const usage = 'baton begin <packet> --agent <id> [--pull] [--expected-rev <rev>] [--op-id <id>] [--json]';
export const options = {
  agent: { type: 'string', alias: 'a', description: 'acting agent id (or BATON_AGENT)' },
  pull: { type: 'boolean', description: 'take a packet assigned to another agent (announced on the bus)' },
  'expected-rev': { type: 'number', description: 'CAS revision check: require exact packet stream revision' },
  'op-id': { type: 'string', description: 'idempotent operation id' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

export async function run(ctx, args) {
  const pid = args._[0];
  if (!pid) throw new UsageError(`missing packet id. Usage: ${usage}`);
  const agent = ctx.agent(args.agent);
  const expectedRev = args['expected-rev'] != null ? Number(args['expected-rev']) : null;
  const opId = args['op-id'] || null;
  const r = begin(ctx.root, pid, agent, { pull: args.pull, expectedRev, opId });
  if (args.json) {
    ctx.json({ packet: pid, agent, status: 'IN_PROGRESS', leaseUntil: r.leaseUntil, base: r.base, owns: r.owns, rework: r.rework, pulledEarly: r.pulledEarly, confirmed: true });
    return 0;
  }
  ctx.out(`${agent} started ${pid}${r.rework ? ' (rework)' : ''}${r.pulledEarly ? ' (pulled early)' : ''}`);
  ctx.out(`  lease until ${r.leaseUntil}`);
  ctx.out(`  owns: ${r.owns.join(', ')}`);
  ctx.out(`Touch only those paths. When done: baton verify ${pid} && baton submit ${pid} --agent ${agent}`);
  return 0;
}
