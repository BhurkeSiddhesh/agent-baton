import { UsageError } from '../lib/errors.js';
import { submit, postMessage } from '../lib/engine.js';

export const name = 'submit';
export const group = 'Execution';
export const summary = 'Request review (needs a current passing verify)';
export const usage = 'baton submit <packet> --agent <id> [--note "..."] [--op-id <id>] [--json]';
export const options = {
  agent: { type: 'string', alias: 'a', description: 'acting agent id (or BATON_AGENT)' },
  note: { type: 'string', description: 'sign-off note for the reviewer' },
  'op-id': { type: 'string', description: 'idempotent operation id' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

export async function run(ctx, args) {
  const pid = args._[0];
  if (!pid) throw new UsageError(`missing packet id. Usage: ${usage}`);
  const by = ctx.agent(args.agent);
  const opId = args['op-id'] || null;
  const ev = submit(ctx.root, pid, { by, note: args.note || '', opId, env: ctx.env });
  // The engine posts the SIGNOFF; the claim is over now, so release it explicitly on the bus.
  const { plan } = ctx.loadState();
  const owns = plan.packets.find((p) => p.id === pid)?.owns || [];
  postMessage(ctx.root, { from: by, to: 'all', type: 'RELEASE', packet: pid, opId, text: `${pid} released for review. Owned: ${owns.join(', ')}` });
  if (args.json) ctx.json({ packet: pid, by, status: 'READY_FOR_REVIEW', commit: ev.data?.commit ?? null, tests: ev.data?.tests ?? '' });
  else ctx.out(`${pid} is READY_FOR_REVIEW (commit ${ev.data.commit || 'n/a'}). A sign-off and a release were posted.`);
  return 0;
}
