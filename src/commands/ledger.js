import path from 'node:path';
import { UsageError } from '../lib/errors.js';
import { importLedger, exportLedger, verifyLedger } from '../lib/store.js';

export const name = 'ledger';
export const group = 'Execution';
export const summary = 'Import, export and verify the event ledger';
export const usage = [
  'baton ledger verify [--json]            check hashes and local/mirror agreement (exit 1 on unacknowledged errors)',
  'baton ledger import [--from <dir>]      copy valid events from the tracked mirror (or <dir>) into the local store',
  'baton ledger export                     copy valid local events into the tracked mirror (.baton/ledger/)',
].join('\n       ');
export const options = {
  from: { type: 'string', description: 'import: directory of event files (default .baton/ledger)' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

export async function run(ctx, args) {
  const sub = args._[0];
  if (sub === 'verify') {
    const problems = verifyLedger(ctx.root);
    const failing = problems.filter((p) => p.severity === 'error' && !p.acked);
    if (args.json) ctx.json({ ok: failing.length === 0, problems });
    else if (!problems.length) ctx.out('ledger ok');
    else {
      for (const p of problems) ctx.out(`${p.severity.toUpperCase()}${p.acked ? ' (acknowledged)' : ''} ${p.id} [${p.where}]: ${p.problem}`);
      ctx.out(failing.length ? `${failing.length} unacknowledged error(s)` : 'no unacknowledged errors');
    }
    return failing.length ? 1 : 0;
  }
  if (sub === 'import') {
    const r = args.from ? importLedger(ctx.root, path.resolve(ctx.cwd, args.from)) : importLedger(ctx.root);
    if (args.json) ctx.json(r);
    else ctx.out(`imported ${r.imported.length} event(s), skipped ${r.skipped.length}${r.skipped.map((s) => `\n  skipped ${s.id}: ${s.reason}`).join('')}`);
    return 0;
  }
  if (sub === 'export') {
    const r = exportLedger(ctx.root);
    if (args.json) ctx.json(r);
    else ctx.out(`exported ${r.exported.length} event(s), skipped ${r.skipped.length}${r.skipped.map((s) => `\n  skipped ${s.id}: ${s.reason}`).join('')}`);
    return 0;
  }
  throw new UsageError(`usage:\n       ${usage}`);
}
