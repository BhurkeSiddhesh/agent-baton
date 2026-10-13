import { runInstall, formatResult } from '../install/installer.js';
import { vendoredVersion } from '../install/vendor.js';
import { packageVersion } from '../lib/paths.js';

export const name = 'upgrade';
export const group = 'Setup';
export const summary = 'Refresh the vendored runtime, managed blocks and adapter files from this baton version';
export const usage = 'baton upgrade [--dry-run] [--force] [--json]';
export const description = 'Run it with the newer baton package (for example "npx agent-baton upgrade"). Files you edited are kept and a <file>.baton-new sidecar is written.';
export const options = {
  'dry-run': { type: 'boolean', description: 'print what would change; write nothing' },
  force: { type: 'boolean', description: 'overwrite generated files even if you edited them' },
  json: { type: 'boolean', description: 'print one JSON document' },
};

export async function run(ctx, args) {
  const before = vendoredVersion(ctx.root);
  const result = await runInstall(ctx, { mode: 'upgrade', force: args.force, dryRun: args.dryRun, yes: true });
  if (args.json) {
    const { config, ...rest } = result;
    ctx.json({ ...rest, vendoredBefore: before, project: config.project });
    return 0;
  }
  const now = packageVersion();
  ctx.out([
    `baton upgrade: vendored runtime ${before ?? 'none'} -> ${result.vendored ? now : 'not vendored'}`,
    formatResult(result),
  ].join('\n'));
  return 0;
}
