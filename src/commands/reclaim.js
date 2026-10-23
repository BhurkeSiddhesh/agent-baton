import path from 'node:path';
import { UsageError } from '../lib/errors.js';
import { reclaim } from '../lib/engine.js';

export const name = 'reclaim';
export const group = 'Execution';
export const summary = 'Take over an in-progress packet whose lease expired or process crashed';
export const usage = 'baton reclaim <packet> --agent <id> [--reassign <id>] [--crashed-pid <pid>] [--no-preserve] [--force] [--worktree-dir <dir>] [--op-id <id>] [--json]';
export const options = {
  agent: { type: 'string', alias: 'a', description: 'acting agent id (or BATON_AGENT)' },
  reassign: { type: 'string', description: 'reassign to a different agent during reclaim' },
  'crashed-pid': { type: 'number', description: 'PID of suspected crashed agent process to verify' },
  preserve: { type: 'boolean', default: true, description: 'preserve uncommitted work and create a rescue ref' },
  force: { type: 'boolean', description: 'force reclaim even if process status cannot be determined' },
  'worktree-dir': { type: 'string', description: 'explicit worktree directory to preserve' },
  'op-id': { type: 'string', description: 'idempotent operation id' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

export async function run(ctx, args) {
  const pid = args._[0];
  if (!pid) throw new UsageError(`missing packet id. Usage: ${usage}`);
  const agent = ctx.agent(args.agent);
  const opId = args['op-id'] || null;
  const reassign = args.reassign || null;
  const crashedPid = args['crashed-pid'] != null ? Number(args['crashed-pid']) : null;
  const force = Boolean(args.force);
  const preserve = args.preserve !== false;
  const worktreeDir = args['worktree-dir'] ? path.resolve(ctx.cwd, args['worktree-dir']) : null;

  const r = reclaim(ctx.root, pid, agent, {
    opId,
    reassign,
    crashedPid,
    force,
    preserve,
    worktreeDir,
    env: ctx.env,
  });

  const targetAgent = reassign || agent;
  if (args.json) {
    ctx.json({
      packet: pid,
      agent: targetAgent,
      leaseUntil: r.leaseUntil,
      leaseToken: r.leaseToken,
      recoveredFrom: r.recoveredFrom,
      rescueRef: r.rescueRef || null,
    });
  } else {
    const actMsg = reassign
      ? `${agent} reclaimed ${pid} from ${r.recoveredFrom} and reassigned to ${reassign}`
      : `${agent} reclaimed ${pid} from ${r.recoveredFrom}`;
    const rescueMsg = r.rescueRef ? ` (uncommitted work preserved at ${r.rescueRef})` : '';
    ctx.out(`${actMsg}; lease token ${r.leaseToken} until ${r.leaseUntil}${rescueMsg}. Fresh verification required before submit.`);
  }
  return 0;
}
