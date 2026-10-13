import { packageVersion, packageRoot } from '../lib/paths.js';

export const name = 'version';
export const summary = 'Print the baton version';
export const usage = 'baton version [--json]';
export const options = { json: { type: 'boolean', description: 'print a JSON document' } };

export async function run(ctx, args) {
  const version = packageVersion();
  if (args.json) ctx.json({ version, node: process.version, platform: process.platform, packageRoot: packageRoot().replace(/\\/g, '/') });
  else ctx.out(`baton ${version}`);
  return 0;
}
