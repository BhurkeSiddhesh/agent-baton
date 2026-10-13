import { formatGlobalHelp, formatCommandHelp, findCommand } from '../cli.js';
import { UsageError } from '../lib/errors.js';

export const name = 'help';
export const summary = 'Show help for baton or one command';
export const usage = 'baton help [command]';
export const options = {};

export async function run(ctx, args) {
  const target = args._[0];
  if (!target) {
    ctx.out(formatGlobalHelp(ctx.commands));
    return 0;
  }
  const cmd = findCommand(ctx.commands, target);
  if (!cmd) throw new UsageError(`unknown command "${target}"`, { hint: 'run "baton help" for the list' });
  ctx.out(formatCommandHelp(cmd));
  return 0;
}
