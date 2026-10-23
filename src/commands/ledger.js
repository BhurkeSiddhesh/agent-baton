import path from 'node:path';
import { UsageError } from '../lib/errors.js';
import { importLedger, exportLedger, verifyLedger, reconcileLedger } from '../lib/store.js';
import { reconcileOperations } from '../lib/engine.js';

export const name = 'ledger';
export const group = 'Execution';
export const summary = 'Import, export and verify the event ledger';
export const usage = [
  'baton ledger verify [--json]                              check hashes and local/mirror agreement (exit 1 on unacknowledged errors)',
  'baton ledger import [--from <dir>] [--dry-run] [--json]    copy safe events from tracked mirror (or <dir>) into local store',
  'baton ledger export [--dry-run] [--json]                  copy valid local events into the tracked mirror (.baton/ledger/)',
  'baton ledger reconcile [--from <dir>] [--dry-run] [--json] reconcile diverged clone ledgers and incomplete operations',
].join('\n       ');
export const options = {
  from: { type: 'string', description: 'import/reconcile: directory of event files (default .baton/ledger)' },
  'dry-run': { type: 'boolean', description: 'simulate reconciliation without writing changes to disk' },
  json: { type: 'boolean', description: 'print a JSON document' },
};

export async function run(ctx, args) {
  const sub = args._[0];
  const dryRun = Boolean(args['dry-run']);
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
    const fromDir = args.from ? path.resolve(ctx.cwd, args.from) : undefined;
    const r = importLedger(ctx.root, fromDir, { dryRun });
    if (args.json) ctx.json(r);
    else {
      if (dryRun) ctx.out('DRY RUN: no changes written to disk');
      ctx.out(`imported ${r.imported.length} event(s), skipped ${r.skipped.length}${r.skipped.map((s) => `\n  skipped ${s.id}: ${s.reason}`).join('')}`);
    }
    return 0;
  }
  if (sub === 'export') {
    const r = exportLedger(ctx.root, { dryRun });
    if (args.json) ctx.json(r);
    else {
      if (dryRun) ctx.out('DRY RUN: no changes written to disk');
      ctx.out(`exported ${r.exported.length} event(s), skipped ${r.skipped.length}${r.skipped.map((s) => `\n  skipped ${s.id}: ${s.reason}`).join('')}`);
    }
    return 0;
  }
  if (sub === 'reconcile') {
    const fromDir = args.from ? path.resolve(ctx.cwd, args.from) : undefined;
    const ledgerRes = reconcileLedger(ctx.root, { fromDir, dryRun });
    const opRes = dryRun ? { reconciled: [], clearedMarkers: [], restoredMarkers: [] } : reconcileOperations(ctx.root);
    const ok = ledgerRes.ok;

    if (args.json) {
      ctx.json({
        ok,
        dryRun,
        ledger: ledgerRes,
        operations: opRes,
        reconciled: opRes.reconciled,
        clearedMarkers: opRes.clearedMarkers,
        restoredMarkers: opRes.restoredMarkers,
      });
    } else {
      if (dryRun) ctx.out('DRY RUN: no changes written to disk');
      if (ledgerRes.applied.length) {
        ctx.out(`RECONCILED: imported ${ledgerRes.applied.length} safe event(s) from ${ledgerRes.from}`);
      }
      for (const s of ledgerRes.skipped) {
        ctx.out(`SKIPPED [${s.type || 'corrupt'}] ${s.id}: ${s.reason}`);
      }
      for (const c of ledgerRes.conflicts) {
        ctx.out(`CONFLICT [${c.type}] ${c.id}: ${c.reason} (Action: ${c.action})`);
      }
      for (const msg of opRes.reconciled) ctx.out(`RECONCILED: ${msg}`);
      for (const pid of opRes.clearedMarkers) ctx.out(`CLEARED: orphaned uncommitted verify marker for ${pid}`);
      for (const pid of opRes.restoredMarkers) ctx.out(`RESTORED: verify marker for ${pid} from ledger`);

      if (!ledgerRes.applied.length && !ledgerRes.conflicts.length && !ledgerRes.skipped.length
          && !opRes.reconciled.length && !opRes.clearedMarkers.length && !opRes.restoredMarkers.length) {
        ctx.out('ledger and operations are consistent; no reconciliation needed');
      }
    }
    return ok ? 0 : 1;
  }
  throw new UsageError(`usage:\n       ${usage}`);
}
